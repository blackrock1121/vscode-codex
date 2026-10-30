const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-afef-ui-'));
require('esbuild').buildSync({ stdin: { contents: `export * from './src/panel/chatViewProvider'; export * from './src/notifications'; export * from './src/operations'; export * from './src/logging'; export * from './src/diagnostics/scan'; export * from './src/diagnostics/general';`, resolveDir: path.resolve(__dirname, '..') }, outfile: path.join(directory, 'api.cjs'), bundle: true, platform: 'node', external: ['vscode'], logLevel: 'silent' });
const listeners = new Set();
const vscode = { window: { state: { focused: false }, onDidChangeWindowState: fn => { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } }, commands: { executeCommand: async () => {} } };
const originalLoad = Module._load; let api;
try { Module._load = function(id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); }; api = require(path.join(directory, 'api.cjs')); }
finally { Module._load = originalLoad; }
after(() => fs.rmSync(directory, { recursive: true, force: true }));
function capture(t) { const rows = []; api.setOperationLogSink(line => rows.push(JSON.parse(line.slice('[operation] '.length)))); t.after(() => api.setOperationLogSink()); return rows; }

test('afef 空或错误类型页面消息不产生未处理拒绝，下一条有效消息继续处理', async t => {
  const rows = capture(t), p = Object.create(api.ChatViewProvider.prototype), ctx = {};
  let sends = 0; p.handleSend = async () => { sends++; }; p.post = () => {};
  for (const value of [null, undefined, 123, [], {}, { type: 12 }]) {
    await p.onPanelMessage(ctx, value); await p.onSidebarMessage(value);
  }
  await p.onPanelMessage(ctx, { type: 'send', text: 'PRIVATE_MESSAGE' });
  assert.equal(sends, 1); assert.equal(rows.length, 12);
  assert.ok(rows.every(row => row.operation === 'webview.receive' && row.failureCategory === 'invalid_data'));
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_MESSAGE/);
});

test('afef HTTP200业务失败、HTTP错误、解析失败与超时独立分层，失败后正常发送落盘并可诊断', async t => {
  const dir = path.join(directory, 'logs'), writer = new api.DailyLogWriter(dir), rows = [];
  api.setOperationLogSink(line => { rows.push(JSON.parse(line.slice(12))); writer.write(line); });
  t.after(async () => { api.setOperationLogSink(); await writer.dispose(); });
  const p = Object.create(api.ChatViewProvider.prototype), originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/PRIVATE_TOKEN';
  for (const response of [
    {ok: true, status: 200, json: async () => ({code: 9499, secret: 'PRIVATE_BODY'})},
    {ok: false, status: 503},
    {ok: true, status: 200, json: async () => { throw new SyntaxError('PRIVATE_BODY'); }},
  ]) { global.fetch = async () => response; assert.equal((await p.sendWebhook(url, 'PRIVATE_MESSAGE')).ok, false); }
  global.fetch = async () => { throw Object.assign(new Error('PRIVATE_TOKEN'), {code: 'ETIMEDOUT'}); };
  assert.equal((await p.sendWebhook(url, 'PRIVATE_MESSAGE')).ok, false);
  global.fetch = async () => ({ok: true, status: 200, json: async () => ({code: 0})});
  assert.equal((await p.sendWebhook(url, 'PRIVATE_MESSAGE')).ok, true);
  const terminals = rows.filter(row => row.stage !== 'start');
  assert.deepEqual(terminals.map(row => [row.stage, row.phase, row.status]), [['failed','business_response',200],['failed','request',503],['failed','response_parse',200],['failed','request',undefined],['completed','business_response',200]]);
  assert.equal(terminals[0].businessCode, 9499); assert.equal(terminals[3].failureCategory, 'timeout');
  assert.equal(new Set(terminals.map(row => row.operationId)).size, 5);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
  await writer.flush();
  const output = fs.readdirSync(dir).filter(file => file.endsWith('.log')).map(file => fs.readFileSync(path.join(dir,file),'utf8')).join('\n');
  assert.match(output, /business_rejected/); assert.doesNotMatch(output, /PRIVATE/);
  const scan = await api.scanPluginLogs(dir, () => {}, {kind:'general', engine:'rules', hours:0, toMs:Date.now()+1000});
  assert.ok(scan.general.errors >= 4);
});

test('afef 聚焦截止保留超时分类，后续真实焦点成功关联旧失败且释放订阅', async t => {
  const rows = capture(t); t.mock.timers.enable({apis:['setTimeout']});
  vscode.window.state.focused = false;
  const pending = assert.rejects(api.focusNotificationWindow(), error => error.code === 'ETIMEDOUT');
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(2000); await pending;
  assert.equal(listeners.size, 0);
  const failure = rows.find(row => row.stage === 'failed');
  assert.equal(failure.phase, 'window_focus'); assert.equal(failure.timeoutMs, 2000); assert.equal(failure.failureCategory,'timeout');
  vscode.window.state.focused = true; await api.focusNotificationWindow();
  assert.equal(rows.find(row => row.stage === 'recovered').previousFailureId, failure.failureId);
  assert.equal(listeners.size, 0);
});

