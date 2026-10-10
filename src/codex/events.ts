import { CTX_OPEN, CTX_CLOSE, TimelineItem, ToWebview } from '../shared';

export const QUESTION_REPLY_PREFIX = '用户已回答刚才的问题，请根据以下答案继续原任务：\n';

/** 原生异步提问以 agentMessage 通知到达，不会产生 item/tool/call 请求。 */
export function asyncQuestions(item: any): { id: string; question: string; options: { label: string }[] }[] | undefined {
  if (item?.type !== 'agentMessage' || item.delivery !== 'async' || !Array.isArray(item.questions) || !item.questions.length) return;
  if (item.questions.some((q: any) => !q || typeof q.title !== 'string' || !q.title.trim() ||
      (q.options != null && (!Array.isArray(q.options) || q.options.some((option: unknown) => typeof option !== 'string'))))) return;
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
  return { name, input, result, isError: item.status === 'failed' || item.status === 'declined' || !!item.error || (item.exitCode != null && item.exitCode !== 0) };
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
export function usageView(rate: any): Extract<ToWebview, { kind: 'usage' }> {
  const windows = [rate?.primary, rate?.secondary].filter((window): window is { usedPercent: number; windowDurationMins: number; resetsAt?: number } =>
    typeof window?.usedPercent === 'number' && typeof window?.windowDurationMins === 'number');
  const session = windows.find(window => window.windowDurationMins === 300);
  const week = windows.find(window => window.windowDurationMins === 10080);
  return { kind: 'usage', sessionPct: session?.usedPercent, sessionResetAt: session?.resetsAt, weekPct: week?.usedPercent, weekResetAt: week?.resetsAt };
}

export function quotaEvents(rate: any): ToWebview[] {
  const events: ToWebview[] = [usageView(rate)];
  let exhausted = false;
  for (const window of [rate?.primary, rate?.secondary]) {
    if (!window || typeof window.usedPercent !== 'number') continue;
    if (window.usedPercent >= 100) exhausted = true;
    const label = window.windowDurationMins === 300 ? '5 小时额度' : window.windowDurationMins === 10080 ? '每周额度' : '订阅额度';
    if (window.usedPercent >= 80) events.push({ kind: 'rate_limit', level: window.usedPercent >= 100 ? 'exhausted' : 'warning', limitLabel: label, resetsAt: window.resetsAt ?? undefined });
  }
  if (!exhausted && (rate?.primary || rate?.secondary)) events.unshift({ kind: 'rate_limit_cleared' });
  return events;
}
