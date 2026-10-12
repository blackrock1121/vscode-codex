const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { JSDOM } = require('jsdom');

let config = {}, warnings = [], nativeCalls = [], resultError;
const vscode = {
  UIKind: { Desktop: 1 },
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
  w.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) });
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
  w.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) });
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
  w.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) });
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
