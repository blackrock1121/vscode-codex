const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (id, ...args) { return id === 'vscode' ? {} : originalLoad.call(this, id, ...args); };
const { ChatViewProvider } = require('../dist/test/panel/chatViewProvider.js');
Module._load = originalLoad;

function fixture(state = new Map()) {
  const provider = Object.create(ChatViewProvider.prototype), messages = [], applied = [];
  const settings = { model: 'model-a', effort: 'high', speedMode: 'default', autosave: false, snapshotFilesForRestore: false };
  const makeSession = sessionId => ({
    sessionId, blank: !sessionId, ready: true,
    checkpoints: { setSession: () => {}, flush: () => {}, clear: () => {}, beginTurn: () => 'checkpoint' },
    proc: {
      modelForNextTurn: 'model-a',
      async setModel(model) { this.modelForNextTurn = model; applied.push([sessionId, 'model', model]); },
      setEffort: async effort => applied.push([sessionId, 'effort', effort]),
      setSpeedMode: async speed => applied.push([sessionId, 'speed', speed]),
      setPermissionMode: async () => {}, dispose: () => {},
    },
  });
  const a = makeSession('a'), b = makeSession('b'), hidden = makeSession('hidden');
  const storage = path.join(os.tmpdir(), 'codex-model-' + randomUUID());
  Object.assign(provider, {
    modelSelectionQueue: Promise.resolve(), modeSeq: 0,
    modelCatalog: [
      { id: 'model-a', efforts: ['low', 'high'], speedModes: ['default', 'fast'], isDefault: true },
      { id: 'model-b', efforts: ['low', 'high'], speedModes: ['default', 'fast'] },
      { id: 'low-only', efforts: ['low'], speedModes: ['default'] },
    ],
    sessions: new Set([a, b]), detached: new Map([['hidden', hidden]]),
    context: { workspaceState: { get: key => state.get(key), update: async (key, value) => { state.set(key, value); } } },
    config: () => ({ get: (key, fallback) => settings[key] ?? fallback, inspect: key => ({ workspaceValue: settings[key] }) }),
    updateConfig: async (key, value) => { assert.notEqual(key, 'model', '会话选择不能写入公共模型配置'); settings[key] = value; return true; },
    post: (ctx, event) => messages.push({ ...event, target: ctx.sessionId }), output: { appendLine: () => {} },
    store: { findFile: () => undefined, hydrate: async () => {}, countLines: () => 0, notePending: () => {},
      readAccountInfo: async () => ({}), readModelCatalog: async () => ({ data: [] }) },
    cwd: () => storage, storageDir: () => storage, workspaceDirs: () => [],
    refreshSessions: () => {}, renderSessions: () => {}, renderSessionInto: () => {}, refreshChangedFiles: () => {},
    maybePrespawn: () => {}, postActiveFile: () => {}, fetchUsage: () => {},
    clearSessionNotification: () => {}, resetRestoredNotifications: () => {},
  });
  return { provider, a, b, hidden, settings, messages, applied, state, makeSession };
}

test('切换 B 模型仅更新 B，其他打开或后台会话及新会话默认值保持不变', async () => {
  const f = fixture();
  f.provider.sessionModel(f.a); f.provider.sessionModel(f.hidden);
  await f.provider.onPanelMessage(f.b, { type: 'setModel', model: 'model-b' });
  assert.deepEqual(f.applied, [['b', 'model', 'model-b']]);
  assert.equal(f.provider.sessionModel(f.a), 'model-a');
  assert.equal(f.provider.sessionModel(f.b), 'model-b');
  assert.equal(f.provider.sessionModel(f.hidden), 'model-a');
  assert.equal(f.provider.sessionModel({}), 'model-a');
  assert.equal(f.settings.model, 'model-a');
  assert.deepEqual([...f.state], [['codexChat.sessionModel.b', 'model-b']]);
  assert.ok(f.messages.length && f.messages.every(m => m.target === 'b'));
});

