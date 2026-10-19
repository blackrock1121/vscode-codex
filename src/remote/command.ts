/** 所有时间为 Unix 毫秒；标识来自设备绑定及插件注册，不能来自当前焦点。 */
export interface Target { windowId: string; workspaceId: string; sessionId: string }
export type Operation =
  | { kind: 'workspace.list' }
  | { kind: 'workspace.folders'; path: string; offset?: number }
  | { kind: 'workspace.open'; path: string }
  | { kind: 'session.list' }
  | { kind: 'command.status'; commandId: string }
  | { kind: 'session.rename'; title: string }
  | { kind: 'session.pin'; pinned: boolean }
  | { kind: 'session.delete'; confirmed: true }
  | { kind: 'session.compact' }
  | { kind: 'message.read'; item: number; revision: string; offset?: number }
  | { kind: 'message.edit'; item: number; revision: string; text: string }
  | { kind: 'message.regenerate'; item: number; revision: string }
  | { kind: 'message.enqueue'; text: string; attachmentIds: string[] }
  | { kind: 'queue.remove'; id: string }
  | { kind: 'queue.resume' }
  | { kind: 'session.image'; item: number; revision: string; index: number; offset: number }
  | { kind: 'session.controls'; section: 'settings' | 'request' | 'changes' | 'tool' | 'queue'; page?: number; item?: number; end?: number; revision?: string }
  | { kind: 'session.configure'; key: 'model' | 'effort' | 'speed'; value: string }
  | { kind: 'session.snapshot'; end?: number; revision?: string }
  | { kind: 'session.create'; text: string; attachmentIds?: string[] }
  | { kind: 'message.send'; text: string; attachmentIds: string[] }
  | { kind: 'turn.stop'; turnId: string }
  | { kind: 'question.answer'; turnId: string; requestId: string; requestVersion: number; answers: Record<string, string | string[]> }
  | { kind: 'permission.resolve'; turnId: string; requestId: string; requestVersion: number; decision: 'allow' | 'deny' };
export interface Command {
  version: 1; commandId: string; deviceId: string; issuedAt: number; expiresAt: number;
  target: Target | null; operation: Operation;
}
export class ProtocolError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
function fail(): never { throw new ProtocolError('INVALID_COMMAND'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(k => !Object.hasOwn(value, k))) fail();
}
function id(value: unknown): void { if (typeof value !== 'string' || !idPattern.test(value)) fail(); }
function text(value: unknown, max: number): void { if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail(); }
function integer(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) fail(); }

