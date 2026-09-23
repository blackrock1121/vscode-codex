import { CTX_OPEN, CTX_CLOSE, TimelineItem, ToWebview } from '../shared';

/** 协议边界的兼容映射；未识别的工具仍显示原始类型和结果。 */
export function toolView(item: any): { name: string; input: Record<string, unknown>; result: string; isError: boolean } {
  const name = ({ commandExecution: 'Bash', fileChange: 'Edit', webSearch: 'WebSearch', mcpToolCall: `mcp__${item.server}__${item.tool}` } as Record<string, string>)[item.type] ?? item.tool ?? item.type;
  const input = item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd }
    : item.type === 'fileChange' ? { changes: item.changes, file_path: item.changes?.[0]?.path }
    : item.arguments ?? { ...item, id: undefined, type: undefined };
  const result = item.aggregatedOutput ?? (item.changes ? item.changes.map((c: any) => `${c.path}\n${c.diff ?? ''}`).join('\n') : JSON.stringify(item.result ?? item.contentItems ?? item.error ?? item.status ?? ''));
  return { name, input, result, isError: item.status === 'failed' || item.status === 'declined' || !!item.error || (item.exitCode != null && item.exitCode !== 0) };
}
export function userView(content: any[]): Extract<TimelineItem, { type: 'user' }> {
  let text = content.filter(x => x.type === 'text').map(x => x.text).join('\n');
  let context: string | undefined;
  const start = text.indexOf(CTX_OPEN), end = text.indexOf(CTX_CLOSE);
  if (start >= 0 && end >= start) { context = text.slice(start + CTX_OPEN.length, end).trim(); text = (text.slice(0, start) + text.slice(end + CTX_CLOSE.length)).trim(); }
  const images = content.filter(x => x.type === 'image').map(x => x.url);
  return { type: 'user', text, context, images };
}
export function timeline(turns: any[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const turn of turns) for (const item of turn.items ?? []) {
    if (item.type === 'userMessage') out.push(userView(item.content ?? []));
    else if (item.type === 'agentMessage' || item.type === 'plan') out.push({ type: 'assistant_text', text: item.text ?? '' });
    else if (item.type === 'reasoning') out.push({ type: 'thinking', text: [...(item.summary ?? []), ...(item.content ?? [])].join('\n') });
    else if (item.type === 'contextCompaction') out.push({ type: 'compaction', preTokens: 0, postTokens: 0 });
    else if (item.type !== 'hookPrompt') out.push({ type: 'tool', toolId: item.id, ...toolView(item) });
  }
  return out;
}
export function usageView(rate: any): Extract<ToWebview, { kind: 'usage' }> {
  const date = (t: number | undefined) => t ? new Date(t * 1000).toLocaleString('zh-CN') : undefined;
  return { kind: 'usage', sessionPct: rate?.primary?.usedPercent, sessionResetAt: rate?.primary?.resetsAt, sessionReset: date(rate?.primary?.resetsAt), weekPct: rate?.secondary?.usedPercent, weekReset: date(rate?.secondary?.resetsAt) };
}

export function quotaEvents(rate: any): ToWebview[] {
  const events: ToWebview[] = [usageView(rate)];
  let exhausted = false;
  for (const [window, label] of [[rate?.primary, '短期额度'], [rate?.secondary, '长期额度']] as const) {
    if (!window || typeof window.usedPercent !== 'number') continue;
    if (window.usedPercent >= 100) exhausted = true;
    if (window.usedPercent >= 80) events.push({ kind: 'rate_limit', level: window.usedPercent >= 100 ? 'exhausted' : 'warning', limitLabel: label, resetsAt: window.resetsAt ?? undefined });
  }
  if (!exhausted && (rate?.primary || rate?.secondary)) events.unshift({ kind: 'rate_limit_cleared' });
  return events;
}
