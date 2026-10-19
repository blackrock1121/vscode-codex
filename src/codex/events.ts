import { CTX_OPEN, CTX_CLOSE, TimelineItem, ToWebview, ResetCredits } from '../shared';

export const QUESTION_REPLY_PREFIX = '用户已回答刚才的问题，请根据以下答案继续原任务：\n';

/** 回答的公共前缀很长；截成 80 字会把不同答案误认成同一还原点。 */
export function checkpointTextKey(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return text.startsWith(QUESTION_REPLY_PREFIX) ? normalized : normalized.slice(0, 80);
}

export interface QuestionReply { question: string; isSecret?: boolean; answers: string[]; imageCount?: number }
/** 只接受插件实际提交的结构化回答，不把普通消息当作可还原的问题。 */
export function parseQuestionReply(text: string): QuestionReply[] | undefined {
  if (!text.startsWith(QUESTION_REPLY_PREFIX)) return;
  try {
    const value = JSON.parse(text.slice(QUESTION_REPLY_PREFIX.length));
    if (!Array.isArray(value) || !value.length || value.some(r => !r || typeof r.question !== 'string' || !r.question.trim() ||
        !Array.isArray(r.answers) || !r.answers.length || r.answers.some((a: unknown) => typeof a !== 'string' || !a.trim()))) return;
    return value.map(r => ({ question: r.question, isSecret: r.isSecret === true, answers: r.isSecret ? ['（已填写）'] : r.answers,
      ...(Number.isInteger(r.imageCount) && r.imageCount > 0 && r.imageCount <= 10 ? { imageCount: r.imageCount } : {}) }));
  } catch { return; }
}

/** 为缺失或重复的 ID 分配稳定编号，避免多道题的答案互相覆盖。 */
export function normalizeQuestions(value: any): any[] | undefined {
  if (!Array.isArray(value) || !value.length || value.some(q => !q || typeof q.question !== 'string' || !q.question.trim() ||
      (q.options != null && (!Array.isArray(q.options) || q.options.some((o: any) => !o || typeof o.label !== 'string' || !o.label.trim()))))) return;
  const ids = value.map(q => q.id);
  const usableIds = ids.every(id => typeof id === 'string' && id.trim()) && new Set(ids).size === ids.length;
  return value.map((q, index) => ({ ...q, id: usableIds ? q.id : String(index), options: q.options ?? [], multiSelect: false }));
}

/** 原生异步提问以 agentMessage 通知到达，不会产生 item/tool/call 请求。 */
export function asyncQuestions(item: any): { id: string; question: string; options: { label: string }[] }[] | undefined {
  if (item?.type !== 'agentMessage' || item.delivery !== 'async' || !Array.isArray(item.questions) || !item.questions.length) return;
  if (item.questions.some((q: any) => !q || typeof q.title !== 'string' || !q.title.trim() ||
      (q.options != null && (!Array.isArray(q.options) || q.options.some((option: unknown) => typeof option !== 'string' || !option.trim()))))) return;
  return item.questions.map((q: any, index: number) => ({
    id: String(index), question: q.title, options: (q.options ?? []).map((label: string) => ({ label })),
  }));
}

/** 原始答案交给模型；界面、搜索及编辑历史统一使用遮蔽后的文本。 */
function maskQuestionReply(text: string): string {
  if (!text.startsWith(QUESTION_REPLY_PREFIX)) return text;
  try {
    const replies = JSON.parse(text.slice(QUESTION_REPLY_PREFIX.length));
    if (!Array.isArray(replies)) return '已提交问题回答';
    return QUESTION_REPLY_PREFIX + JSON.stringify(replies.map(reply => reply?.isSecret
      ? { question: reply.question, isSecret: true, answers: ['（已填写）'] } : reply));
  } catch { return '已提交问题回答（内容无法解析）'; }
}

