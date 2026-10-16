const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {scanPluginLogs}=require('../dist/test/diagnostics/scan.js');
const {classifyIncident}=require('../dist/test/diagnostics/general.js');
const {diagnosticModelPrompt}=require('../dist/test/diagnostics/model.js');
const {failureCategory}=require('../dist/test/codex/performanceTrace.js');

const at=Date.parse('2026-10-16T06:13:09.356Z');
test('源码和配置中的 timeout 字段不冒充真实超时，保留非零退出和真实超时证据',()=>{
 for(const text of ["const categories = ['permission', 'timeout', 'rate_limit'];",'timeout: 5000','--timeout=20','{"timeout":60000}','function timeout() {}'])
  assert.equal(failureCategory(text,1),'nonzero_exit',text);
 for(const text of ['Operation timed out','connection time out','CdpRequestTimeoutError: failed','ETIMEDOUT','Codex 请求超时：thread/read','timeout',' Timeout. '])
  assert.equal(failureCategory(text,1),'timeout',text);
 assert.equal(failureCategory('const timeout=10',124),'timeout');
 assert.equal(failureCategory('KeyboardInterrupt',1),'interrupted');
});
function log(body,version='0.1.139',window='window-new'){
 return `[14:13:09] [pluginVersion=${version} windowId=${window} hostId=123] [${new Date(at).toISOString()}] ${body}\n`;
}
test('识别没有英文 Error 的真实页面循环错误，不吞掉运行时错误也不把普通说明当故障',()=>{
 const incident=classifyIncident('[webview] 聊天面板脚本错误: ResizeObserver loop completed with undelivered notifications. @index.html:0');
 assert.equal(incident.category,'页面脚本');assert.equal(incident.severity,'error');
 assert.equal(classifyIncident('[webview] 运行时错误: 中文异常原因').severity,'error');
 for(const line of ['[status] 正在生成错误分类报告','[status] 错误计数=0','[notify] completed=28 failed=0'])assert.equal(classifyIncident(line),undefined);
});

test('速度与全面诊断均按所有窗口保留页面错误及压缩回退原因，模型获得可关联的脱敏证据',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-8cb-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'codex-chat-2026-10-16.log');
 const content=log('[webview] 聊天面板脚本错误: ResizeObserver loop completed with undelivered notifications. @https://private.invalid/?token=PRIVATE')+
  log('[webview] 聊天面板脚本错误: ResizeObserver loop completed with undelivered notifications.','0.1.136','window-old')+
  log('[compaction_route] '+JSON.stringify({stage:'fallback',reason:'startup_budget_expired',scope:'native'}))+
  log('[perf] '+JSON.stringify({event:'turn_summary',traceId:'long-wait',elapsedMs:70000,phasesMs:{unobserved:70000}}));
 await fs.writeFile(file,content);
 for(const kind of ['performance','general']) {
  const result=await scanPluginLogs(dir,()=>{},{kind,hours:0,engine:'rules',toMs:at+1000});
  assert.equal(result.general.errors,2);assert.equal(result.general.warnings,1);assert.equal(result.summary.turns,1);
  assert.equal(result.summary.failures,0,'页面异常不能冒充工具失败');assert.equal(result.coverage.windows,2);
  assert.ok(result.findings.some(f=>f.category==='页面脚本'&&f.evidence.includes('window-new')));
  assert.ok(result.findings.some(f=>f.id==='phase-unobserved'));
  const prompt=diagnosticModelPrompt(result);assert.match(prompt,/ResizeObserver loop/);assert.match(prompt,/startup_budget_expired/);
  assert.deepEqual(result.compactionEvidence,[{stage:'fallback',reason:'startup_budget_expired',scope:'native',pluginVersion:'0.1.139',windowId:'window-new',logAtMs:at}]);
  assert.match(result.report,/压缩路由与回退/);assert.match(result.report,/startup_budget_expired/);
  assert.match(result.findings.find(f=>f.category==='压缩').evidence,/scope=native/);
  assert.doesNotMatch(prompt+result.report,/private\.invalid|PRIVATE/);
 }
 assert.equal(await fs.readFile(file,'utf8'),content,'诊断不得改写历史原日志');
});

test('压缩证据保留请求与轮次身份；新增原因字段仍脱敏，不复制凭据与 URL',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-8cb-private-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'codex-chat-2026-10-16.log'),log('[compaction_route] '+JSON.stringify({stage:'failed',reason:'token=SECRET https://private.invalid/api',scope:'native',id:'request-1',traceId:'turn-1',threadId:'thread-1',processRunId:'process-1'})));
 const result=await scanPluginLogs(dir);const row=result.compactionEvidence[0];
 assert.equal(row.id,'request-1');assert.equal(row.traceId,'turn-1');assert.equal(row.threadId,'thread-1');assert.equal(row.processRunId,'process-1');
 assert.doesNotMatch(JSON.stringify(result),/SECRET|private\.invalid/);
});
