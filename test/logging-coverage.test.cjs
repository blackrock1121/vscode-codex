const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { scanSource, buildLogAudit, logAuditPlugin } = require('../scripts/log-audit.cjs');
const { auditLoggingCoverage, checkLoggingConfiguration } = require('../dist/test/diagnostics/loggingAudit.js');
const { scanPluginLogs } = require('../dist/test/diagnostics/scan.js');
const { workerRunner, DiagnosticJobs, diagnosticRepairPrompt } = require('../dist/test/diagnostics/jobs.js');
const { diagnosticModelPrompt } = require('../dist/test/diagnostics/model.js');

test('源码规则在故障未发生时发现静默错误、Promise 吞错、委派处理和操作分支', () => {
  const source = `async function load() { try { return await readFile('data'); } catch { return []; } }
async function hidden() { await fetch('/api').catch(() => undefined); }
async function propagated() { try { await request(); } catch (e) { throw e; } }
function delegated() { return request().then(undefined, handleFailure); }
async function branches(ok) { if(ok) { output.appendLine('ok'); } else { await request(); } }
function pure(x) { return x * 2; }
async function recorded() { try { await request(); output.appendLine('done'); } catch(e) { output.appendLine('failed'); } }`;
  const result = scanSource('src/example.ts', source);
  assert.equal(result.catches, 5);
  assert.ok(result.candidates.some(c => c.kind === 'catch-unlogged' && c.line === 1));
  assert.ok(result.candidates.some(c => c.kind === 'catch-unlogged' && c.line === 2));
  assert.ok(result.candidates.some(c => c.kind === 'error-propagated' && c.line === 3));
  assert.ok(result.candidates.some(c => c.kind === 'handler-delegated' && c.line === 4));
  assert.ok(result.candidates.some(c => c.kind === 'branch-unlogged' && c.line === 5));
  assert.equal(result.candidates.some(c => c.line === 6 || c.line === 7), false);
});

test('注释、字符串和未调用的嵌套函数不能掩盖漏记错误，语法损坏必须令构建失败', () => {
  const result = scanSource('src/example.ts', `async function run() {
    try { await request(); } catch {
      // output.appendLine('error');
      const text = 'logger.error(failure)';
      const later = () => output.appendLine('never called');
      return null;
    }
  }`);
  assert.ok(result.candidates.some(c => c.kind === 'catch-unlogged'));
  assert.ok(result.candidates.some(c => c.kind === 'operation-unlogged'));
  assert.throws(() => scanSource('src/broken.ts', 'function broken( {'), /无法解析 src\/broken.ts:/);
});

test('命令入口委派和控制台报错不等于文件日志已经覆盖', () => {
  const result = scanSource('src/entry.ts', `commands.registerCommand('login', () => provider.login());
rpc.on('error', handleError);
panel.onDidReceiveMessage(message => dispatch(message));
async function run() { try { await request(); } catch (e) { console.error(e); ui.error(e); } }`);
  assert.equal(result.candidates.filter(c => c.kind === 'entry-unlogged').length, 3);
  assert.ok(result.candidates.some(c => c.kind === 'catch-unlogged'));
  assert.equal(result.logSites, 0);
});

test('构建审查清单有源码位置与指纹，源码变化会更新，即使版本不变', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-audit-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src')); await fs.mkdir(path.join(root, 'native'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await fs.writeFile(path.join(root, 'src', 'feature.ts'), 'async function run() { await fetch("private-body"); }');
  await fs.writeFile(path.join(root, 'src', 'loggingAuditData.ts'), 'export default undefined;');
  await fs.writeFile(path.join(root, 'native', 'helper.swift'), 'import Foundation');
  const before = buildLogAudit(root);
  assert.equal(before.manifest.version, '1.2.3');
  assert.deepEqual(before.manifest.unsupported, ['native/helper.swift']);
  assert.doesNotMatch(JSON.stringify(before.manifest), /private-body/);
  const ctx = await require('esbuild').context({ entryPoints: [path.join(root, 'src', 'loggingAuditData.ts')],
    bundle: true, format: 'cjs', write: false, plugins: [logAuditPlugin(root)] });
  t.after(() => ctx.dispose());
  assert.match((await ctx.rebuild()).outputFiles[0].text, /operation-unlogged/);
  await fs.writeFile(path.join(root, 'src', 'feature.ts'), 'async function run() { await fetch("private-body"); output.appendLine("done"); }');
  const after = buildLogAudit(root);
  assert.notEqual(before.manifest.sourceHash, after.manifest.sourceHash);
  assert.doesNotMatch((await ctx.rebuild()).outputFiles[0].text, /operation-unlogged/);
});