test('连续交错选择按会话保存，重建宿主后恢复各自模型，包括默认模型空字符串', async () => {
  const f = fixture();
  await Promise.all([
    f.provider.setModel(f.a, 'model-b'), f.provider.setModel(f.b, 'low-only'), f.provider.setModel(f.a, ''),
  ]);
  const restored = fixture(f.state); restored.settings.model = 'another-default';
  assert.equal(restored.provider.sessionModel(restored.a), '');
  assert.equal(restored.provider.sessionModel(restored.b), 'low-only');
  assert.equal(restored.provider.sessionModel({}), 'another-default');
  restored.settings.model = 'changed-again';
  assert.equal(restored.provider.sessionModel(restored.a), '');
  assert.equal(restored.provider.sessionModel(restored.b), 'low-only');
});

test('权限广播和面板重新 ready 都返回各自模型，不覆盖会话选择', async () => {
  const f = fixture(); await f.provider.setModel(f.b, 'model-b'); f.messages.length = 0;
  await f.provider.setPermissionMode(f.a, 'plan');
  assert.deepEqual(f.messages.filter(m => m.kind === 'config').map(m => [m.target, m.model]), [['a', 'model-a'], ['b', 'model-b']]);
  const restored = fixture(f.state);
  await restored.provider.onPanelMessage(restored.b, { type: 'ready' });
  assert.equal(restored.messages.find(m => m.kind === 'config').model, 'model-b');
});

test('两个空白会话独立选择，获得服务端 ID 后保存各自模型', async () => {
  const f = fixture(); delete f.a.sessionId; delete f.b.sessionId;
  await f.provider.setModel(f.a, 'model-b'); await f.provider.setModel(f.b, '');
  assert.equal(f.state.size, 0);
  f.provider.onSessionId(f.a, 'created-a', false); f.provider.onSessionId(f.b, 'created-b', false);
  assert.equal(f.state.get('codexChat.sessionModel.created-a'), 'model-b');
  assert.equal(f.state.get('codexChat.sessionModel.created-b'), '');
  assert.equal(f.provider.sessionModel({ sessionId: 'created-a' }), 'model-b');
  assert.equal(f.provider.sessionModel({ sessionId: 'created-b' }), '');
});

test('新上下文重新采用公共默认值，原会话保存的模型保持不变', async () => {
  const f = fixture(); await f.provider.setModel(f.a, 'model-b');
  await f.provider.newContext(f.a, {});
  assert.equal(f.a.sessionId, undefined); assert.equal(f.a.model, 'model-a');
  assert.equal(f.state.get('codexChat.sessionModel.a'), 'model-b');
  assert.equal(f.messages.findLast(m => m.kind === 'config').model, 'model-a');
});

test('加载最后会话时重新读取其模型，不沿用空白上下文的模型', () => {
  const f = fixture(); f.state.set('codexChat.lastSession', 'saved');
  f.state.set('codexChat.sessionModel.saved', 'model-b'); f.provider.store.findFile = id => id;
  const ctx = f.makeSession(undefined); ctx.blank = false; ctx.initialHistoryCached = true;
  f.provider.sessionModel(ctx); assert.equal(ctx.model, 'model-a');
  f.provider.loadCtxSession(ctx);
  assert.equal(ctx.sessionId, 'saved'); assert.equal(ctx.model, 'model-b');
});

test('旧会话初次加载保存初始模型，后续默认值变化不覆盖已保存的选择', () => {
  const f = fixture(); f.a.initialHistoryCached = true;
  f.provider.loadSessionInto(f.a, 'a');
  assert.equal(f.state.get('codexChat.sessionModel.a'), 'model-a');
  const restored = fixture(f.state); restored.settings.model = 'model-b';
  assert.equal(restored.provider.sessionModel(restored.a), 'model-a');
  assert.equal(restored.provider.sessionModel({}), 'model-b');
});

test('切换模型只重置本会话不兼容的推理档位，不改其他会话的模型、强度和速度', async () => {
  const f = fixture(); await f.provider.setSpeedMode(f.b, 'fast'); f.applied.length = 0; f.messages.length = 0;
  await f.provider.setModel(f.a, 'low-only');
  assert.deepEqual(f.applied, [['a', 'effort', ''], ['a', 'model', 'low-only']]);
  for (const ctx of [f.b, f.hidden]) {
    assert.equal(f.provider.sessionModel(ctx), 'model-a'); assert.equal(f.provider.sessionEffort(ctx), 'high');
  }
  assert.equal(f.provider.speedMode(f.b), 'fast');
  assert.ok(f.messages.every(m => m.target === 'a'));
});