test('afef 高亮器抛错保留转义正文、限流脱敏上报，后续成功渲染不受影响', async t => {
  const {JSDOM} = require('jsdom');
  const source = fs.readFileSync(path.resolve(__dirname, '../src/panel/chatViewProvider.ts'), 'utf8');
  const raw = source.slice(source.indexOf('  private html(')).match(/return (?:\/\* html \*\/ )?`([\s\S]*?)`;\s*\n\s+}/)[1];
  const dom = new JSDOM(raw.replace(/\$\{[^}]+\}/g,'').replace(/<script[^>]*><\/script>/g,''), {runScripts:'outside-only',pretendToBeVisual:true,url:'https://webview.test/'});
  t.after(() => dom.window.close()); const w = dom.window, sent=[];
  w.acquireVsCodeApi = () => ({postMessage:m=>sent.push(m),getState:()=>({}),setState:()=>{}});
  w.ResizeObserver=class{observe(){}disconnect(){}}; w.IntersectionObserver=class{observe(){}disconnect(){}};
  w.HTMLElement.prototype.scrollIntoView=function(){}; w.HTMLElement.prototype.scrollTo=function(){};
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}}); w.document.queryCommandSupported=()=>false;
  const built = await require('esbuild').build({entryPoints:[path.resolve(__dirname,'../src/webview/main.ts')],bundle:true,write:false,platform:'browser',plugins:[{name:'failing-highlight',setup(build){build.onResolve({filter:/^highlight.js\/lib\/common$/},()=>({path:'highlight',namespace:'fixture'})); build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export default {getLanguage:()=>true,highlight(code){if(window.__failHighlight)throw new TypeError('PRIVATE_EXCEPTION');return {value:code}},highlightAuto(code){return this.highlight(code)}}`}));}}]});
  w.__failHighlight=true;w.eval(built.outputFiles[0].text);
  const emit = text => w.dispatchEvent(new w.MessageEvent('message',{data:{kind:'load_history',sessionId:'highlight',items:[{type:'assistant_text',text}],checkpoints:[]}}));
  emit('```js\n<PRIVATE_LITERAL>\n```\n```js\nsecond\n```');
  assert.match(w.document.querySelector('.text-seg').textContent, /<PRIVATE_LITERAL>/);
  assert.equal(w.document.querySelector('PRIVATE_LITERAL'),null);
  const errors = sent.filter(m=>m.type==='webviewError'); assert.equal(errors.length,1);
  assert.equal(errors[0].message,'webview.highlight.fallback: TypeError'); assert.doesNotMatch(JSON.stringify(errors),/PRIVATE/);
  w.__failHighlight=false;emit('```js\nrecovered\n```');assert.match(w.document.querySelector('.text-seg').textContent,/recovered/);
});

test('afef 已在途的并发聚焦成功不能归为稍后失败的恢复', async t => {
  const rows=capture(t); t.mock.timers.enable({apis:['setTimeout']});
  const original=vscode.commands.executeCommand; t.after(()=>{vscode.commands.executeCommand=original;});
  let resolveFirst,rejectSecond,calls=0;
  vscode.window.state.focused=false;
  vscode.commands.executeCommand=()=>new Promise((resolve,reject)=>{if(calls++===0)resolveFirst=resolve;else rejectSecond=reject;});
  const first=api.focusNotificationWindow();
  const second=assert.rejects(api.focusNotificationWindow(),/failed/);
  await new Promise(resolve=>setImmediate(resolve)); rejectSecond(new Error('failed')); await second;
  const failure=rows.find(row=>row.stage==='failed');assert.ok(failure);
  vscode.window.state.focused=true;resolveFirst();await first;
  assert.equal(rows.filter(row=>row.stage==='recovered').length,0);
  vscode.commands.executeCommand=original;await api.focusNotificationWindow();
  assert.equal(rows.find(row=>row.stage==='recovered').previousFailureId,failure.failureId);
  assert.equal(listeners.size,0);
});


test('afef 高亮回退在宿主记录为降级，全面诊断不当作页面崩溃', async t => {
  const rows=capture(t),p=Object.create(api.ChatViewProvider.prototype);
  await p.onPanelMessage({}, {type:'webviewError', message:'webview.highlight.fallback: TypeError'});
  assert.equal(rows.length,1);assert.equal(rows[0].stage,'fallback');assert.equal(rows[0].operation,'webview.highlight');
  assert.equal(api.classifyIncident('',rows[0]).severity,'warning');
});
