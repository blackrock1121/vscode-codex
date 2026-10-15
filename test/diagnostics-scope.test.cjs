const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { scanPluginLogs } = require('../dist/test/diagnostics/scan.js');
const { DiagnosticJobs } = require('../dist/test/diagnostics/jobs.js');
const { notifyDiagnostic } = require('../dist/test/diagnostics/notification.js');
async function dir(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-full-scan-'));
 t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const line = (row, version = '0.1.129', window = 'window-a') => `[pluginVersion=${version} windowId=${window} hostId=123] [perf] ${JSON.stringify(row)}\n`;

test('全局扫描覆盖三个文件以外和四 MiB 以外的证据，全量统计不受四十条展示限制', async t => {
 const root = await dir(t);
 const oldest = line({ event: 'span_end', kind: 'bash', traceId: 'old-task', threadId: 'session-0', outcome: 'failed', failureCategory: 'missing_dependency', durationMs: 20000, atMs: 1700000000000 }, '0.1.120');
 const turns = Array.from({ length: 60 }, (_, i) => line({ event: 'turn_summary', threadId: 'session-0', traceId: `old-${i}`, elapsedMs: 100 + i, phasesMs: {}, atMs: 1700000000000 + i }, '0.1.120')).join('');
 await fs.writeFile(path.join(root, 'codex-chat-2026-10-11.log'), oldest + turns + ('ordinary ' + 'x'.repeat(128) + '\n').repeat(40000));
 for (let day = 12; day <= 15; day++) await fs.writeFile(path.join(root, `codex-chat-2026-10-${day}.log`), line({ event: 'turn_summary', traceId: `new-${day}`, threadId: `session-${day}`, elapsedMs: 1000 + day, phasesMs: {}, atMs: 1700000000100 + day }, '0.1.129', 'window-b'));
 const result = await scanPluginLogs(root);
 assert.equal(result.coverage.files, 5); assert.equal(result.coverage.readFiles, 5); assert.equal(result.coverage.unreadableFiles, 0);
 assert.ok(result.coverage.bytes > 4 * 1048576); assert.equal(result.coverage.windows, 2); assert.equal(result.coverage.sessions, 5);
 assert.equal(result.summary.turns, 64); assert.equal(result.summary.tools, 1); assert.equal(result.summary.failures, 1);
 assert.equal(result.coverage.records, 65); assert.deepEqual(result.summary.versions, ['0.1.120', '0.1.129']);
 assert.equal(result.coverage.sources.find(s => s.pluginVersion === '0.1.120').turns, 60);
 assert.equal(result.coverage.sources.find(s => s.pluginVersion === '0.1.129').turns, 4);
 assert.ok(result.findings.some(f => f.id === 'failure-missing_dependency' && f.traceIds.includes('old-task')));
 assert.match(result.report, /64 轮任务/); assert.match(result.report, /0\.1\.120/); assert.match(result.sourceNote, /不按工作区或会话过滤/);
 assert.ok(Buffer.byteLength(result.report) < 200000);
});

test('读取开始时的长度快照，忽略中途追加，损坏、超长和采集丢弃均显示缺口', async t => {
 const root = await dir(t), file = path.join(root, 'codex-chat-2026-10-15.log');
 await fs.writeFile(file, '[perf] {broken}\n' + 'x'.repeat(150000) + '\n[logging] droppedLines=7 reason=buffer_or_write_limit\n' + line({ event: 'turn_summary', traceId: 'ok', elapsedMs: 100, phasesMs: {} }) + line({ event: 'heartbeat', traceId: 'invalid-date', atMs: 'bad', elapsedMs: 10 }));
 const initialSize = (await fs.stat(file)).size;
 const result = await scanPluginLogs(root, () => syncFs.appendFileSync(file, line({ event: 'turn_summary', traceId: 'next-scan', elapsedMs: 100, phasesMs: {} })));
 assert.equal(result.summary.turns, 1); assert.equal(result.coverage.bytes, initialSize);
 assert.equal(result.coverage.invalidLines, 1); assert.equal(result.coverage.oversizedLines, 1); assert.equal(result.coverage.droppedLines, 7);
 assert.ok(result.findings.some(f => f.id === 'log-coverage')); assert.match(result.report, /记录时间 未记录/);
 assert.equal((await scanPluginLogs(root)).summary.turns, 2);
});

test('空日志明确没有证据，不扫描别的文件', async t => {
 const root = await dir(t); await fs.writeFile(path.join(root, 'other.log'), line({ event: 'turn_summary' }));
 const result = await scanPluginLogs(root); assert.equal(result.coverage.files, 0); assert.equal(result.coverage.records, 0);
 assert.equal(result.findings.length, 0); assert.match(result.report, /其他机器/);
});

test('全局诊断可从其他源码工作区创建修复会话，结果持久化并通知覆盖范围', async t => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-full-scan-'));
 const coverage = { mode: 'local-plugin-full', windows: 3, sessions: 8, files: 7, readFiles: 7, records: 100, sources: [] };
 const output = { report: '# 全局证据', sourceNote: '全部日志', coverage, findings: [{ id: 'slow', title: '慢', severity: 'warning', evidence: '证据', recommendation: '检查', traceIds: [] }], summary: { turns: 50, tools: 100, failures: 1, longestTurnMs: 50000, versions: ['0.1.128'] } };
 const make = workspaceId => new DiagnosticJobs(root, { workspaceId, workspaceName: workspaceId, windowId: workspaceId, pluginVersion: '0.1.129' }, async () => output, async () => ({ status: 'sent' }));
 const origin = make('business'), source = make('plugin-source'); t.after(async () => { await origin.dispose(); await source.dispose(); await fs.rm(root, { recursive: true, force: true }); });
 const running = await origin.start();
 const record = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { origin.off('changed', check); reject(new Error('诊断未完成')); }, 5000);
  const check = () => { void origin.get(running.id).then(row => { if (row.status === 'completed') { clearTimeout(timer); origin.off('changed', check); resolve(row); } }, reject); };
  origin.on('changed', check); check();
 });
 assert.equal(record.status, 'completed'); assert.deepEqual(record.coverage, coverage);
 let prompt;
 await source.repair(record.id, async text => { prompt = text; return 'repair-global'; }, async () => {});
 assert.match(prompt, /本机整个 vscode-codex 插件/); assert.match(prompt, /不能把无关业务项目当作插件修改/);
 assert.equal((await source.get(record.id)).repair.workspaceId, 'plugin-source');
 await assert.rejects(origin.repair(record.id, async () => 'wrong', async () => {}), /已有修复会话所属工作区/);
 assert.equal((await source.get(record.id)).repair.sessionId, 'repair-global');
 let notification;
 await notifyDiagnostic(record, 'https://open.feishu.cn/open-apis/bot/v2/hook/test', async (_url, options) => { notification = JSON.parse(options.body).content.text; return { ok: true, json: async () => ({ code: 0 }) }; });
 assert.match(notification, /本机整个插件/); assert.match(notification, /3 个窗口、8 个会话/);
});
