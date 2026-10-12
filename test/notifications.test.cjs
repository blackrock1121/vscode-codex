const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { JSDOM } = require('jsdom');

let config = {}, warnings = [], nativeCalls = [], resultError;
const vscode = {
  UIKind: { Desktop: 1 },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { Active: -1 },
  Uri: { from: parts => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}?${parts.query}` }) },
  env: { uiKind: 1, uriScheme: 'vscode', asExternalUri: async uri => ({ toString: () => uri.toString() + '&windowId=42' }) },
  workspace: { getConfiguration: () => ({ get: key => config[key] }), workspaceFolders: [{ name: '公司项目' }] },
  window: { showWarningMessage: text => warnings.push(text) },
};
const originalLoad = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return vscode;
  if (id === 'node:child_process') return {
    execFile(file, args, options, callback) {
      (async () => {
        const request = args.at(-1), dir = path.dirname(request);
        nativeCalls.push({ file, args, options, request, data: JSON.parse(await fs.readFile(request, 'utf8')), mode: (await fs.stat(dir)).mode & 0o777 });
        await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(resultError ? { ok: false, error: resultError } : { ok: true }));
      })().then(() => callback(null, '', ''), callback);
    },
  };
  return originalLoad.call(this, id, ...args);
};
const { ChatViewProvider } = require('../dist/test/panel/chatViewProvider.js');
Module._load = originalLoad;
const proto = ChatViewProvider.prototype;
const flush = () => new Promise(resolve => setImmediate(resolve));

function provider() {
  const p = Object.create(proto);
  p.context = { extension: { id: 'blackrock1121.vscode-codex' }, extensionUri: { fsPath: '/tmp/extension with spaces' } };
  p.notificationWindowKey = 'window-A';
  p.sessions = new Set([{ sessionId: 'session-A' }]);
  p.detached = new Map([['detached', {}]]);
  p.store = { list: () => [{ id: 'history' }] };
  p.notifyTimers = new Set();
  p.output = { appendLine: () => {} };
  return p;
}

test('默认不启用本机通知，飞书原文本格式保持不变', async t => {
  config = { notifyWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test' };
  const p = provider(), bodies = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => { bodies.push({ url, payload: JSON.parse(options.body) }); return { ok: true, status: 200 }; };
  t.after(() => { global.fetch = originalFetch; });
  p.sendLocalNotice = async () => assert.fail('本机通知默认不能发送');
  p.dispatchNotification({ sessionId: 'session-A' }, '✅ 任务完成\n项目：公司项目', { isError: false });
  await flush();
  assert.deepEqual(bodies, [{ url: config.notifyWebhook, payload: { msg_type: 'text', content: { text: '✅ 任务完成\n项目：公司项目' } } }]);
  assert.equal(require('../package.json').contributes.configuration.properties['codexChat.notifyLocal'].default, false);
});

test('本机通知权限失败/一直等待，不阻断远程推送', async () => {
  config = { notifyWebhook: 'https://example.invalid/hook', notifyLocal: true };
  const p = provider(), remote = [], local = [];
  p.sendWebhook = async (...args) => { remote.push(args); return { ok: true, status: 200 }; };
  p.sendLocalNotice = async (...args) => { local.push(args); throw new Error('权限拒绝'); };
  p.dispatchNotification({ sessionId: 'session-A' }, '标题\n正文', { waiting: true });
  await flush();
  assert.equal(remote.length, 1);
  assert.deepEqual(local, [['标题', '正文', 'session-A']]);
  p.sendLocalNotice = () => new Promise(() => {});
  p.dispatchNotification({}, '下一条', {});
  await flush();
  assert.equal(remote.length, 2);
});

test('远程失败不阻断本机通知；关闭本机后仍发送远程通知', async () => {
  config = { notifyWebhook: 'https://example.invalid/hook', notifyLocal: true };
  const p = provider();
  let local = 0, remote = 0;
  p.sendWebhook = async () => { remote++; throw new Error('网络断开'); };
  p.sendLocalNotice = async () => { local++; };
  p.dispatchNotification({}, '完成', {});
  await flush();
  assert.equal(local, 1);
  config.notifyLocal = false;
  p.dispatchNotification({}, '等待', { waiting: true });
  await flush();
  assert.equal(local, 1);
  assert.equal(remote, 2);
});

test('本机通知用自定义工作区名称区分窗口，保留会话路由和飞书正文', async t => {
  config = { notifyWebhook: 'https://example.invalid/hook', notifyLocal: true };
  const p = provider(), local = [], remote = [];
  const previousName = vscode.workspace.name;
  t.after(() => { vscode.workspace.name = previousName; });
  p.sendLocalNotice = async (...args) => local.push(args);
  p.sendWebhook = async (_url, text) => { remote.push(text); return { ok: true, status: 200 }; };
  const msg = '⏳ Codex 正在等你输入（距上次操作 2 分 0 秒）\n项目：公司项目\n待回答：是否继续？\n本轮提问：原始任务';
  vscode.workspace.name = '前端工作区';
  p.dispatchNotification({ sessionId: 'session-A' }, msg, { waiting: true, project: '公司项目', ask: '待回答：是否继续？', question: '原始任务' });
  vscode.workspace.name = '服务端工作区';
  p.dispatchNotification({ sessionId: 'session-B' }, msg, { waiting: true, project: '公司项目', ask: '待回答：是否继续？' });
  await flush();
  assert.deepEqual(local, [
    ['⏳ 前端工作区 · 待回答', '等待 2分\n是否继续？', 'session-A'],
    ['⏳ 服务端工作区 · 待回答', '等待 2分\n是否继续？', 'session-B'],
  ]);
  assert.deepEqual(remote, [msg, msg]);
  vscode.workspace.name = undefined;
  p.dispatchNotification({ sessionId: 'session-A' }, '✅ Codex 任务完成（耗时 1 分 5 秒）', { project: '公司项目', question: '修复通知' });
  await flush();
  assert.deepEqual(local.at(-1), ['✅ 公司项目 · 已完成', '耗时 1分5秒\n修复通知', 'session-A']);
});

test('完成通知仍遵守阈值，无 webhook 时也能单独选择本机通知', () => {
  config = { notifyLocal: true, notifyMinDurationSec: 60 };
  const p = provider(), calls = [];
  p.dispatchNotification = (...args) => calls.push(args);
  p.maybeNotifyTurnDone({ lastUserText: '短任务' }, { isError: false, durationMs: 59999 });
  assert.equal(calls.length, 0);
  const ctx = { sessionId: 'session-A', lastUserText: '修复\n链接' };
  p.maybeNotifyTurnDone(ctx, { isError: false, durationMs: 60000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].sessionId, 'session-A');
  assert.equal(calls[0][2].question, '修复 链接');
  p.maybeNotifyTurnDone(ctx, { isError: false, durationMs: 60000 });
  assert.equal(calls.length, 1, '同一结果不能重复发送');
});

test('等待输入通知达到阈值才发，已回答或切换进程时不误报', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  config = { notifyWebhook: 'https://example.invalid', notifyMinDurationSec: 60 };
  const p = provider(), calls = [];
  p.dispatchNotification = (...args) => calls.push(args);
  const req = { requestId: 'q1', toolName: 'AskUserQuestion', input: { questions: [{ question: '继续？' }] } };
  const ctx = { sessionId: 'session-A', proc: {}, pendingPerm: { ...req, kind: 'permission_request' }, lastUserActionAt: 100000 };
  p.maybeNotifyWaiting(ctx, req);
  t.mock.timers.tick(59999);
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].waiting, true);
  assert.equal(p.notifyTimers.size, 0);
  p.maybeNotifyWaiting(ctx, req);
  ctx.pendingPerm = undefined;
  t.mock.timers.tick(1);
  assert.equal(calls.length, 1);
  ctx.pendingPerm = { ...req, kind: 'permission_request' };
  p.maybeNotifyWaiting(ctx, req);
  ctx.proc = {};
  t.mock.timers.tick(1);
  assert.equal(calls.length, 1);
});

test('通知跳转只接受所属窗口和已知会话，支持后台与关闭的标签', async () => {
  warnings = [];
  const a = provider(), b = provider(), opened = [];
  b.notificationWindowKey = 'window-B';
  a.openSession = async id => opened.push(id);
  b.openSession = async () => assert.fail('不能在另一个窗口打开');
  const uri = { path: '/notification', query: 'window=window-A&session=session-A' };
  await b.handleNotificationUri(uri);
  assert.equal(warnings.length, 1);
  for (const id of ['session-A', 'detached', 'history']) await a.handleNotificationUri({ ...uri, query: `window=window-A&session=${id}` });
  assert.deepEqual(opened, ['session-A', 'detached', 'history']);
  await a.handleNotificationUri({ ...uri, query: 'window=window-A&session=../../other' });
  assert.equal(opened.length, 3);
  let settings = 0;
  a.showNotifyConfig = () => settings++;
  await a.handleNotificationUri({ ...uri, query: 'window=window-A' });
  assert.equal(settings, 1);
  await a.handleNotificationUri({ path: '/elsewhere', query: 'window=window-A' });
  assert.equal(settings, 1);
});

test('通知使用 VS Code 返回的完整窗口 URI，通过文件传递中文及命令字符并清理临时文件', { skip: process.platform !== 'darwin' }, async () => {
  nativeCalls = []; resultError = undefined;
  await provider().sendLocalNotice('标题 $(touch BAD)', '中文 `echo` "引号"\n正文', 'session-A');
  assert.equal(nativeCalls.length, 1);
  const call = nativeCalls[0];
  assert.equal(call.file, '/usr/bin/open');
  assert.equal(call.mode, 0o700);
  assert.equal(call.args[2], '/tmp/extension with spaces/dist/Codex Copilot Notifications.app');
  assert.equal(call.data.url, 'vscode://blackrock1121.vscode-codex/notification?window=window-A&session=session-A&windowId=42');
  assert.equal(call.data.body, '中文 `echo` "引号"\n正文');
  assert.equal(call.args.some(arg => arg.includes('touch BAD')), false);
  await assert.rejects(fs.stat(path.dirname(call.request)), { code: 'ENOENT' });
  resultError = '系统权限拒绝';
  await assert.rejects(provider().sendLocalNotice('失败', '正文'), /系统权限拒绝/);
  await assert.rejects(fs.stat(path.dirname(nativeCalls.at(-1).request)), { code: 'ENOENT' });
  resultError = undefined;
});

test('远程扩展宿主不启动 Mac 通知辅助程序', async () => {
  vscode.env.remoteName = 'ssh-remote';
  const count = nativeCalls.length;
  try {
    await assert.rejects(provider().sendLocalNotice('测试', '正文'), /仅支持本机 macOS/);
    assert.equal(nativeCalls.length, count);
  } finally { vscode.env.remoteName = undefined; }
});

test('配置面板保存两个独立渠道，测试本机不会触发飞书测试', t => {
  const dom = new JSDOM(provider().notifyHtml(), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, sent = [];
  w.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message), setState: () => {} });
  w.eval(w.document.querySelector('script').textContent);
  w.dispatchEvent(new w.MessageEvent('message', { data: { kind: 'notify_config', webhook: 'https://example.invalid/hook', minSec: 60, local: false, localSupported: true } }));
  assert.equal(w.document.querySelector('#local').checked, false);
  w.document.querySelector('#local').checked = true;
  w.document.querySelector('#save').click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: 'notifySave', webhook: 'https://example.invalid/hook', minSec: 60, local: true, quietHours: { enabled: false, start: '08:30', end: '18:00' } });
  w.document.querySelector('#testlocal').click();
  assert.equal(sent.at(-1).type, 'notifyLocalTest');
  assert.equal(sent.some(m => m.type === 'notifyTest'), false);
});


test('飞书静默同时覆盖完成和等待输入，本机通知仍发送；其他 webhook 不受影响', async () => {
  config = { notifyWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test', notifyLocal: true,
    notifyFeishuQuietHours: { enabled: true, start: '08:30', end: '18:00' } };
  const p = provider(); let remote = 0, local = 0, checks = 0;
  p.workdayCalendar = { refresh: async () => {}, shouldMute: () => { checks++; return true; } };
  p.sendWebhook = async () => { remote++; return { ok: true, status: 200 }; };
  p.sendLocalNotice = async () => { local++; };
  p.dispatchNotification({}, '完成', { isError: false });
  p.dispatchNotification({}, '等待输入', { waiting: true });
  await flush();
  assert.equal(remote, 0); assert.equal(local, 2); assert.equal(checks, 2);
  config.notifyWebhook = 'https://example.invalid/other';
  p.dispatchNotification({}, '其他渠道', {}); await flush();
  assert.equal(remote, 1); assert.equal(checks, 2);
  config.notifyWebhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/test';
  config.notifyFeishuQuietHours.enabled = false;
  p.dispatchNotification({}, '关闭静默', {}); await flush();
  assert.equal(remote, 2);
});

test('配置面板可调整静默时间，日历刷新结果不覆盖尚未保存的输入', t => {
  const dom = new JSDOM(provider().notifyHtml(), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, sent = [];
  w.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message), setState: () => {} });
  w.eval(w.document.querySelector('script').textContent);
  const emit = data => w.dispatchEvent(new w.MessageEvent('message', { data }));
  emit({ kind: 'notify_config', minSec: 60, local: true, localSupported: true, quietHours: { enabled: false, start: '08:30', end: '18:00' } });
  assert.equal(w.document.querySelector('#quietstart').disabled, true);
  w.document.querySelector('#quiet').checked = true;
  w.document.querySelector('#quiet').dispatchEvent(new w.Event('change'));
  assert.equal(w.document.querySelector('#quietstart').disabled, false);
  w.document.querySelector('#quietstart').value = '09:15';
  w.document.querySelector('#refreshcalendar').click();
  assert.equal(sent.at(-1).type, 'notifyCalendarRefresh');
  emit({ kind: 'notify_calendar', message: '日历已更新' });
  assert.equal(w.document.querySelector('#quietstart').value, '09:15');
  w.document.querySelector('#save').click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1).quietHours)), { enabled: true, start: '09:15', end: '18:00' });
});

test('日历异常时飞书照常发送，不影响本机通知', async () => {
  config = { notifyWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test', notifyLocal: true,
    notifyFeishuQuietHours: { enabled: true, start: '08:30', end: '18:00' } };
  const p = provider(); let remote = 0, local = 0;
  p.workdayCalendar = { refresh: async () => {}, shouldMute: () => { throw new Error('未知日历错误'); } };
  p.sendWebhook = async () => { remote++; return { ok: true, status: 200 }; };
  p.sendLocalNotice = async () => { local++; };
  p.dispatchNotification({}, '完成', {});
  await flush();
  assert.equal(remote, 1); assert.equal(local, 1);
});

test('本机通知未开启时即使静默规则已开启也不允许暂停飞书，关闭后即时恢复', async () => {
  config = { notifyWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
    notifyFeishuQuietHours: { enabled: true, start: '08:30', end: '18:00' } };
  const p = provider(); let remote = 0, local = 0, checked = 0;
  p.workdayCalendar = { refresh: async () => {}, shouldMute: () => { checked++; return true; } };
  p.sendWebhook = async () => { remote++; return { ok: true, status: 200 }; };
  p.sendLocalNotice = async () => { local++; };
  for (const value of [undefined, false, true, false]) {
    config.notifyLocal = value;
    p.dispatchNotification({}, '完成', { isError: false });
    p.dispatchNotification({}, '等待输入', { waiting: true });
    await flush();
  }
  assert.equal(remote, 6, '仅本机通知开启的两条消息允许静默');
  assert.equal(local, 2);
  assert.equal(checked, 2, '关闭本机通知时不进行静默判断');
});

test('配置界面仅在本机通知开启后允许静默，关闭后保留规则并显示不生效', t => {
  const dom = new JSDOM(provider().notifyHtml(), { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, sent = [];
  w.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message), setState: () => {} });
  w.eval(w.document.querySelector('script').textContent);
  const el = id => w.document.getElementById(id);
  const emit = local => w.dispatchEvent(new w.MessageEvent('message', { data: {
    kind: 'notify_config', webhook: 'https://open.feishu.cn/test', minSec: 60,
    local, localSupported: true, quietHours: { enabled: true, start: '09:15', end: '18:30' },
  } }));
  emit(false);
  for (const id of ['quiet', 'quietstart', 'quietend']) assert.equal(el(id).disabled, true);
  assert.match(el('quiethint').textContent, /飞书不会暂停/);
  el('local').checked = true;
  el('local').dispatchEvent(new w.Event('change'));
  for (const id of ['quiet', 'quietstart', 'quietend']) assert.equal(el(id).disabled, false);
  assert.equal(el('quietstart').value, '09:15');
  emit(false);
  assert.equal(el('quiet').disabled, true, '设置面板从外部关闭本机通知也同步禁用');
  emit(true);
  assert.equal(el('quiet').disabled, false);
  el('local').checked = false;
  el('local').dispatchEvent(new w.Event('change'));
  el('save').click();
  assert.equal(sent.at(-1).local, false);
  assert.equal(sent.at(-1).quietHours.enabled, true, '保留原规则，由发送端检查前置条件');
  assert.equal(el('quietstart').disabled, true);
});

test('重建推送面板后恢复表单与已保存设置，绑定消息早于脚本加载，关闭时释放订阅', async t => {
  config = { notifyWebhook: 'https://example.invalid/test', notifyMinDurationSec: 30, notifyLocal: true,
    notifyFeishuQuietHours: { enabled: true, start: '09:00', end: '18:30' } };
  const callbacks = new Set(), panels = [];
  const previous = { change: vscode.workspace.onDidChangeConfiguration, get: vscode.workspace.getConfiguration, create: vscode.window.createWebviewPanel };
  t.after(() => {
    vscode.workspace.onDidChangeConfiguration = previous.change;
    vscode.workspace.getConfiguration = previous.get;
    vscode.window.createWebviewPanel = previous.create;
    for (const panel of panels) panel.dom?.window.close();
  });
  vscode.workspace.onDidChangeConfiguration = callback => {
    callbacks.add(callback);
    return { dispose: () => callbacks.delete(callback) };
  };
  let saveError;
  vscode.workspace.getConfiguration = () => ({ get: key => config[key], update: async (key, value) => {
    if (saveError) throw new Error(saveError);
    config[key] = value;
    for (const callback of callbacks) callback({ affectsConfiguration: name => name === 'codexChat.' + key });
  } });
  function panel() {
    const p = { sent: [], tasks: [], reveals: 0, listenerCount: 0, disposed: false,
      reveal() { this.reveals++; }, onDidDispose(fn) { this.onDispose = fn; },
      dispose() { this.disposed = true; this.onDispose?.(); this.dom?.window.close(); },
    };
    p.webview = {
      options: {},
      onDidReceiveMessage(fn) { p.receive = fn; p.listenerCount++; return { dispose() { p.listenerCount--; } }; },
      postMessage(message) { p.sent.push(message); p.dom?.window.dispatchEvent(new p.dom.window.MessageEvent('message', { data: message })); },
      set html(value) {
        assert.equal(typeof p.receive, 'function', '页面运行前必须先接收 notifyLoad');
        p.dom = new JSDOM(value, { runScripts: 'outside-only' });
        p.dom.window.acquireVsCodeApi = () => ({ setState: state => { p.state = state; }, postMessage: m => p.tasks.push(p.receive(m)) });
        p.dom.window.eval(p.dom.window.document.querySelector('script').textContent);
      },
    };
    panels.push(p); return p;
  }
  const calendar = { status: () => '日历已同步', refresh: async () => {} };
  const a = provider(); a.workdayCalendar = calendar;
  const first = panel(); a.reviveNotifyPanel(first); await Promise.all(first.tasks);
  assert.equal(first.title, '任务推送');
  assert.equal(first.webview.options.enableScripts, true);
  assert.equal(JSON.stringify(first.state), '{"view":"notify","version":1}', '恢复标记不含 webhook');
  const el = id => first.dom.window.document.getElementById(id);
  assert.equal(el('webhook').value, config.notifyWebhook);
  assert.equal(el('minsec').value, '30');
  assert.equal(el('quietstart').value, '09:00');
  const before = first.sent.filter(m => m.kind === 'notify_config').length;
  await first.receive({ type: 'notifySave', webhook: 'https://example.invalid/updated', minSec: 90, local: false,
    quietHours: { enabled: true, start: '10:00', end: '19:00' } });
  assert.equal(first.sent.filter(m => m.kind === 'notify_config').length - before, 1, '保存多个字段后一次性同步，不用中间状态刷新表单');
  assert.equal(el('minsec').value, '90');
  saveError = '模拟保存失败';
  await first.receive({ type: 'notifySave', webhook: '', minSec: 30, local: false,
    quietHours: { enabled: false, start: '08:30', end: '18:00' } });
  assert.match(el('status').textContent, /模拟保存失败/);
  calendar.refresh = async () => { throw new Error('模拟日历失败'); };
  el('refreshcalendar').click(); await Promise.all(first.tasks);
  assert.equal(el('refreshcalendar').disabled, false);
  assert.match(el('status').textContent, /模拟日历失败/);
  first.dispose(); assert.equal(callbacks.size, 0); assert.equal(first.listenerCount, 0);
  const b = provider(); b.workdayCalendar = calendar;
  const restored = panel(); b.reviveNotifyPanel(restored); await Promise.all(restored.tasks);
  assert.equal(restored.dom.window.document.getElementById('webhook').value, 'https://example.invalid/updated');
  assert.equal(restored.dom.window.document.getElementById('minsec').value, '90');
  assert.equal(restored.dom.window.document.getElementById('quietstart').value, '10:00');
  vscode.window.createWebviewPanel = () => assert.fail('已恢复的配置页不能重复新建');
  b.showNotifyConfig(); assert.equal(restored.reveals, 1);
  const duplicate = panel(); b.reviveNotifyPanel(duplicate);
  assert.equal(duplicate.disposed, true); assert.equal(b.notifyPanel, restored);
  restored.dispose(); assert.equal(callbacks.size, 0);
  assert.ok(require('../package.json').activationEvents.includes('onWebviewPanel:codex-chat.notify'));
});

test('远程宿主即使同步了本机通知开关，也不能静默飞书', async t => {
  config = { notifyWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test', notifyLocal: true,
    notifyFeishuQuietHours: { enabled: true, start: '08:30', end: '18:00' } };
  const p = provider(); let remote = 0;
  p.workdayCalendar = { refresh: () => assert.fail('不支持本机通知时无需读取静默日历'), shouldMute: () => assert.fail('不能静默') };
  p.sendWebhook = async () => { remote++; return { ok: true, status: 200 }; };
  p.sendLocalNotice = async () => { throw new Error('不支持本机通知'); };
  vscode.env.remoteName = 'ssh-remote';
  t.after(() => { vscode.env.remoteName = undefined; });
  p.dispatchNotification({}, '完成', {}); await flush();
  assert.equal(remote, 1);
});