/** 协议边界的兼容映射；未识别的工具仍显示原始类型和结果。 */
export function toolView(item: any): { name: string; input: Record<string, unknown>; result: string; isError: boolean } {
  if(item.type==='imageGeneration')return {name:'imageGeneration',input:{...(item.savedPath?{savedPath:item.savedPath}:{})},result:JSON.stringify({result:item.result,status:item.status,failure:item.failure}),isError:!!item.failure||item.status==='failed'};
  if(item.type==='imageView')return {name:'imageView',input:{path:item.path},result:'已查看图片',isError:false};
  const name = ({ commandExecution: 'Bash', fileChange: 'Edit', webSearch: 'WebSearch', mcpToolCall: `mcp__${item.server}__${item.tool}` } as Record<string, string>)[item.type] ?? item.tool ?? item.type;
  const input = item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd }
    : item.type === 'fileChange' ? { changes: item.changes, file_path: item.changes?.[0]?.path }
    : item.arguments ?? { ...item, id: undefined, type: undefined };
  if (item.type === 'dynamicToolCall' && item.tool === 'AskUserQuestion' && item.success) {
    try {
      const output = item.contentItems?.find((x: any) => x.type === 'inputText')?.text;
      const answers = JSON.parse(output).answers;
      const pairs = (item.arguments?.questions ?? []).map((q: any, i: number) => {
        const value = answers[q.id || q.question || String(i)]?.answers ?? [];
        return `${JSON.stringify(q.header || q.question)} = ${JSON.stringify(q.isSecret ? '（已填写）' : value.join('、'))}`;
      });
      return { name, input, result: pairs.join('\n'), isError: false };
    } catch { /* 保留原始结果供排错 */ }
  }
  const result = item.aggregatedOutput ?? (item.changes ? item.changes.map((c: any) => `${c.path}\n${c.diff ?? ''}`).join('\n') : JSON.stringify(item.result ?? item.contentItems ?? item.error ?? item.status ?? ''));
  return { name, input, result, isError: item.status === 'failed' || item.status === 'declined' || !!item.error || item.success === false || item.result?.isError === true || (item.exitCode != null && item.exitCode !== 0) };
}
export function userView(content: any[]): Extract<TimelineItem, { type: 'user' }> {
  let text = maskQuestionReply(content.filter(x => x.type === 'text').map(x => x.text).join('\n'));
  let context: string | undefined;
  const start = text.indexOf(CTX_OPEN), end = text.indexOf(CTX_CLOSE);
  if (start >= 0 && end >= start) { context = text.slice(start + CTX_OPEN.length, end).trim(); text = (text.slice(0, start) + text.slice(end + CTX_CLOSE.length)).trim(); }
  const images = content.filter(x => x.type === 'image').map(x => x.url);
  return { type: 'user', text, context, images };
}
export function timeline(turns: any[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const turn of turns) for (const item of turn.items ?? []) {
    const questions = asyncQuestions(item);
    if (item.type === 'userMessage') out.push(userView(item.content ?? []));
    else if (questions) out.push({ type: 'tool', toolId: item.id, name: 'AskUserQuestion', input: { questions }, result: item.text || questions.map(q => q.question).join('\n') });
    else if (item.type === 'agentMessage' || item.type === 'plan') out.push({ type: 'assistant_text', text: item.text ?? '' });
    else if (item.type === 'reasoning') out.push({ type: 'thinking', text: [...(item.summary ?? []), ...(item.content ?? [])].join('\n') });
    else if (item.type === 'contextCompaction') out.push({ type: 'compaction', preTokens: 0, postTokens: 0 });
    else if (item.type !== 'hookPrompt') out.push({ type: 'tool', toolId: item.id, ...toolView(item) });
  }
  return out;
}
/** 只展示后端标记为可用、且尚未过期的重置卡；缺少明细与零张不同。 */
export function resetCreditsView(summary: any, nowSec = Date.now() / 1000): ResetCredits | null | undefined {
  if (summary == null) return summary;
  const count = Number(summary.availableCount);
  if (!Number.isSafeInteger(count) || count < 0) return null;
  if (!Array.isArray(summary.credits)) return { availableCount: count, cards: null };
  let expired = 0;
  const cards = summary.credits.flatMap((credit: any) => {
    if (!credit || credit.status !== 'available') return [];
    if (typeof credit.expiresAt === 'number' && Number.isFinite(credit.expiresAt) && credit.expiresAt <= nowSec) {
      expired++;
      return [];
    }
    const expiresAt = credit.expiresAt === null ? null :
      typeof credit.expiresAt === 'number' && Number.isFinite(credit.expiresAt) ? credit.expiresAt : undefined;
    const title = typeof credit.title === 'string' ? credit.title.trim().slice(0, 100) : '';
    return [{ ...(title ? { title } : {}), expiresAt }];
  });
  cards.sort((a: { expiresAt?: number | null }, b: { expiresAt?: number | null }) =>
    (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return { availableCount: Math.max(cards.length, count - expired), cards };
}

export function usageView(rate: any, resetSummary?: unknown): Extract<ToWebview, { kind: 'usage' }> {
  const windows = [rate?.primary, rate?.secondary].filter((window): window is { usedPercent: number; windowDurationMins: number; resetsAt?: number } =>
    typeof window?.usedPercent === 'number' && typeof window?.windowDurationMins === 'number');
  const session = windows.find(window => window.windowDurationMins === 300);
  const week = windows.find(window => window.windowDurationMins === 10080);
  return { kind: 'usage', sessionPct: session?.usedPercent, sessionResetAt: session?.resetsAt, weekPct: week?.usedPercent, weekResetAt: week?.resetsAt,
    planType: typeof rate?.planType === 'string' ? rate.planType : undefined,
    ...(resetSummary !== undefined ? { resetCredits: resetCreditsView(resetSummary) } : {}) };
}

export function quotaEvents(rate: any, resetSummary?: unknown): ToWebview[] {
  const events: ToWebview[] = [usageView(rate, resetSummary)];
  let exhausted = false;
  for (const window of [rate?.primary, rate?.secondary]) {
    if (!window || typeof window.usedPercent !== 'number') continue;
    if (window.usedPercent >= 100) exhausted = true;
    const label = window.windowDurationMins === 300 ? '5 小时额度' : window.windowDurationMins === 10080 ? '每周额度' : '订阅额度';
    // 周额度百分比已经在用量弹层可见；接近上限时不再重复弹横幅。
    // 真正耗尽仍需提示和阻断，短周期额度的预警保持原行为。
    if (window.usedPercent >= 100 || (window.usedPercent >= 80 && window.windowDurationMins !== 10080))
      events.push({ kind: 'rate_limit', level: window.usedPercent >= 100 ? 'exhausted' : 'warning', limitLabel: label, resetsAt: window.resetsAt ?? undefined });
  }
  if (!exhausted && (rate?.primary || rate?.secondary)) events.unshift({ kind: 'rate_limit_cleared' });
  return events;
}