/** 严格字段白名单，运行时验证不可由 TypeScript 类型替代。 */
export function parseCommand(input: unknown, now: number): Command {
  const c = object(input);
  keys(c, ['version', 'commandId', 'deviceId', 'issuedAt', 'expiresAt', 'target', 'operation']);
  if (c.version !== 1) fail();
  id(c.commandId); id(c.deviceId); integer(c.issuedAt); integer(c.expiresAt);
  const start = c.issuedAt as number, end = c.expiresAt as number;
  if (end <= start || end - start > 120_000 || start > now + 30_000 || end <= now) throw new ProtocolError('COMMAND_EXPIRED');
  const op = object(c.operation);
  if (op.kind === 'workspace.list') {
    keys(op, ['kind']); if (c.target !== null) fail();
  } else if (op.kind === 'workspace.folders' || op.kind === 'workspace.open') {
    keys(op, ['kind', 'path', ...(op.kind === 'workspace.folders' && 'offset' in op ? ['offset'] : [])]);
    if (c.target !== null) fail();
    text(op.path, 1024);
    if (/[\x00-\x1f\x7f]/.test(op.path as string) || ((op.path !== '' || op.kind === 'workspace.open') && !(op.path as string).startsWith('/'))) fail();
    if ('offset' in op) integer(op.offset);
  } else {
    const t = object(c.target); keys(t, ['windowId', 'workspaceId', 'sessionId']);
    id(t.windowId); id(t.workspaceId);
    if (op.kind === 'session.create' || op.kind === 'session.list') { if (t.sessionId !== '') fail(); } else id(t.sessionId);
    switch (op.kind) {
      case 'command.status': keys(op, ['kind', 'commandId']); id(op.commandId); break;
      case 'session.list': case 'session.compact': case 'queue.resume': keys(op, ['kind']); break;
      case 'session.rename': keys(op,['kind','title']);text(op.title,80);if(!(op.title as string).trim())fail();break;
      case 'session.pin': keys(op,['kind','pinned']);if(typeof op.pinned!=='boolean')fail();break;
      case 'session.delete': keys(op,['kind','confirmed']);if(op.confirmed!==true)fail();break;
      case 'queue.remove': keys(op,['kind','id']);id(op.id);break;
      case 'message.read': case 'message.edit': case 'message.regenerate': case 'session.image':
        keys(op,['kind','item','revision',...(op.kind==='message.edit'?['text']:op.kind==='session.image'?['index','offset']:op.kind==='message.read'&&'offset' in op?['offset']:[])]);
        integer(op.item);id(op.revision);
        if('offset' in op)integer(op.offset);if('index' in op)integer(op.index);
        if(op.kind==='message.edit'){text(op.text,6000);if(!(op.text as string).trim())fail();}break;
      case 'session.controls':
        keys(op,['kind','section',...['page','item','end','revision'].filter(k=>k in op)]);
        if(!['settings','request','changes','tool','queue'].includes(op.section as string))fail();
        if('page' in op){integer(op.page);if((op.page as number)>10000)fail();}
        if(op.section==='tool'){integer(op.item);if('end' in op){integer(op.end);if(!('revision' in op))fail();}if('revision' in op)id(op.revision);}
        else if(['item','end','revision'].some(k=>k in op))fail();break;
      case 'session.configure':
        keys(op,['kind','key','value']);if(!['model','effort','speed'].includes(op.key as string))fail();text(op.value,120);break;
      case 'session.snapshot':
        keys(op, ['kind', ...('end' in op ? ['end'] : []), ...('revision' in op ? ['revision'] : [])]);
        if ('end' in op) { integer(op.end); if (!('revision' in op)) fail(); }
        if ('revision' in op) id(op.revision);
        break;
      case 'session.create':
        keys(op, ['kind', 'text', ...('attachmentIds' in op ? ['attachmentIds'] : [])]);text(op.text,6000);
        if('attachmentIds' in op){if(!Array.isArray(op.attachmentIds)||op.attachmentIds.length>4)fail();op.attachmentIds.forEach(id);}
        if(!(op.text as string).trim()&&!(op.attachmentIds as unknown[]|undefined)?.length)fail();break;
      case 'message.enqueue':
      case 'message.send':
        keys(op, ['kind', 'text', 'attachmentIds']); text(op.text, 6000);
        if (!Array.isArray(op.attachmentIds) || op.attachmentIds.length > 8) fail();
        op.attachmentIds.forEach(id);
        if (!(op.text as string).trim() && !op.attachmentIds.length) fail();
        break;
      case 'turn.stop': keys(op, ['kind', 'turnId']); id(op.turnId); break;
      case 'question.answer': {
        keys(op, ['kind', 'turnId', 'requestId', 'requestVersion', 'answers']);
        id(op.turnId); id(op.requestId); integer(op.requestVersion);
        const answers = object(op.answers);
        if (Object.keys(answers).length > 20 || JSON.stringify(answers).length > 6000) fail();
        for (const [key, value] of Object.entries(answers)) {
          id(key);
          if (Array.isArray(value)) { if (value.length > 20) fail(); value.forEach(v => text(v, 2000)); }
          else text(value, 2000);
        }
        break;
      }
      case 'permission.resolve':
        keys(op, ['kind', 'turnId', 'requestId', 'requestVersion', 'decision']);
        id(op.turnId); id(op.requestId); integer(op.requestVersion);
        if (op.decision !== 'allow' && op.decision !== 'deny') fail();
        break;
      default: fail();
    }
  }
  return c as unknown as Command;
}

export function isReadOperation(operation: Operation): boolean {
  return ['command.status', 'workspace.list', 'workspace.folders', 'session.list', 'session.snapshot', 'session.controls', 'message.read', 'session.image'].includes(operation.kind);
}
