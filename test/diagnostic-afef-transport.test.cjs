const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), originalLoad = Module._load;
let api;
try {
  Module._load = function(name, ...args) { return name === 'vscode' ? { window: {}, Uri: {}, ViewColumn: { Active: 1 } } : originalLoad.call(this, name, ...args); };
  api = require(process.env.AFef_TEST_BUNDLE || '../dist/test/diagnostic-safety.js');
} finally { Module._load = originalLoad; }
async function capture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-afef-transport-'));
  const rows = [], writer = new api.DailyLogWriter(dir, { pluginVersion: 'test', windowId: 'afef', hostId: 'test' });
  api.setOperationLogSink(line => { rows.push(JSON.parse(line.slice(line.indexOf('{')))); writer.write(line); });
  t.after(async () => { api.setOperationLogSink(); await writer.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { rows, writer, scan: async () => { await writer.flush(); return api.scanPluginLogs(dir, () => {}, { kind: 'general', hours: 0, engine: 'rules', toMs: Date.now() + 1000 }); } };
}
test('afef MCP 403 多行挑战页仅保留一个脱敏传输失败，后续成功 RPC 不受影响', async t => {
  const f = await capture(t), rows = [];
  const rpc = new api.CodexRpc(path.resolve('test/fake-codex.cjs'), process.cwd(), undefined, true);
  rpc.on('diagnostic', row => { rows.push(row); f.writer.write('[transport] ' + JSON.stringify(row)); });
  t.after(() => rpc.disposeAndWait()); await rpc.start();
  const html = '2026-10-30T02:34:42.063020Z ERROR rmcp::transport::worker: worker quit with fatal: HTTP 403: <html>\n' +
    '<head><script>PRIVATE_TOKEN</script></head>\n' +
    '<div id="challenge-error-text">Enable JavaScript and cookies to continue PRIVATE_BODY</div>\n</html>\n';
  for (let i = 0; i < html.length; i += 17) rpc.child.stderr.emit('data', html.slice(i, i + 17));
  const failures = rows.filter(row => row.type === 'runtime_error');
  assert.equal(failures.length, 1); assert.equal(failures[0].event, 'upstream_http_error');
  assert.equal(failures[0].httpStatusCode, 403); assert.equal(failures[0].targetKind, 'mcp_transport');
  assert.equal(failures[0].responseKind, 'html'); assert.ok(failures[0].failureId);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|<html|challenge-error-text|JavaScript and cookies/);
  assert.deepEqual(await rpc.request('echo', { ok: true }), { ok: true }); assert.equal(rpc.isClosed, false);
  const scan = await f.scan(); assert.ok(scan.findings.some(row => /403/.test(row.evidence)));
  t.diagnostic(JSON.stringify({ legacyHtmlErrorObservations: 2, currentHtmlErrorObservations: failures.length, rawResponseBytesLogged: 0 }));
});
test('afef HTML 状态不会吞掉下一条带时间戳的真实错误，也不会保存单行挑战脚本', () => {
  const parser = new api.StderrDiagnostics();
  const row = parser.classify('ERROR rmcp::transport::worker HTTP 403: <html><script>window._cf_chl_opt=PRIVATE</script></html>');
  assert.equal(row.responseKind, 'challenge_page'); assert.equal(row.targetKind, 'mcp_transport');
  parser.classify('ERROR HTTP 502: <html>');
  const next = parser.classify('2026-10-30T02:34:43Z ERROR connection refused');
  assert.equal(next.failureCategory, 'network_or_service');
  assert.equal(parser.classify('ordinary progress'), undefined);
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE|script|_cf_chl/);
});
test('afef 本地发送配置校验失败有落盘证据，修正配置后可继续发送', async t => {
  const f = await capture(t), events = [];
  const p = new api.CodexProcess({ codexPath: '/unused', cwd: process.cwd(), permissionMode: 'default', model: 'chosen', speedMode: 'fast' },
    { emit: event => events.push(event), onPermission() {}, onSessionId() {}, onClose() {} });
  t.after(() => p.dispose()); p.sessionId = 'thread'; p.modelsLoaded = true;
  assert.equal(p.sendUserMessage('PRIVATE_BODY'), true); await p.startingTurn;
  assert.equal(p.isBusy, false); assert.ok(f.rows.some(row => row.operation === 'turn.dispatch' && row.stage === 'failed'));
  p.setSpeedMode('default'); p.rpc.request = async () => ({ turn: { id: 'next' } });
  assert.equal(p.sendUserMessage('PRIVATE_BODY'), true); await p.startingTurn;
  assert.ok(f.rows.some(row => row.operation === 'turn.configuration' && row.stage === 'dispatched' && row.serviceTier === 'default'));
  assert.doesNotMatch(JSON.stringify(f.rows), /PRIVATE_BODY/);
  assert.ok((await f.scan()).findings.some(row => /turn.dispatch/.test(row.evidence)));
});
test('afef 问题持久化失败不展示可用问题卡片，错误落盘并被诊断检出', async t => {
  const f = await capture(t); let shown = 0;
  const p = new api.CodexProcess({ codexPath: '/unused', cwd: process.cwd(), permissionMode: 'default' },
    { emit() {}, onPermission() { shown++; }, onSessionId() {}, onClose() {} });
  t.after(() => p.dispose()); p.sessionId = 'thread'; p.busy = true;
  p.pausedQuestion = { turnId: 'turn', ready: false, request: { requestId: 'q', input: { questions: [] } } };
  p.saveQuestion = () => { throw Object.assign(new Error('PRIVATE_BODY'), { code: 'EACCES' }); };
  p.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } });
  assert.equal(shown, 0); assert.equal(p.isBusy, false);
  const error = f.rows.find(row => row.operation === 'question.persist');
  assert.equal(error.stage, 'failed'); assert.equal(error.errorCode, 'EACCES'); assert.ok(error.failureId);
  assert.doesNotMatch(JSON.stringify(f.rows), /PRIVATE_BODY/);
  assert.ok((await f.scan()).findings.some(row => /question.persist/.test(row.evidence)));
});
test('afef 停止确认超时记录插件超时层级，释放 busy 且终态唯一', async t => {
  const f = await capture(t), events = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = new api.CodexProcess({ codexPath: '/unused', cwd: process.cwd(), permissionMode: 'default' },
    { emit: event => events.push(event), onPermission() {}, onSessionId() {}, onClose() {} });
  t.after(() => p.dispose()); p.sessionId = 'thread'; p.turnId = 'turn'; p.busy = true;
  p.rpc.request = () => new Promise(() => {});
  const stopping = p.interrupt(); t.mock.timers.tick(10000); await stopping;
  assert.equal(p.isBusy, false); assert.equal(p.isExited, true);
  const failure = f.rows.find(row => row.operation === 'turn.interrupt');
  assert.equal(failure.failureCategory, 'timeout'); assert.equal(failure.errorOrigin, 'timeout');
  assert.equal(failure.phase, 'await_stop_confirmation'); assert.equal(failure.timeoutMs, 10000);
  assert.equal(events.filter(event => event.kind === 'result').length, 1);
  t.mock.timers.reset(); assert.ok((await f.scan()).findings.some(row => /turn.interrupt/.test(row.evidence)));
});
test('afef 未闭合 HTML 不吞无时间戳独立异常，孤立 HTML 有安全分类且上下文有界', () => {
  for (const failure of ['TypeError: PRIVATE_BODY', 'ERROR connection refused', 'panic: PRIVATE_BODY']) {
    const parser = new api.StderrDiagnostics(); parser.classify('ERROR HTTP 403: <html>');
    const row = parser.classify(failure); assert.ok(row); assert.equal(row.severity, 'error');
    assert.notEqual(row.event, 'upstream_response_body');
  }
  const parser = new api.StderrDiagnostics();
  const orphan = parser.classify('<div id="challenge-error-text">PRIVATE_BODY</div>');
  assert.equal(orphan.event, 'upstream_response_body'); assert.equal(orphan.responseKind, 'challenge_page');
  assert.doesNotMatch(JSON.stringify(orphan), /PRIVATE|challenge-error-text/);
  parser.classify('ERROR HTTP 403: <html>');
  for (let i = 0; i < 8; i++) assert.equal(parser.classify('<div>PRIVATE_BODY</div>'), undefined);
  assert.equal(parser.classify('<div>PRIVATE_BODY</div>').event, 'upstream_response_body');
});
