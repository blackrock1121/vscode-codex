const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? {} : originalLoad.call(this, id, ...args); };
const { ChatViewProvider } = require('../dist/test/panel/chatViewProvider.js');
Module._load = originalLoad;

function fixture() {
  const sent = [], disposed = [], flushed = [], checked = [];
  const provider = Object.create(ChatViewProvider.prototype);
  Object.assign(provider, {
    sessions: new Set(), detached: new Map(), restoring: new Set(), forking: new Set(),
    checkTurnStall: ctx => checked.push(ctx.sessionId), output: { appendLine() {} },
    post: (ctx, message) => sent.push({ id: ctx.sessionId, ...message }), html: () => '重建的页面',
  });
  const session = (id, props = {}) => ({
    sessionId: id, lastEmitAt: Date.now() - 61_000, lastUsedAt: Number(id), ready: true,
    panel: { visible: true, webview: { html: '原页面' } },
    checkpoints: { flush: () => flushed.push(id) },
    proc: { isBusy: false, dispose: () => disposed.push(id) }, ...props,
  });
  return { provider, session, sent, disposed, flushed, checked };
}

test('后台会话由运行转空闲后定期回收，按最近使用保留五个进程', () => {
  const f = fixture();
  for (let i = 1; i <= 8; i++) {
    const ctx = f.session(String(i)); ctx.proc.isBusy = true; f.provider.detached.set(ctx.sessionId, ctx);
  }
  f.provider.checkWatchdog(); assert.equal(f.disposed.length, 0);
  for (const ctx of f.provider.detached.values()) { ctx.proc.isBusy = false; ctx.lastEmitAt = Date.now(); }
  f.provider.checkWatchdog(); assert.equal(f.disposed.length, 0, '刚完成仍保留冷却时间');
  for (const ctx of f.provider.detached.values()) ctx.lastEmitAt -= 61_000;
  f.provider.checkWatchdog();
  assert.deepEqual(f.disposed, ['1', '2', '3']); assert.deepEqual(f.flushed, f.disposed);
  assert.deepEqual([...f.provider.detached.keys()], ['4', '5', '6', '7', '8']);
  f.provider.checkWatchdog(); assert.equal(f.disposed.length, 3);
});

test('后台清理保护快照收尾、恢复、派生、启动和等待用户的会话', () => {
  const f = fixture();
  const props = [{ starting: Promise.resolve() }, { snapshot: {} }, { finalizing: Promise.resolve() },
    { answeringQuestion: true }, { pendingPerm: {} }, {}, {}];
  props.forEach((item, i) => {
    const ctx = f.session(String(i), item); f.provider.detached.set(ctx.sessionId, ctx);
    if (i === 5) f.provider.restoring.add(ctx);
    if (i === 6) f.provider.forking.add(ctx);
  });
  f.provider.checkWatchdog(); assert.deepEqual(f.disposed, []);
});

test('隐藏面板不计丢失心跳，重新显示后继续检测；真正失联的可见面板会重建', () => {
  const f = fixture(), ctx = f.session('visible'); f.provider.sessions.add(ctx);
  f.provider.checkWatchdog(); assert.equal(ctx.missedPings, 1);
  ctx.panel.visible = false;
  for (let i = 0; i < 8; i++) f.provider.checkWatchdog();
  assert.equal(ctx.missedPings, 0); assert.equal(ctx.panel.webview.html, '原页面'); assert.equal(f.sent.length, 1);
  assert.equal(f.checked.length, 9, '隐藏时仍检查后端任务是否停滞');
  ctx.panel.visible = true;
  for (let i = 0; i < 3; i++) f.provider.checkWatchdog();
  assert.equal(ctx.panel.webview.html, '原页面');
  f.provider.checkWatchdog(); assert.equal(ctx.panel.webview.html, '重建的页面'); assert.equal(ctx.ready, false);
});
