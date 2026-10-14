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

test('同一会话通知复用编号，重载窗口不变，派生和其他会话有独立编号', async () => {
  nativeCalls = []; resultError = undefined;
  const p = provider();
  await p.sendLocalNotice('等待', '旧', 'source');
  await p.sendLocalNotice('完成', '新', 'source');
  p.notificationWindowKey = 'reloaded-window';
  await p.sendLocalNotice('下一轮', '最新', 'source');
  await p.sendLocalNotice('派生完成', '独立', 'branch');
  assert.deepEqual(nativeCalls.map(x=>x.data.id), ['codex-session:source','codex-session:source','codex-session:source','codex-session:branch']);
  assert.equal(nativeCalls[3].data.sessionId, 'branch');
  assert.match(nativeCalls[3].data.url, /session=branch/);
  assert.ok(nativeCalls.every((x,i)=>i===0||x.data.createdAt>nativeCalls[i-1].data.createdAt));
});

test('较早通知的慢跳转解析不能越过回复清理和最新通知，派生通知不被阻塞', async t => {
  config = { notifyLocal:true }; nativeCalls=[];
  const p=provider(),original=vscode.env.asExternalUri;
  let release;
  vscode.env.asExternalUri=async uri=>{
    if(uri.query.includes('session=source')) {
      vscode.env.asExternalUri=original;
      await new Promise(resolve=>{release=resolve;});
    }
    return original(uri);
  };
  t.after(()=>{vscode.env.asExternalUri=original;release?.();});
  const old=p.sendLocalNotice('旧通知','', 'source');
  await flush();
  p.clearSessionNotification('source');
  const latest=p.sendLocalNotice('最新通知','', 'source');
  await p.sendLocalNotice('派生通知','', 'branch');
  assert.equal(nativeCalls.length,1);assert.equal(nativeCalls[0].data.sessionId,'branch');
  release();await Promise.all([old,latest]);
  assert.deepEqual(nativeCalls.filter(x=>x.data.sessionId==='source').map(x=>x.data.operation),['clear','show']);
  assert.equal(nativeCalls.at(-1).data.title,'最新通知');
  const clear=nativeCalls.find(x=>x.data.operation==='clear').data;
  assert.equal(clear.id,'codex-session:source');assert.equal(clear.url,undefined);
});

test('本机通道失败不阻塞同会话后续清理和通知，未开启时不启动清理程序', async () => {
  nativeCalls=[];config={notifyLocal:true};const p=provider();
  resultError='权限拒绝';
  await assert.rejects(p.sendLocalNotice('旧','', 'recover'),/权限拒绝/);
  resultError=undefined;
  p.clearSessionNotification('recover');
  await p.sendLocalNotice('新','', 'recover');
  assert.deepEqual(nativeCalls.map(x=>x.data.operation),['show','clear','show']);
  const count=nativeCalls.length;config={notifyLocal:false};
  p.clearSessionNotification('recover');await flush();assert.equal(nativeCalls.length,count);
});

test('直接发送消息成功后清理该会话，发送失败保留旧通知',async()=>{
  for(const accepted of [true,false]){
    const p=provider(),cleared=[];
    p.config=()=>({get:(key,fallback)=>['autosave','snapshotFilesForRestore'].includes(key)?false:fallback});
    const proc={isBusy:false,setSpeedMode:async()=>{},sendUserMessage:()=>accepted};
    p.ensureProcess=async()=>proc;p.speedMode=()=> 'default';p.post=()=>{};
    p.store.hydrate=async()=>{};p.store.countLines=()=>0;
    p.clearSessionNotification=id=>cleared.push(id);
    const ctx={sessionId:'branch',proc,checkpoints:{beginTurn:()=> 'checkpoint'}};
    await p.handleSend(ctx,'直接在派生会话回复');
    assert.deepEqual(cleared,accepted?['branch']:[]);
  }
});
test('完整 UUID 用于通知去重，相同前缀的不同会话不会覆盖',async()=>{
  nativeCalls=[];const p=provider();
  const a='01999999-aaaa-7000-8000-000000000001',b='01999999-aaaa-7000-8000-000000000002';
  await p.sendLocalNotice('原会话','',a);await p.sendLocalNotice('派生','',b);
  assert.notEqual(nativeCalls[0].data.id,nativeCalls[1].data.id);
  assert.equal(nativeCalls[0].data.sessionId,a);assert.equal(nativeCalls[1].data.sessionId,b);
});
test('还原后的同一标签不接收旧会话的延迟等待提醒',t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  config={notifyLocal:true,notifyMinDurationSec:60};
  const p=provider(),sent=[];p.dispatchNotification=(ctx)=>sent.push(ctx.sessionId);
  p.clearSessionNotification=()=>{};
  const req={requestId:'same-question',toolName:'AskUserQuestion',input:{questions:[{question:'继续？'}]}};
  const ctx={sessionId:'source',pendingPerm:{kind:'permission_request',...req},lastUserActionAt:Date.now()};
  p.maybeNotifyWaiting(ctx,req);
  p.resetRestoredNotifications(ctx,'source');ctx.sessionId='branch';
  ctx.pendingPerm={kind:'permission_request',...req};p.maybeNotifyWaiting(ctx,req);
  t.mock.timers.tick(60000);
  assert.deepEqual(sent,['branch']);
});

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

