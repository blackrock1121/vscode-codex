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
    const ctx = f.session(String(i), { lastUsedAt: Date.now() - 100 + i }); ctx.proc.isBusy = true; f.provider.detached.set(ctx.sessionId, ctx);
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

test('收尾标记在成功和失败后释放，旧收尾不能清掉新收尾', async () => {
  const f = fixture(), ctx = f.session('finalize');
  let done;
  const first = new Promise(resolve => { done = resolve; });
  f.provider.trackFinalization(ctx, first);
  assert.equal(f.provider.canReleaseContext(ctx), false);
  done(); await first;
  assert.equal(ctx.finalizing, undefined);
  assert.equal(f.provider.canReleaseContext(ctx), true);
  let oldDone, newDone;
  const old = new Promise(resolve => { oldDone = resolve; });
  const latest = new Promise(resolve => { newDone = resolve; });
  f.provider.trackFinalization(ctx, old); f.provider.trackFinalization(ctx, latest);
  oldDone(); await old; assert.equal(ctx.finalizing, latest);
  newDone(); await latest; assert.equal(ctx.finalizing, undefined);
  const failed = Promise.reject(new Error('snapshot failed'));
  f.provider.trackFinalization(ctx, failed);
  await assert.rejects(failed, /snapshot failed/);
  assert.equal(ctx.finalizing, undefined);
});

test('真实 result 收尾完成后后台进程可回收，定时用量广播不推迟休眠', async () => {
  const f = fixture(), old = Date.now() - 301_000;
  const ctx = f.session('finished', { lastUsedAt: old, lastEmitAt: old });
  ctx.checkpoints.finishWorkspaceActivity = () => {};
  f.provider.notificationVersion = () => 0;
  f.provider.handleEmitInner = () => {};
  f.provider.detached.set('finished', ctx);
  f.provider.handleEmit(ctx, { kind: 'result', isError: false });
  assert.ok(ctx.finalizing);
  await ctx.finalizing;
  assert.equal(ctx.finalizing, undefined);
  f.provider.trimBackground(); assert.deepEqual(f.disposed, ['finished']);

  delete f.provider.handleEmitInner;
  f.provider.maybeNotifyUsage = () => {};
  f.provider.post = () => {};
  f.provider.handleEmitInner(ctx, { kind: 'usage' });
  f.provider.handleEmitInner(ctx, { kind: 'models', models: [] });
  assert.equal(ctx.lastEmitAt, old);
  f.provider.handleEmitInner(ctx, { kind: 'text_delta', text: '真实输出' });
  assert.ok(ctx.lastEmitAt > old);
});

test('不足五个的关闭会话也在空闲五分钟后回收，任务与待回答状态不受影响', () => {
  const f = fixture(), old = Date.now() - 301_000;
  const ctx = f.session('idle', { lastUsedAt: old, lastEmitAt: old });
  f.provider.detached.set('idle', ctx);
  for (const [id, props] of Object.entries({ running: { proc: { isBusy: true } }, sending: { sending: true },
      question: { pendingPerm: {} }, snapshot: { finalizing: Promise.resolve() }, compact: { compactionPreparing: true } })) {
    f.provider.detached.set(id, f.session(id, { lastUsedAt: old, lastEmitAt: old, ...props }));
  }
  f.provider.trimBackground();
  assert.deepEqual(f.disposed, ['idle']); assert.deepEqual(f.flushed, ['idle']);
  assert.equal(f.provider.detached.size, 5);
});

test('隐藏空闲页面必须等前端确认才释放，显示后重建，迟到确认不能关闭可见页面', () => {
  const f = fixture(), old = Date.now() - 301_000;
  const ctx = f.session('hidden', { hiddenSince: old, lastEmitAt: old,
    panel: { visible: false, webview: { html: '原页面' } } });
  f.provider.sessions.add(ctx);
  f.provider.checkIdlePanel(ctx);
  const request = f.sent.at(-1); assert.equal(request.kind, 'prepare_suspend');
  assert.equal(ctx.panel.webview.html, '原页面'); assert.deepEqual(f.disposed, []);
  f.provider.suspendPanel(ctx, request.requestId - 1); assert.equal(ctx.suspended, undefined);
  ctx.proc.isBusy = true;
  f.provider.suspendPanel(ctx, request.requestId); assert.equal(ctx.suspended, undefined);
  ctx.proc.isBusy = false;
  f.provider.suspendPanel(ctx, request.requestId);
  assert.equal(ctx.panel.webview.html, ''); assert.equal(ctx.suspended, true);
  assert.equal(ctx.ready, false); assert.deepEqual(f.disposed, ['hidden']);
  ctx.panel.visible = true; f.provider.checkIdlePanel(ctx);
  assert.equal(ctx.panel.webview.html, '重建的页面'); assert.equal(ctx.suspended, false);
  assert.equal(ctx.ready, false, '必须等新页面的 ready 才重新加载历史');
  f.provider.suspendPanel(ctx, request.requestId); assert.equal(ctx.panel.webview.html, '重建的页面');
});

test('隐藏页面的任务、发送、历史读取、待回答和手机队列都阻止休眠', () => {
  for (const props of [{ sending: true }, { starting: Promise.resolve() }, { historyPending: true },
      { pendingPerm: {} }, { finalizing: Promise.resolve() }, { snapshot: {} }, { settingsQueue: Promise.resolve() }]) {
    const f = fixture(), old = Date.now() - 301_000;
    const ctx = f.session('protected', { ...props, hiddenSince: old, lastEmitAt: old, panel: { visible: false } });
    f.provider.checkIdlePanel(ctx); assert.deepEqual(f.sent, []);
  }
  const f = fixture(); f.provider.remoteAdapter = { hasPending: () => true };
  assert.equal(f.provider.canReleaseContext(f.session('queue')), false);
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
