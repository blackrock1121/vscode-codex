const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { SessionStore } = require('../dist/test/codex/session.js');

function fixture(t) {
  const store = new SessionStore(process.cwd(), () => path.resolve('test/fake-codex.cjs'));
  t.after(() => store.dispose());
  return store;
}

test('多个标签页并行读取账号及完整模型目录，只各请求一次；成功后短期复用', async t => {
  const store = fixture(t), calls = [];
  store.read = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    return params.cursor ? { data: [{ model: 'second' }], nextCursor: null }
      : { data: [{ model: 'first' }], nextCursor: 'page2' };
  };
  const accounts = await Promise.all(Array.from({ length: 6 }, () => store.readAccountInfo()));
  const models = await Promise.all(Array.from({ length: 6 }, () => store.readModelCatalog()));
  assert.ok(accounts.every(a => a.account.type === 'chatgpt'));
  assert.ok(models.every(m => m.data.length === 2));
  assert.deepEqual(models[0].data.map(m => m.model), ['first', 'second']);
  await store.readAccountInfo(); await store.readModelCatalog();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { method: 'account/read', params: { refreshToken: false } });
});

test('账号切换立即废弃界面缓存，缓存过期后重新读取', async t => {
  const store = fixture(t), rpc = await store.connection();
  let generation = 0, calls = 0;
  store.read = async method => {
    calls++;
    return method === 'account/read' ? { account: { type: generation ? 'apiKey' : 'chatgpt' } }
      : { data: [{ model: 'model-' + generation }], nextCursor: null };
  };
  await store.readAccountInfo(); await store.readModelCatalog();
  generation++; rpc.emit('notification', { method: 'account/updated', params: { authMode: 'apikey' } });
  assert.equal((await store.readAccountInfo()).account.type, 'apiKey');
  assert.equal((await store.readModelCatalog()).data[0].model, 'model-1');
  assert.equal(calls, 4);
  store.metadata.get('account').expiresAt = Date.now() - 1;
  await store.readAccountInfo(); assert.equal(calls, 5);
});

test('切换账号时迟到的旧请求结果不返回给界面，也不能覆盖新缓存', async t => {
  const store = fixture(t), rpc = await store.connection();
  let release, calls = 0;
  store.read = async () => {
    if (++calls === 1) return new Promise(resolve => { release = resolve; });
    return { account: { type: 'apiKey' } };
  };
  const old = store.readAccountInfo();
  rpc.emit('notification', { method: 'account/updated', params: { authMode: 'apikey' } });
  const current = store.readAccountInfo();
  release({ account: { type: 'chatgpt' } });
  assert.equal((await old).account.type, 'apiKey'); assert.equal((await current).account.type, 'apiKey');
  assert.equal(calls, 2); assert.equal((await store.readAccountInfo()).account.type, 'apiKey');
});

test('失败读取可立即重试；重复分页游标不留下可用的错误模型目录', async t => {
  const store = fixture(t);
  let accountCalls = 0, modelCalls = 0;
  store.read = async method => {
    if (method === 'account/read') {
      if (++accountCalls === 1) throw new Error('临时读取失败');
      return { account: { type: 'chatgpt' } };
    }
    modelCalls++; return { data: [], nextCursor: 'same' };
  };
  await assert.rejects(store.readAccountInfo(), /临时读取失败/);
  assert.equal((await store.readAccountInfo()).account.type, 'chatgpt');
  await assert.rejects(store.readModelCatalog(), /分页游标重复/);
  await assert.rejects(store.readModelCatalog(), /分页游标重复/);
  assert.equal(accountCalls, 2); assert.equal(modelCalls, 4);
});

test('真实管理连接损坏后清除缓存，重连返回新请求结果', async t => {
  const store = fixture(t), first = await store.connection();
  await store.readAccountInfo(); const cached = await store.readModelCatalog();
  await assert.rejects(first.request('malformed'), /无效协议数据/);
  const [account, models] = await Promise.all([store.readAccountInfo(), store.readModelCatalog()]);
  assert.equal(account.account.type, 'chatgpt'); assert.notEqual(models, cached);
  assert.notEqual(await store.connection(), first);
});

test('管理器关闭后迟到的读取不能启动新进程，实时通用读取不套用界面缓存', async t => {
  const store = fixture(t); await store.connection();
  let release, calls = 0;
  store.read = async () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const pending = store.readAccountInfo(); store.dispose();
  release({ account: { type: 'chatgpt' } });
  await assert.rejects(pending, /管理连接已关闭/);
  await assert.rejects(store.readAccountInfo(), /管理连接已关闭/);
  assert.equal(calls, 1);
  const live = fixture(t), rpc = await live.connection();
  let rawCalls = 0; const request = rpc.request.bind(rpc);
  rpc.request = (...args) => { rawCalls++; return request(...args); };
  await live.read('account/read', {}); await live.read('account/read', {});
  assert.equal(rawCalls, 2);
});