test('未保存的多目录工作区按目录组合显示，完成和等待通知都保留状态及路由', async t => {
  config = { notifyLocal: true };
  const before = { ...vscode.workspace };
  t.after(() => { Object.assign(vscode.workspace, { name: undefined, workspaceFile: undefined }, before); });
  vscode.workspace.workspaceFile = { scheme: 'untitled' };
  vscode.workspace.workspaceFolders = [{ name: 'game-server' }, { name: 'funny-games' }];
  const p = provider(), local = [];
  p.sendLocalNotice = async (...args) => local.push(args);
  for (const name of ['无标题 (工作区)', 'Untitled (Workspace)', 'Sans titre (Espace de travail)']) {
    vscode.workspace.name = name;
    p.dispatchNotification({ sessionId: 'session-A' }, '✅ Codex 任务完成（耗时 3 分 29 秒）', { project: 'game-server', question: '优化通知' });
    p.dispatchNotification({ sessionId: 'session-B' }, '⏳ Codex 正在等你输入（距上次操作 2 分 0 秒）', { project: 'game-server', waiting: true, ask: '待授权：运行命令' });
    await flush();
    assert.deepEqual(local.slice(-2), [
      ['✅ game-server / funny-games · 已完成', '耗时 3分29秒\n优化通知', 'session-A'],
      ['⏳ game-server / funny-games · 待授权', '等待 2分\n运行命令', 'session-B'],
    ]);
  }
  vscode.workspace.workspaceFolders = [{ name: 'game-server' }];
  p.dispatchNotification({}, '✅ Codex 任务完成', { project: 'game-server' });
  assert.equal(local.at(-1)[0], '✅ game-server · 已完成');
  vscode.workspace.workspaceFolders = [];
  p.dispatchNotification({}, '✅ Codex 任务完成', { project: '' });
  assert.equal(local.at(-1)[0], '✅ 未命名工作区 · 已完成');
  vscode.workspace.workspaceFile = { scheme: 'file' };
  vscode.workspace.name = 'Untitled';
  p.dispatchNotification({}, '✅ Codex 任务完成', { project: '' });
  assert.equal(local.at(-1)[0], '✅ Untitled · 已完成', '显式保存的工作区名称不按文字猜测');
});

