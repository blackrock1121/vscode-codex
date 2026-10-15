const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { CodexProcess } = require('../dist/test/codex/process.js');
const vscode = { workspace: { textDocuments: [], getWorkspaceFolder: () => ({}) } };
const originalLoad = Module._load;
Module._load = function (id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
const { ChatViewProvider } = require('../dist/test/panel/chatViewProvider.js');
Module._load = originalLoad;

async function until(check) {
  const end = Date.now() + 3000;
  while (!await check()) {
    if (Date.now() > end) throw new Error('等待测试事件超时');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function fixture(t, env = {}, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-startup-'));
  const log = path.join(dir, 'rpc.jsonl'), events = [], procs = [];
  const ctx = { blank: true, ready: true, checkpoints: { beginTurn: () => 'checkpoint', clear: () => {}, flush: () => {} } };
  const provider = Object.create(ChatViewProvider.prototype);
  const create = (extra, extraEnv = {}) => {
    const proc = new CodexProcess({ codexPath: path.resolve('test/fake-codex.cjs'), cwd: dir,
      permissionMode: 'default', transportDiagnostics: false, ...extra,
      env: { ...env, ...extraEnv, TEST_RPC_LOG: log } }, {
      emit: event => events.push(event), onPermission: () => {},
      onSessionId: id => { ctx.sessionId = id; ctx.blank = false; }, onClose: () => {},
    });
    procs.push(proc); return proc;
  };
  Object.assign(provider, {
    config: () => ({ get: (key, fallback) => options[key] ?? (['autosave', 'snapshotFilesForRestore'].includes(key) ? false : fallback) }),
    createProcess: () => create(), speedMode: () => 'default',
    output: { appendLine: () => {} }, post: (_, event) => events.push(event),
    store: { countLines: () => 0, notePending: () => {} }, renderSessions: () => {},
    clearSessionNotification: () => {}, activeCtx: ctx,
    context: { workspaceState: { get: () => undefined, update: async () => {} } },
    resetRestoredNotifications: () => {}, postModelConfig: () => {},
    storageDir: () => dir, refreshChangedFiles: () => {}, refreshSessions: () => {},
  });
  t.after(async () => {
    vscode.workspace.textDocuments = [];
    await Promise.all(procs.map(proc => proc.disposeAndWait()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const read = async () => {
    try { return (await fs.readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  return { provider, ctx, create, procs, events, read, dir };
}

test('提前连接只执行一次握手与目录读取；发送时使用最新设置且只创建一次会话', async t => {
  const f = await fixture(t), p = f.create();
  await Promise.all([p.prepare(), p.prepare()]);
  await until(async () => (await f.read()).some(m => m.method === 'model/list'));
  assert.equal(p.currentSessionId, undefined);
  assert.equal(p.sendUserMessage('尚未创建会话'), false);
  assert.equal((await f.read()).some(m => ['thread/start', 'account/read', 'turn/start'].includes(m.method)), false);
  await p.setModel('test-model'); await p.setEffort('low'); await p.setSpeedMode('fast');
  await Promise.all([p.start(), p.start()]);
  assert.equal(p.sendUserMessage('1'), true);
  await until(() => f.events.some(e => e.kind === 'result'));
  const calls = await f.read();
  for (const method of ['initialize', 'model/list', 'thread/start', 'turn/start'])
    assert.equal(calls.filter(m => m.method === method).length, 1, method);
  const thread = calls.find(m => m.method === 'thread/start');
  assert.equal(thread.params.model, 'test-model'); assert.equal(thread.params.serviceTier, 'priority');
  assert.equal(calls.find(m => m.method === 'turn/start').params.effort, 'low');
});

test('账号读取一直不返回时，会话和首轮仍可完成；返回后补充真实计费类型', async t => {
  const f = await fixture(t, { TEST_DEFER_ACCOUNT: '1', TEST_API_KEY: '1' }), p = f.create();
  const starting = p.start();
  await until(() => !!p.currentSessionId); await starting;
  assert.equal(p.sendUserMessage('1'), true);
  await until(() => f.events.some(e => e.kind === 'result'));
  assert.equal(f.events.some(e => e.kind === 'speed_context' && e.billing), false);
  const calls = await f.read();
  const account = calls.find(m => m.method === 'account/read');
  assert.deepEqual(account.params, { refreshToken: false });
  assert.ok(calls.indexOf(account) > calls.findIndex(m => m.method === 'thread/start'));
  await p.rpc.request('release-account');
  await until(() => f.events.some(e => e.kind === 'speed_context' && e.billing === 'api'));
});

test('后台账号读取失败不导致轮次失败，未登录的真实请求仍被 Codex 拒绝', async t => {
  for (const env of [{ TEST_FAIL_ACCOUNT: '1' }, { TEST_UNAUTH: '1' }]) {
    const f = await fixture(t, env), p = f.create();
    await p.start(); assert.equal(p.sendUserMessage('1'), true);
    await until(() => f.events.some(e => e.kind === 'result'));
    assert.equal(f.events.find(e => e.kind === 'result').isError, !!env.TEST_UNAUTH);
    if (env.TEST_UNAUTH) assert.match(f.events.find(e => e.kind === 'error').message, /Unauthorized/);
    else assert.equal(f.events.some(e => e.kind === 'error'), false);
  }
});

test('空白聊天提前连接不分配会话 ID；首次发送复用连接并完成会话创建', async t => {
  const f = await fixture(t);
  f.provider.maybePrespawn(f.ctx);
  const prepared = f.ctx.proc;
  assert.ok(prepared); await prepared.prepare();
  assert.equal(f.ctx.sessionId, undefined); assert.equal(f.ctx.blank, true);
  await f.provider.handleSend(f.ctx, '1');
  await until(() => f.events.some(e => e.kind === 'result'));
  assert.equal(f.ctx.proc, prepared); assert.equal(f.ctx.sessionId, 'thread-1');
  assert.equal((await f.read()).filter(m => m.method === 'initialize').length, 1);
  assert.ok(f.events.some(e => e.kind === 'status' && e.label.includes('创建 Codex 会话')));
});

test('关闭提前连接设置时不启动；主动发送仍可正常建立会话', async t => {
  const f = await fixture(t, {}, { prespawnOnOpen: false });
  f.provider.maybePrespawn(f.ctx);
  assert.equal(f.ctx.proc, undefined); assert.equal(f.procs.length, 0);
  await f.provider.handleSend(f.ctx, '1');
  await until(() => f.events.some(e => e.kind === 'result'));
  assert.equal(f.ctx.sessionId, 'thread-1');
});

test('首次发送后立即结束创建提示，首个输出前显示等待响应；续轮同样切换', async t => {
  const f = await fixture(t);
  await f.provider.handleSend(f.ctx, 'wait');
  const p = f.ctx.proc;
  await until(() => !!p.turnId);
  const labels = f.events.filter(e => e.kind === 'status').map(e => e.label);
  assert.ok(labels.includes('正在创建 Codex 会话…'));
  assert.equal(labels.at(-1), '等待 Codex 响应…');
  assert.equal(f.events.some(e => ['text_delta', 'thinking_delta', 'result'].includes(e.kind)), false);
  assert.equal(p.isBusy, true);
  await p.interrupt(); await until(() => !p.isBusy);
  f.events.length = 0;
  assert.equal(p.sendUserMessage('wait'), true);
  await until(() => !!p.turnId);
  assert.equal(f.events.filter(e => e.kind === 'status').at(-1).label, '等待 Codex 响应…');
});

test('快速模式目录校验期间不冒充已发送，校验完成后才切换到等待响应', async t => {
  const f = await fixture(t, { TEST_DEFER_MODELS: '1' }), p = f.create({ speedMode: 'fast' });
  await p.start();
  assert.equal(p.sendUserMessage('wait'), true);
  assert.equal(f.events.filter(e => e.kind === 'status').at(-1).label, '正在确认模型速度档位…');
  assert.equal((await f.read()).some(m => m.method === 'turn/start'), false);
  await p.rpc.request('release-models'); await until(() => !!p.turnId);
  assert.equal(f.events.filter(e => e.kind === 'status').at(-1).label, '等待 Codex 响应…');
});

test('目录校验期间停止后，迟到的目录不得补发等待响应状态或请求', async t => {
  const f = await fixture(t, { TEST_DEFER_MODELS: '1' }), p = f.create({ speedMode: 'fast' });
  await p.start(); p.sendUserMessage('wait'); await p.interrupt();
  const statuses = f.events.filter(e => e.kind === 'status');
  await p.rpc.request('release-models'); await until(() => f.events.some(e => e.kind === 'models'));
  assert.deepEqual(f.events.filter(e => e.kind === 'status'), statuses);
  assert.equal((await f.read()).some(m => m.method === 'turn/start'), false);
  assert.equal(p.isBusy, false);
});

test('发送提示早于输出，快速完成后的回执不会再补发等待提示', async t => {
  const f = await fixture(t), p = f.create();
  await p.start(); p.sendUserMessage('1');
  await until(() => f.events.some(e => e.kind === 'result'));
  await p.startingTurn;
  const waiting = f.events.findIndex(e => e.kind === 'status' && e.label === '等待 Codex 响应…');
  const firstOutput = f.events.findIndex(e => e.kind === 'text_delta');
  assert.ok(waiting >= 0 && waiting < firstOutput);
  assert.equal(f.events.slice(firstOutput).some(e => e.kind === 'status'), false);
  assert.equal(p.isBusy, false);
});

test('文件保存期间停止首轮，不创建会话、不发起生成；连接可用于下次发送', async t => {
  const f = await fixture(t, {}, { autosave: true });
  let release;
  vscode.workspace.textDocuments = [{ isDirty: true, isUntitled: false, uri: {},
    save: () => new Promise(resolve => { release = () => resolve(true); }) }];
  const sending = f.provider.handleSend(f.ctx, '1');
  await until(() => !!release); await f.ctx.proc.prepare();
  await f.provider.stopContext(f.ctx); release(); await sending;
  assert.equal(f.ctx.sessionId, undefined);
  assert.equal((await f.read()).some(m => ['thread/start', 'turn/start'].includes(m.method)), false);
  vscode.workspace.textDocuments = [];
  await f.provider.handleSend(f.ctx, '再次发送');
  await until(() => f.events.some(e => e.kind === 'result'));
  assert.equal(f.ctx.sessionId, 'thread-1');
});

test('会话创建期间停止首轮，受理后清理未发送会话和连接', async t => {
  const f = await fixture(t, { TEST_DEFER_THREAD: '1' });
  const sending = f.provider.handleSend(f.ctx, '1');
  await until(async () => (await f.read()).some(m => m.method === 'thread/start'));
  const p = f.ctx.proc;
  await f.provider.stopContext(f.ctx);
  const released = p.rpc.request('release-thread').catch(error => assert.match(error.message, /连接已关闭/));
  await Promise.all([sending, released]);
  assert.equal(f.ctx.sessionId, undefined); assert.equal(f.ctx.proc, undefined); assert.equal(f.ctx.blank, true);
  assert.equal((await f.read()).some(m => m.method === 'turn/start'), false);
  assert.equal(p.isExited, true);
});

test('提前连接失败后释放连接，发送时重新握手并成功建会话', async t => {
  const f = await fixture(t);
  const failedEnv = { TEST_BAD_INITIALIZE_ONCE: path.join(f.dir, 'failed-once') };
  f.provider.createProcess = () => f.create({}, failedEnv);
  f.provider.maybePrespawn(f.ctx);
  await until(() => f.ctx.proc === undefined);
  await f.provider.handleSend(f.ctx, '1');
  await until(() => f.events.some(e => e.kind === 'result'));
  assert.equal(f.procs.length, 2); assert.equal(f.procs[0].isExited, true);
  assert.equal(f.ctx.sessionId, 'thread-1');
});

test('关闭空白聊天释放提前连接，不进入后台会话列表', async t => {
  const f = await fixture(t);
  Object.assign(f.provider, { sessions: new Set([f.ctx]), detached: new Map(), broadcastRunning: () => {}, refreshSessions: () => {} });
  f.provider.maybePrespawn(f.ctx); const p = f.ctx.proc; await p.prepare();
  f.provider.onPanelClosed(f.ctx);
  assert.equal(p.isExited, true); assert.equal(f.ctx.proc, undefined);
  assert.equal(f.provider.detached.size, 0);
  assert.equal((await f.read()).some(m => m.method === 'thread/start'), false);
});

test('清空聊天立即重新准备连接，发送前不建会话并继续遵守提前连接开关', async t => {
  for (const enabled of [true, false]) {
    const f = await fixture(t, {}, { prespawnOnOpen: enabled });
    const old = f.create(); f.ctx.proc = old; await old.start();
    await f.provider.newContext(f.ctx, {});
    assert.equal(old.isExited, true); assert.equal(f.ctx.sessionId, undefined);
    assert.equal(f.ctx.blank, true);
    if (enabled) {
      assert.ok(f.ctx.proc); assert.notEqual(f.ctx.proc, old); await f.ctx.proc.prepare();
      assert.equal((await f.read()).filter(m => m.method === 'thread/start').length, 1);
    } else assert.equal(f.ctx.proc, undefined);
    await f.provider.handleSend(f.ctx, '清空后发送');
    await until(() => f.events.some(e => e.kind === 'result'));
    assert.equal((await f.read()).filter(m => m.method === 'thread/start').length, 2);
    assert.equal(f.ctx.sessionId, 'thread-1');
  }
});
