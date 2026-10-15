const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = { workspace: { getConfiguration: () => ({ get: key => key === 'notifyWebhook' ? 'https://example.invalid/hook' : false }) } };
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
const { ChatViewProvider } = require('../dist/test/panel/chatViewProvider.js');
Module._load = originalLoad;
const { transcriptText, transcriptPage } = require('../dist/test/remote/transcript.js');
const { parseCommand } = require('../dist/test/remote/command.js');
const { CodexProcess } = require('../dist/test/codex/process.js');
const command = (operation, sid = 'session-b') => ({ version: 1, commandId: 'cmd', deviceId: 'phone', issuedAt: Date.now(), expiresAt: Date.now() + 60000,
  target: { windowId: 'window', workspaceId: 'project', sessionId: sid }, operation });

function fixture() {
  const provider = Object.create(ChatViewProvider.prototype), saved = new Map(), events = [], sends = [];
  const makeSession = id => ({ sessionId: id, blank: false, ready: true, checkpoints: { beginTurn: () => 'checkpoint', clear: () => {} },
    proc: { currentSessionId: id, currentTurnId: 'turn-1', isBusy: false, isExited: false,
      setModel: async () => {}, setEffort: async () => {}, setSpeedMode: async () => {},
      sendUserMessage(text) { sends.push([id, text]); this.isBusy = true; return true; },
      interrupt: async () => {},
    },
  });
  const a = makeSession('session-a'), b = makeSession('session-b');
  Object.assign(provider, {
    sessions: new Set([a, b]), detached: new Map(), activeCtx: a, forking: new Set(), restoring: new Set(),
    remoteRegistration: () => ({ windowId: 'window', workspaceId: 'project', label: '假项目' }),
    context: { workspaceState: { get: key => saved.get(key), update: async (key, value) => saved.set(key, value) } },
    store: { list: () => [{ id: a.sessionId, title: 'A' }, { id: b.sessionId, title: 'B' }], hydrate: async () => {},
      load: id => [{ type: 'user', text: id }], countLines: () => 0 },
    config: () => ({ get: (key, fallback) => ['autosave', 'snapshotFilesForRestore'].includes(key) ? false : fallback }),
    sessionModel: () => 'model-test', speedMode: () => 'default', sessionEffort: () => 'medium',
    output: { appendLine: () => {} }, post: (ctx, e) => events.push([ctx.sessionId, e]),
    clearSessionNotification: () => {}, notificationVersion: () => 0,
  });
  return { provider, a, b, saved, events, sends };
}

