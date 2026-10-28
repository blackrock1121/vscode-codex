const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { CodexProcess } = require('../dist/test/codex/process.js');

const model = id => ({ model: id, displayName: id, description: '',
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority' }] });

function fixture(t) {
  const events = [], calls = [];
  const proc = new CodexProcess({ codexPath: path.resolve('test/fake-codex.cjs'), cwd: process.cwd(),
    model: 'gpt-5.6-terra', effort: 'high', speedMode: 'default', permissionMode: 'default',
    compactionMode: 'session', compactionAutoValidate: false },
  { emit: event => events.push(event), onPermission() {}, onSessionId() {}, onClose() {} });
  proc.rpc.start = async () => {};
  proc.rpc.request = async (method, params) => {
    calls.push({ method, params });
    return { data: [model('gpt-5.6-terra')] };
  };
  t.after(() => proc.disposeAndWait());
  return { proc, events, calls };
}

test('目录过期后完整刷新分页，同时更新发送能力；并发打开菜单只读取一次', async t => {
  const { proc, events, calls } = fixture(t);
  await proc.prepare(); await proc.modelsReady;
  proc.modelsReadAt = Date.now() - 30_001;
  let release;
  proc.rpc.request = (method, params) => {
    calls.push({ method, params });
    return params.cursor ? Promise.resolve({ data: [model('gpt-6.1-terra')], nextCursor: null })
      : new Promise(resolve => { release = resolve; });
  };
  proc.busy = true; proc.turnId = 'running-turn';
  const refreshes = Array.from({ length: 5 }, () => proc.refreshModels());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  release({ data: [model('gpt-5.6-terra')], nextCursor: 'next' });
  await Promise.all(refreshes);
  assert.deepEqual(calls.map(call => call.method), ['model/list', 'model/list', 'model/list']);
  assert.deepEqual(proc.models.map(m => m.id), ['gpt-5.6-terra', 'gpt-6.1-terra']);
  assert.deepEqual(proc.models[1].speedModes, ['default', 'fast']);
  assert.deepEqual(events.findLast(e => e.kind === 'models').models, proc.models);
  assert.equal(proc.modelForNextTurn, 'gpt-5.6-terra');
  assert.equal(proc.opts.effort, 'high'); assert.equal(proc.opts.speedMode, 'default');
  assert.equal(proc.isBusy, true); assert.equal(proc.currentTurnId, 'running-turn');
  await proc.refreshModels(); assert.equal(calls.length, 3, '30 秒内复用成功目录');
});

test('刷新中途失败保留完整旧目录，重新打开菜单可立即重试', async t => {
  const { proc, events } = fixture(t);
  await proc.prepare(); await proc.modelsReady;
  const previous = proc.models;
  proc.modelsReadAt = Date.now() - 30_001;
  proc.rpc.request = async (_method, params) => {
    if (params.cursor) throw Error('模拟网络中断');
    return { data: [model('gpt-6.1-terra')], nextCursor: 'next' };
  };
  await proc.refreshModels();
  assert.equal(proc.models, previous);
  assert.ok(events.some(e => e.kind === 'notice' && e.message.includes('模拟网络中断')));
  proc.rpc.request = async () => ({ data: [model('gpt-6.1-terra')] });
  await proc.refreshModels();
  assert.equal(proc.models[0].id, 'gpt-6.1-terra');
});

test('初次加载尚未完成时打开菜单共享原请求，不创建会话或请求模型生成', async t => {
  const { proc, calls } = fixture(t);
  let release;
  proc.rpc.request = (method, params) => {
    calls.push({ method, params });
    return new Promise(resolve => { release = resolve; });
  };
  await proc.prepare();
  const refresh = proc.refreshModels();
  release({ data: [model('gpt-6.1-terra')] });
  await refresh;
  assert.deepEqual(calls.map(call => call.method), ['model/list']);
  assert.equal(proc.currentSessionId, undefined);
});
