const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? {} : originalLoad.call(this, id, ...args); };
const { ChatViewProvider } = require('../dist/test/panel/chatViewProvider.js');
Module._load = originalLoad;
const { toolView } = require('../dist/test/codex/events.js');

function fixture() {
  const provider = Object.create(ChatViewProvider.prototype), ctx = { sessionId: 'root', lastEventAt: Date.now() - 100000 }, sent = [];
  Object.assign(provider, { sessions: new Set([ctx]), output: { appendLine() {} },
    post: (_, message) => sent.push(message), maybeNotifyWaiting() {}, clearSessionNotification: async () => {} });
  return { provider, ctx, sent };
}
const approval = id => ({ requestId: id, toolName: 'Bash', input: { command: 'test' }, suggestions: [] });

test('并行审批依次展示，重复到达不覆盖其他请求，回答不清掉下一条', () => {
  const { provider, ctx, sent } = fixture();
  provider.onPermission(ctx, approval('a')); provider.onPermission(ctx, approval('b'));
  provider.onPermission(ctx, approval('b'));
  assert.deepEqual(sent.map(m => m.requestId), ['a']);
  assert.equal(ctx.pendingPerms.size, 2);
  ctx.proc = { respondPermission: id => {
    provider.handleEmitInner(ctx, { kind: 'permission_resolved', requestId: id, behavior: 'allow' });
    return true;
  } };
  provider.handlePermission(ctx, 'a', 'allow');
  assert.equal(ctx.pendingPerm.requestId, 'b');
  assert.equal(ctx.pendingPerms.size, 1);
  provider.handlePermission(ctx, 'b', 'allow');
  assert.equal(ctx.pendingPerm, undefined); assert.equal(ctx.pendingPerms.size, 0);
});

test('后台已解决的排队审批不再显示，恢复的根问题不被子问题覆盖', () => {
  const { provider, ctx, sent } = fixture();
  ctx.pendingPerm = { ...approval('root-question'), kind: 'permission_request', toolName: 'AskUserQuestion' };
  provider.onPermission(ctx, approval('child'));
  provider.handleEmitInner(ctx, { kind: 'permission_resolved', requestId: 'child', behavior: 'deny' });
  assert.equal(ctx.pendingPerm.requestId, 'root-question');
  provider.resolvePendingPermission(ctx, 'root-question');
  assert.equal(ctx.pendingPerm, undefined);
  assert.equal(sent.some(m => m.kind === 'permission_request'), false);
});

test('子问题答案直达原进程，不读取根历史、不建立新还原点、不启动根轮次', async () => {
  const { provider, ctx } = fixture(); const replies = [];
  ctx.proc = { isChildQuestion: id => id === 'child', answerChildQuestion: (...args) => { replies.push(args); return true; } };
  provider.waitSessionSettings = () => { throw new Error('不应等待根设置'); };
  provider.store = { hydrate: () => { throw new Error('不应读取根历史'); } };
  await provider.submitQuestionAnswer(ctx, 'child', { q: '选择一' });
  await provider.submitQuestionAnswer(ctx, 'child', { q: '先修正问题' }, undefined, undefined, { q: 'custom' });
  assert.deepEqual(replies, [
    ['child', { q: '选择一' }, undefined, undefined],
    ['child', { q: '先修正问题' }, undefined, { q: 'custom' }],
  ]);
});

test('真实工具活动更新静默时钟，诊断与重试提示不冒充进展', () => {
  const { provider, ctx, sent } = fixture(); const before = ctx.lastEventAt;
  provider.handleEmitInner(ctx, { kind: 'diag', message: '计时' });
  provider.handleEmitInner(ctx, { kind: 'status', label: '正在重试' });
  assert.equal(ctx.lastEventAt, before);
  ctx.responseWaitShown = true;
  provider.handleEmitInner(ctx, { kind: 'activity', label: '收到命令输出' });
  assert.ok(ctx.lastEventAt > before);
  assert.ok(sent.some(m => m.kind === 'response_wait' && m.idleMs === 0));
});

test('工具失败只使用结构化结果，普通输出中的 error/timeout 不误报', () => {
  assert.equal(toolView({ type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'clearTimeout; expected; errorCount = 0' }).isError, false);
  assert.equal(toolView({ type: 'dynamicToolCall', status: 'completed', success: false }).isError, true);
  assert.equal(toolView({ type: 'mcpToolCall', status: 'completed', result: { isError: true } }).isError, true);
  assert.equal(toolView({ type: 'commandExecution', status: 'completed', exitCode: 1 }).isError, true);
});