test('空日志也会报告源码覆盖缺口，全面诊断保留性能检查，速度模式不混入源码审查', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-audit-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const request = { kind: 'general', engine: 'rules', hours: 24, fromMs: Date.now() - 86400000, toMs: Date.now() };
  const progress = [], result = await scanPluginLogs(root, message => progress.push(message), request);
  assert.ok(result.loggingAudit.files > 0);
  assert.equal(result.loggingAudit.version, require('../package.json').version);
  assert.ok(result.findings.some(f => f.id.startsWith('logging-source-')));
  assert.ok(result.findings.some(f => f.id === 'logging-no-runtime-evidence'));
  assert.equal(result.general.errors, 0);
  assert.match(result.report, /源码日志覆盖审查/); assert.match(result.report, /Codex 速度诊断/);
  assert.match(progress[0], /没有运行记录/);
  assert.equal((await scanPluginLogs(root, () => {}, { ...request, kind: 'performance' })).loggingAudit, undefined);
  // 通过正式打包的后台线程验证清单真的嵌入发布产物，而非测试环境才能获取。
  const worker = await workerRunner(path.resolve('dist/diagnostics-worker.js'), root)(() => {}, new AbortController().signal, request);
  assert.deepEqual(worker.loggingAudit, result.loggingAudit);
});

test('未提供清单和不支持的组件显式显示覆盖未知，未命中规则不保证日志完整', () => {
  const missing = auditLoggingCoverage({ schema: 1, files: [], unsupported: [] });
  assert.equal(missing.loggingAudit.status, 'unavailable');
  assert.equal(missing.findings[0].id, 'logging-audit-unavailable');
  const complete = auditLoggingCoverage({ schema: 1, version: 'test', sourceHash: 'hash',
    files: [scanSource('src/math.ts', 'function add(a, b) { return a + b; }')], unsupported: [] });
  assert.equal(complete.loggingAudit.status, 'no-candidates');
  assert.match(complete.report, /没有候选项也不等于所有功能均已覆盖/);
  assert.equal(complete.findings.length, 0);
  const unsupported = auditLoggingCoverage({ schema: 1, version: 'test', sourceHash: 'hash',
    files: [scanSource('src/math.ts', 'const n = 1;')], unsupported: ['native/helper.swift'] });
  assert.equal(unsupported.loggingAudit.status, 'review-required');
  assert.ok(unsupported.findings.some(f => f.id === 'logging-source-unsupported'));
});

test('详细采集关闭时明确报告配置缺口，不假定全部窗口均已关闭', () => {
  const output = { findings: [], report: '原始证据' };
  assert.equal(checkLoggingConfiguration(output, true), output);
  const result = checkLoggingConfiguration(output, false);
  assert.equal(result.findings[0].id, 'logging-transport-disabled');
  assert.match(result.findings[0].evidence, /不代表其他窗口或已有连接/);
  assert.match(result.report, /原始证据/);
  assert.equal(output.findings.length, 0);
});

test('源码覆盖结果持久化，模型和修复会话无需运行报错即可处理缺日志线索', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-audit-record-'));
  const audit = auditLoggingCoverage({ schema: 1, version: 'test', sourceHash: 'hash',
    files: [scanSource('src/missing.ts', 'async function run() { try { await request(); } catch {} }')], unsupported: [] });
  const result = { ...audit, sourceNote: '空日志', summary: { turns: 0, tools: 0, failures: 0, longestTurnMs: 0, versions: [] } };
  const jobs = new DiagnosticJobs(root, { pluginVersion: 'test', workspaceId: 'source', workspaceName: '源码', windowId: 'w' },
    async () => result, async () => ({ status: 'not_configured' }));
  t.after(async () => { await jobs.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const record = await jobs.start({ kind: 'general', hours: 24, engine: 'rules' });
  const saved = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { jobs.off('changed', check); reject(new Error('保存诊断超时')); }, 5000);
    const check = async () => { try { const value = await jobs.get(record.id); if (value.status === 'completed') {
      clearTimeout(timer); jobs.off('changed', check); resolve(value);
    } } catch (error) { clearTimeout(timer); jobs.off('changed', check); reject(error); } };
    jobs.on('changed', check); void check();
  });
  assert.deepEqual(saved.loggingAudit, result.loggingAudit);
  assert.match(await jobs.report(record.id), /src\/missing.ts:1/);
  const prompt = diagnosticModelPrompt(result);
  assert.match(prompt, /即使没有运行错误记录/);
  assert.match(prompt, /logging-source-src\/missing.ts/);
  assert.match(diagnosticRepairPrompt(saved, result.report), /不要因为没有运行错误记录就忽略/);
  assert.match(diagnosticRepairPrompt(saved, 'x'.repeat(60001), '/tmp/audit.report.md'), /完整报告文件："\/tmp\/audit.report.md"/);
});

test('正则 exec 与直接哈希 update 是纯计算，未知同名调用仍保留覆盖候选',()=>{
 const pure=scanSource('src/pure.ts',`function parse(s){return /x/.exec(s)} function hash(s){return createHash('sha256').update(s).digest('hex')}`);
 assert.equal(pure.operations,0);assert.equal(pure.candidates.length,0);
 const unknown=scanSource('src/unknown.ts',`function run(){return client.exec('x')} function save(){store.update('x')}`);
 assert.equal(unknown.operations,2);assert.equal(unknown.candidates.length,2);
});