test('推理强度和快速档位依据各自会话模型校验', async () => {
  const f = fixture(); await f.provider.setModel(f.a, 'low-only'); f.applied.length = 0;
  await f.provider.setEffort(f.a, 'high'); await f.provider.setSpeedMode(f.a, 'fast');
  assert.deepEqual(f.applied, []);
  assert.equal(f.provider.sessionEffort(f.a), ''); assert.equal(f.provider.speedMode(f.a), 'default');
  await f.provider.setEffort(f.b, 'high'); await f.provider.setSpeedMode(f.b, 'fast');
  assert.deepEqual(f.applied, [['b', 'effort', 'high'], ['b', 'speed', 'fast']]);
});

test('保存模型或兼容档位失败时保留原设置，错误和配置回执仅发送当前会话', async () => {
  for (const failedKey of ['codexChat.sessionModel.a', 'codexChat.sessionEffort.a']) {
    const f = fixture(); f.state.set('codexChat.sessionModel.a', 'model-a');
    const update = f.provider.context.workspaceState.update;
    f.provider.context.workspaceState.update = async (key, value) => {
      if (key === failedKey) throw Error('保存失败'); await update(key, value);
    };
    await f.provider.setModel(f.a, 'low-only');
    assert.deepEqual(f.applied, []); assert.equal(f.provider.sessionModel(f.a), 'model-a');
    assert.equal(f.state.get('codexChat.sessionModel.a'), 'model-a');
    assert.equal(f.provider.sessionEffort(f.a), 'high');
    assert.ok(f.messages.some(m => m.kind === 'error'));
    assert.ok(f.messages.every(m => m.target === 'a'));
    assert.equal(f.messages.at(-1).model, 'model-a');
  }
});

test('真实进程请求使用各自模型，运行中切换仅影响该会话下一轮，断线重建仍恢复选择', async t => {
  const f = fixture(), calls = [], procs = [];
  delete f.a.proc; delete f.b.proc; delete f.hidden.proc;
  f.provider.handleEmit = (ctx, event) => f.provider.post(ctx, event);
  const createProcess = f.provider.createProcess.bind(f.provider);
  f.provider.createProcess = ctx => {
    const proc = createProcess(ctx); procs.push(proc);
    proc.rpc.start = async () => {};
    proc.rpc.request = async (method, params) => {
      calls.push({ session: ctx.sessionId, method, params: structuredClone(params) });
      if (method === 'model/list') return { data: [] };
      if (method === 'account/read') return {};
      if (method === 'thread/resume') return { thread: { id: params.threadId }, model: params.model };
      if (method === 'turn/start') return { turn: { id: randomUUID() } };
      throw Error('意外请求：' + method);
    };
    return proc;
  };
  t.after(async () => { await Promise.all(procs.map(proc => proc.disposeAndWait())); });
  await f.provider.setModel(f.b, 'model-b');
  await f.provider.handleSend(f.a, 'A 的第一轮'); await f.a.proc.startingTurn;
  await f.provider.handleSend(f.b, 'B 的第一轮'); await f.b.proc.startingTurn;
  await f.provider.setModel(f.a, 'low-only');
  assert.equal(f.a.proc.isBusy, true); assert.equal(f.b.proc.isBusy, true);
  assert.deepEqual(calls.filter(c => c.method === 'turn/start').map(c => [c.session, c.params.model]), [['a', 'model-a'], ['b', 'model-b']]);
  f.a.proc.finish(false); f.b.proc.finish(false);
  await f.provider.handleSend(f.a, 'A 的第二轮'); await f.a.proc.startingTurn;
  await f.provider.handleSend(f.b, 'B 的第二轮'); await f.b.proc.startingTurn;
  assert.deepEqual(calls.filter(c => c.method === 'turn/start').map(c => [c.session, c.params.model]), [
    ['a', 'model-a'], ['b', 'model-b'], ['a', 'low-only'], ['b', 'model-b'],
  ]);
  f.b.proc.finish(false); await f.b.proc.disposeAndWait();
  delete f.b.model;
  await f.provider.handleSend(f.b, 'B 重连后'); await f.b.proc.startingTurn;
  assert.equal(calls.filter(c => c.method === 'thread/resume').at(-1).params.model, 'model-b');
  assert.equal(calls.filter(c => c.method === 'turn/start').at(-1).params.model, 'model-b');
});