test('多目录长名称分别截短，中文和 emoji 完整且保留剩余目录数', async t => {
  config = { notifyLocal: true };
  const before = { ...vscode.workspace };
  t.after(() => { Object.assign(vscode.workspace, { name: undefined, workspaceFile: undefined }, before); });
  vscode.workspace.name = '无标题 (工作区)';
  vscode.workspace.workspaceFile = { scheme: 'untitled' };
  vscode.workspace.workspaceFolders = [
    { name: '前端👩‍💻项目非常非常长的名称' }, { name: '后端👨‍💻项目非常非常长的名称' },
    { name: 'shared' }, { name: 'tools' },
  ];
  const p = provider(), local = [];
  p.sendLocalNotice = async (...args) => local.push(args);
  p.dispatchNotification({}, '✅ Codex 任务完成', { project: '前端项目' });
  await flush();
  assert.equal(local[0][0], '✅ 前端👩‍💻项… / 后端👨‍💻项… +2 · 已完成');
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

test('工作时段本机通知失败时补发飞书，成功时保持静默，非静默时不重复发送', async () => {
  config = { notifyWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test', notifyLocal: true,
    notifyFeishuQuietHours: { enabled: true, start: '08:30', end: '18:00' } };
  const p = provider(), sent = [];
  p.workdayCalendar = { refresh: async () => {}, shouldMute: () => true };
  p.sendWebhook = async (...args) => { sent.push(args); return { ok: true, status: 200 }; };
  p.sendLocalNotice = async () => {};
  p.dispatchNotification({}, '本机成功', {}); await flush();
  assert.equal(sent.length, 0);
  p.sendLocalNotice = async () => { throw new Error('系统拒绝通知权限'); };
  const extra = { waiting: true };
  p.dispatchNotification({}, '等待输入', extra); await flush();
  assert.deepEqual(sent, [[config.notifyWebhook, '等待输入', extra]]);
  config.notifyFeishuQuietHours.enabled = false;
  p.dispatchNotification({}, '非静默完成', {}); await flush();
  assert.equal(sent.length, 2, '已发送的远程提醒不能因本机失败再次发送');
});

test('主动回复只清理来源会话，多标签与派生通知继续独立发送', async () => {
  nativeCalls=[]; config={notifyLocal:true}; const p=provider();
  const a='01999999-aaaa-7000-8000-000000000001', branch='01999999-aaaa-7000-8000-000000000002';
  await Promise.all([p.sendLocalNotice('同项目同标题','',a),p.sendLocalNotice('同项目同标题','',branch),p.sendLocalNotice('同项目同标题','','other')]);
  p.config=()=>({get:(key,fallback)=>key==='notifyLocal'?true:['autosave','snapshotFilesForRestore'].includes(key)?false:fallback});
  const proc={isBusy:false,setSpeedMode:async()=>{},sendUserMessage:()=>true};
  p.ensureProcess=async()=>proc; p.speedMode=()=> 'default';p.post=()=>{};
  p.store.hydrate=async()=>{};p.store.countLines=()=>0;
  const ctx={sessionId:a,proc,checkpoints:{beginTurn:()=> 'checkpoint'}};
  await p.handleSend(ctx,'我没点通知，直接回复');
  await Promise.all([p.sendLocalNotice('新一轮完成','',a),p.sendLocalNotice('分支仍待回答','',branch)]);
  assert.deepEqual(nativeCalls.filter(x=>x.data.operation==='clear').map(x=>x.data.sessionId),[a]);
  assert.equal(p.notificationVersion(branch),0);assert.equal(p.notificationVersion('other'),0);
  assert.equal(nativeCalls.filter(x=>x.data.sessionId===a).at(-1).data.operation,'show');
});

test('旧审批卡片及未成功提交的审批不能清除当前会话通知', () => {
  for (const mode of ['stale','rejected','accepted']) {
    const p=provider(),cleared=[];p.clearSessionNotification=id=>cleared.push(id);
    const pending={kind:'permission_request',requestId:'current'};
    const ctx={sessionId:'branch',pendingPerm:pending,proc:{respondPermission:()=>{
      assert.notEqual(mode,'stale');return mode==='accepted';
    }}};
    p.handlePermission(ctx,mode==='stale'?'old-source-request':'current','allow');
    assert.deepEqual(cleared,mode==='accepted'?['branch']:[]);
    assert.equal(ctx.pendingPerm,mode==='accepted'?undefined:pending);
  }
});

test('连续点击通知复用已有标签，不重发通知、不提交回答、不触发清理', async () => {
  const p=provider();let reveals=0,locks=0;
  const pending={kind:'permission_request',requestId:'still-waiting'};
  const ctx={sessionId:'session-A',pendingPerm:pending,panel:{viewColumn:1,reveal:()=>reveals++}};
  p.sessions=new Set([ctx]);p.lockChatGroup=async()=>{locks++;await flush();};
  p.clearSessionNotification=()=>assert.fail('点击不是回复，不能清理新通知');
  p.dispatchNotification=()=>assert.fail('点击不能重发通知');
  p.ensureProcess=()=>assert.fail('已有标签无需重新连接');
  p.submitQuestionAnswer=()=>assert.fail('点击不能自动答题');
  const uri={path:'/notification',query:'window=window-A&session=session-A'};
  await Promise.all(Array.from({length:8},()=>p.handleNotificationUri(uri)));
  assert.equal(p.sessions.size,1);assert.equal(p.activeCtx,ctx);
  assert.equal(ctx.pendingPerm,pending);assert.equal(reveals,8);assert.equal(locks,8);
  await flush();assert.equal(reveals,8,'没有自动再次触发跳转');
});

test('回复与旧通知点击回调交错，迟到的点击不清除新一轮通知或派生通知', async () => {
  config={notifyLocal:true};nativeCalls=[];const p=provider();let release;
  p.openSession=async()=>{await new Promise(resolve=>release=resolve);};
  await p.sendLocalNotice('旧通知','','session-A');
  const click=p.handleNotificationUri({path:'/notification',query:'window=window-A&session=session-A'});
  await flush();
  p.clearSessionNotification('session-A');
  await Promise.all([p.sendLocalNotice('新一轮提醒','','session-A'),p.sendLocalNotice('分支提醒','','branch')]);
  const count=nativeCalls.length;
  release();await click;await flush();
  assert.equal(nativeCalls.length,count,'点击回调结束不产生通知或清理');
  assert.deepEqual(nativeCalls.filter(x=>x.data.sessionId==='session-A').map(x=>x.data.operation),['show','clear','show']);
  assert.equal(nativeCalls.filter(x=>x.data.sessionId==='branch').length,1);
});

test('点击打开失败只提示一次，不自动重试；用户再次点击可以正常重试', async () => {
  warnings=[];const p=provider();let attempts=0;
  p.openSession=async()=>{attempts++;throw new Error('模拟窗口打开失败');};
  p.dispatchNotification=()=>assert.fail('失败不能触发新通知');
  p.clearSessionNotification=()=>assert.fail('失败不能清理通知');
  const uri={path:'/notification',query:'window=window-A&session=history'};
  await p.handleNotificationUri(uri);await flush();
  assert.equal(attempts,1);assert.equal(warnings.length,1);
  p.openSession=async()=>{attempts++;};await p.handleNotificationUri(uri);
  assert.equal(attempts,2);assert.equal(warnings.length,1);
});
