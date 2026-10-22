const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CodexProcess } = require('../dist/test/codex/process.js');
const { timeline } = require('../dist/test/codex/events.js');

function fixture(t) {
  const events = [], calls = [];
  const p = new CodexProcess({ codexPath: '/unused', cwd: process.cwd(), permissionMode: 'default', transportDiagnostics: false }, {
    emit: e => events.push(e), onPermission() {}, onSessionId() {}, onClose() {},
  });
  p.sessionId = 'thread'; p.busy = true;
  p.rpc.request = (method, params) => { calls.push({ method, params }); return new Promise(() => {}); };
  t.after(() => p.dispose());
  return { p, events, calls, complete: () => p.notification({ method: 'turn/completed', params: {
    threadId: 'thread', turn: { id: 'turn', status: 'interrupted' },
  } }) };
}

test('turn/started 已到但发送回执丢失时立即中断；完成通知可结束仍等待 RPC 的停止调用', async t => {
  const f = fixture(t);
  f.p.startingTurn = new Promise(() => {});
  f.p.notification({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
  const stopped = f.p.interrupt();
  assert.deepEqual(f.calls, [{ method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } }]);
  f.complete();
  await stopped;
  assert.equal(f.p.isBusy, false);
  assert.equal(f.events.filter(e => e.kind === 'result').length, 1);
});

test('启动与中断均无响应时十秒关闭连接并结束停止调用，迟到回执不再中断其他轮次', async t => {
  const f = fixture(t);
  let release;
  f.p.startingTurn = new Promise(resolve => { release = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stopped = f.p.interrupt();
  t.mock.timers.tick(10000);
  await stopped;
  assert.equal(f.p.isExited, true);
  assert.equal(f.p.isBusy, false);
  assert.equal(f.events.filter(e => e.kind === 'result').length, 1);
  release(); await Promise.resolve();
  assert.equal(f.calls.length, 0);
});

test('历史用户消息保留轮次 ID，恢复时区分重复正文', () => {
  const items = timeline(['a', 'b'].map(id => ({ id, items: [{ type: 'userMessage', content: [{ type: 'text', text: '继续' }] }] })));
  assert.deepEqual(items.map(item => item.turnId), ['a', 'b']);
});
