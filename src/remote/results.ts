/** v1 返回值合同：已有字段语义不变；允许新增字段，未知事件可忽略。两仓库冻结样本验证兼容。 */
export interface RequestSummary {
  requestId: string; requestVersion: number; turnId: string | null; question: boolean; title: string;
}
export interface ChatMessage {
  id: string; role: string; text: string; imageCount?: number; actionable?: boolean; messageRevision?: string;
}
export interface SessionSnapshot {
  kind?: 'session.snapshot'; sessionId?: string; title?: string; busy?: boolean; waiting?: boolean;
  turnId?: string | null; text?: string; messages?: ChatMessage[]; revision?: string;
  start?: number; end?: number; total?: number; unchanged?: boolean; reset?: boolean;
  capabilities?: Record<string, boolean>; request?: RequestSummary | null;
  queueCount?: number; queuePaused?: boolean; queueReason?: string;
}
export interface ExecutionStatus { kind: 'command.status'; commandId: string; state: 'accepted' | 'rejected' | 'unknown'; sessionId?: string }
export interface PluginResults {
  'session.list': {sessions: {id: string; title: string; busy?: boolean; waiting?: boolean}[]; total?: number};
  'session.snapshot': SessionSnapshot;
  'session.controls': {section: 'settings' | 'request' | 'changes' | 'tool' | 'queue'; [key: string]: unknown};
  'message.accepted': {sessionId: string; title?: string; delivery?: 'handed_to_original_session'};
  'command.status': ExecutionStatus;
}
export type PluginEvent =
  | {kind: 'invalidate'}
  | {kind: 'delta'; id: string; seq: number; field: 'text' | 'thinking'; text: string}
  | {kind: 'completed'; deviceId: string; commandId: string; title?: string; error?: boolean};
export type PluginReply = {accepted: true; result: Record<string, unknown>} | {accepted: false; error: string};
export const RESULT_CONTRACT_VERSION = 1;
export const ERROR_SEMANTICS = Object.freeze({
  UNSUPPORTED_FEATURE: '当前操作未执行，基础聊天仍可使用',
  PLUGIN_TIMEOUT: '只读请求超时，可重新查询',
  PLUGIN_RESULT_UNKNOWN: '操作可能已执行，不得自动重发',
  INVALID_PLUGIN_RESULT: '响应不符合 v1 合同，只隔离本次请求',
  QUEUE_REQUIRES_RECONCILIATION: '待核对任务是否已执行，禁止自动重复派发',
});
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const integer = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
function check(ok: boolean): asserts ok { if (!ok) throw new Error('INVALID_PLUGIN_RESULT'); }
function fields(v: Record<string, unknown>, names: string[], predicate: (value: unknown) => boolean): void {
  for (const name of names) if (name in v) check(predicate(v[name]));
}
/** 边界处验证 JSON，扩展字段不影响旧消费者；兼容最早只有 text 的快照。 */
export function readPluginReply(value: unknown, operation: {kind: string; section?: string}): PluginReply {
  check(object(value) && (value.accepted === true || value.accepted === false));
  if (!value.accepted) { check(typeof value.error === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.error)); return value as PluginReply; }
  const r = value.result; check(object(r));
  if (operation.kind === 'session.snapshot') {
    check(typeof r.text === 'string' || Array.isArray(r.messages) || r.unchanged === true);
    fields(r, ['busy', 'waiting', 'unchanged', 'reset', 'queuePaused'], v => typeof v === 'boolean');
    fields(r, ['text', 'title', 'revision'], v => typeof v === 'string');
    fields(r, ['start', 'end', 'total', 'queueCount'], integer);
    if (r.messages !== undefined) {
      check(Array.isArray(r.messages));
      for (const m of r.messages) { check(object(m) && typeof m.text === 'string'); fields(m, ['id', 'role', 'messageRevision'], v => typeof v === 'string'); fields(m, ['imageCount'], integer); }
    }
    if (r.request != null) {
      check(object(r.request) && id(r.request.requestId) && integer(r.request.requestVersion) && (r.request.turnId === null || id(r.request.turnId)) && typeof r.request.question === 'boolean');
    }
    if (r.capabilities !== undefined) check(object(r.capabilities));
  } else if (operation.kind === 'session.list') {
    check(Array.isArray(r.sessions));
    for (const s of r.sessions) check(object(s) && id(s.id) && typeof s.title === 'string');
  } else if (operation.kind === 'session.controls') {
    check(r.section === operation.section);
    if (r.section === 'queue') check(Array.isArray(r.items) && integer(r.total) && integer(r.page) && typeof r.paused === 'boolean');
  } else if (operation.kind === 'session.image') {
    check(integer(r.offset) && integer(r.next) && integer(r.total) && typeof r.data === 'string' && typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256));
    check((r.offset as number) < (r.next as number) && (r.next as number) <= (r.total as number));
  } else if (operation.kind === 'command.status') {
    check(id(r.commandId) && ['accepted', 'rejected', 'unknown'].includes(r.state as string));
  }
  return value as PluginReply;
}
export function readPluginEvent(value: unknown): PluginEvent | undefined {
  if (!object(value)) return;
  if (value.kind === 'invalidate') return {kind: 'invalidate'};
  if (value.kind === 'delta' && id(value.id) && integer(value.seq) && ['text', 'thinking'].includes(value.field as string) && typeof value.text === 'string') return value as PluginEvent;
  if (value.kind === 'completed' && id(value.deviceId) && id(value.commandId) && (value.error === undefined || typeof value.error === 'boolean') && (value.title === undefined || typeof value.title === 'string')) return value as PluginEvent;
  return undefined;
}