test('手机指定 B 时只调用 B 原进程，桌面焦点 A 不改变；同一发送路径显示用户消息', async () => {
  const f = fixture();
  const reply = await f.provider.executeRemote(command({ kind: 'message.send', text: '手机正文', attachmentIds: [] }), () => true);
  assert.equal(reply.accepted, true); assert.deepEqual(f.sends, [['session-b', '手机正文']]);
  assert.equal(f.provider.activeCtx, f.a);
  assert.ok(f.events.some(([id, e]) => id === 'session-b' && e.kind === 'remote_user' && e.text === '手机正文'));
  assert.equal(f.saved.get('codexChat.remotePrivate.session-b'), true);
  assert.equal((await f.provider.executeRemote(command({ kind: 'message.send', text: '重复点击', attachmentIds: [] }), () => true)).error, 'SESSION_BUSY');
});
test('查询只能读本窗口打开/后台会话，复用权威历史；不允许路径或任意 Webview 操作', async () => {
  const f = fixture();
  const list = await f.provider.executeRemote(command({ kind: 'session.list' }, ''), () => true);
  assert.equal(list.result.sessions.length, 2);
  const snap = await f.provider.executeRemote(command({ kind: 'session.snapshot' }), () => true);
  assert.match(snap.result.text, /session-b/); assert.doesNotMatch(snap.result.text, /session-a/);
  assert.equal((await f.provider.executeRemote(command({ kind: 'session.snapshot' }, 'closed'), () => true)).error, 'SESSION_NOT_OPEN');
  const wrong = command({ kind: 'session.snapshot' }); wrong.target.windowId = 'other';
  assert.equal((await f.provider.executeRemote(wrong, () => true)).error, 'TARGET_OFFLINE');
  assert.throws(() => parseCommand(command({ kind: 'runInTerminal', code: 'bad' }), Date.now()));
  assert.equal(f.sends.length, 0);
});
test('准备期间桌面和手机发送互斥，断线或目标变化后不能迟到执行', async () => {
  const f = fixture(); let finish;
  f.provider.store.hydrate = () => new Promise(resolve => { finish = resolve; });
  let active = true;
  const sending = f.provider.handleSend(f.b, '第一条', undefined, undefined, undefined, () => active);
  assert.equal(await f.provider.handleSend(f.b, '桌面竞争'), false);
  active = false; finish();
  assert.equal(await sending, false); assert.equal(f.sends.length, 0); assert.equal(f.b.sending, false);
});
test('停止绑定真实轮次；已换轮次不打断，回答和附件未实现时明确拒绝', async () => {
  const f = fixture(); f.b.proc.isBusy = true; const stopped = [];
  f.provider.stopContext = async ctx => { stopped.push(ctx.sessionId); ctx.proc.isBusy = false; };
  assert.equal((await f.provider.executeRemote(command({ kind: 'turn.stop', turnId: 'old' }), () => true)).error, 'TURN_CHANGED');
  assert.equal((await f.provider.executeRemote(command({ kind: 'turn.stop', turnId: 'turn-1' }), () => true)).accepted, true);
  assert.deepEqual(stopped, ['session-b']);
  assert.equal((await f.provider.executeRemote(command({ kind: 'message.send', text: '', attachmentIds: ['file'] }), () => true)).error, 'ATTACHMENTS_NOT_READY');
  assert.equal((await f.provider.executeRemote(command({ kind: 'permission.resolve', turnId: 'turn', requestId: 'req', requestVersion: 1, decision: 'allow' }), () => true)).error, 'OPERATION_NOT_READY');
});
test('尚未取得轮次 ID 或仅子任务运行时仍提供停止标识，跨新轮次失效', () => {
  const proc = Object.create(CodexProcess.prototype);
  Object.assign(proc, { busy: true, remoteInstance: 'process', dispatchSequence: 1, compactionSequence: 0 });
  const pending = proc.currentTurnId; assert.equal(pending, 'process-1-0');
  proc.dispatchSequence++; assert.notEqual(proc.currentTurnId, pending);
  proc.turnId = 'actual-turn'; assert.equal(proc.currentTurnId, 'actual-turn');
  proc.busy = false; assert.equal(proc.currentTurnId, undefined);
});
test('手机接管标记在重载后仍禁止任务 Webhook，其他会话保持原行为', async () => {
  const f = fixture(), delivered = [];
  f.provider.sendWebhook = async (...args) => { delivered.push(args); return { ok: true }; };
  f.saved.set('codexChat.remotePrivate.session-b', true);
  f.provider.dispatchNotification(f.b, '不应发送', {});
  f.provider.dispatchNotification(f.a, '普通会话通知', {});
  assert.equal(delivered.length, 1); assert.equal(delivered[0][1], '普通会话通知');
});
test('长中文/emoji/转义文本完整分页、无变化只返回版本，旧游标显式重置', () => {
  const text = ('中文🙂\\\"\n'.repeat(2000)), state = { kind: 'session.snapshot', busy: false };
  let page = transcriptPage(text, state, {}), assembled = page.text;
  while (page.start) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 6000);
    page = transcriptPage(text, state, { end: page.start, revision: page.revision }); assembled = page.text + assembled;
  }
  assert.equal(assembled, text);
  assert.equal(transcriptPage(text, state, { revision: page.revision }).unchanged, true);
  assert.equal(transcriptPage('changed', state, { end: 10, revision: page.revision }).reset, true);
  assert.doesNotMatch(transcriptText([{ type: 'image', src: 'data:secret' }, { type: 'user', text: '用户', images: ['data:secret'] }]), /data:secret/);
});
