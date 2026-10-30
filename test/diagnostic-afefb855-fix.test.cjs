const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const Module=require('node:module'),load=Module._load;
let api;try{Module._load=function(name,...args){return name==='vscode'?{window:{},workspace:{}}:load.call(this,name,...args);};api=require('../dist/test/diagnostic-safety.js');}finally{Module._load=load;}
const {GeneralAccumulator}=require('../dist/test/diagnostics/general.js');
const scope={pluginVersion:'0.1.188',windowId:'test',workspaceId:'test',workspaceName:'测试'};
const output={report:'本地证据',findings:[],summary:{turns:0,tools:0,failures:0,longestTurnMs:0,versions:[]},sourceNote:'测试'};
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-afefb855-')),logs=path.join(dir,'logs'),rows=[];
 const writer=new api.DailyLogWriter(logs,{pluginVersion:scope.pluginVersion,windowId:'test',hostId:'test'},undefined,()=>{});
 api.setOperationLogSink(line=>{rows.push(JSON.parse(line.slice('[operation] '.length)));writer.write(line);});
 t.after(async()=>{api.setOperationLogSink();await writer.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,rows,scan:async()=>{await writer.flush();await writer.flush();return api.scanPluginLogs(logs,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()+1000});}};
}
test('afefb855 历史 HTTP HTML 续行只与同进程紧邻响应关联，正文不进入报告',()=>{
 const a=new GeneralAccumulator(),processRunId=randomUUID();
 const add=(message,line,extra={},time=1000+line)=>a.add('',{type:'runtime_error',severity:'error',processRunId,message,...extra},{file:'day',line,atMs:time,windowId:'w',pluginVersion:'old'});
 add('rmcp::transport::worker worker quit with fatal: HTTP 403: <html>PRIVATE_TOKEN',1);
 add('  <div id="challenge-error-text">PRIVATE_TOKEN Enable JavaScript and cookies</div>',2);
 add('TypeError unrelated',3);
 const r=a.result();assert.equal(r.summary.errors,2);assert.equal(r.summary.transportResponseLines,1);
 assert.match(r.report,/上游 HTTP 访问受阻/);assert.doesNotMatch(r.report,/PRIVATE_TOKEN|Enable JavaScript/);
 add('<div>error other process</div>',4,{processRunId:randomUUID()});
 add('<div>error too late</div>',5,{},5000);
 assert.equal(a.result().summary.errors,4,'不可跨进程或长间隔隐藏其它错误');
});
test('afefb855 工作线程错误在写盘和全面扫描中共享同一失败链，保留权限错误码',async t=>{
 const f=await fixture(t),failureId=randomUUID(),worker=path.join(f.dir,'worker.cjs');
 fs.writeFileSync(worker,`require('node:worker_threads').parentPort.postMessage({type:'error',fields:{failureId:${JSON.stringify(failureId)},errorCode:'EACCES'},message:'PRIVATE_TOKEN'});`);
 const jobs=new api.DiagnosticJobs(path.join(f.dir,'jobs'),scope,api.workerRunner(worker,f.dir),async()=>({status:'not_configured'}));
 const record=await jobs.start();await Promise.all([...jobs.tasks]);
 const saved=await jobs.get(record.id);assert.equal(saved.status,'failed');assert.doesNotMatch(saved.error,/PRIVATE_TOKEN/);
 const failures=f.rows.filter(r=>r.stage==='failed'&&['diagnostics.worker','diagnostics.execute'].includes(r.operation));
 assert.equal(failures.length,2);assert.ok(failures.every(r=>r.failureId===failureId&&r.errorCode==='EACCES'));
 const scanned=await f.scan();assert.equal(scanned.general.failureChains,1);assert.ok(scanned.findings.some(r=>r.evidence.includes('EACCES')));
 await jobs.dispose();
});
for(const mode of ['timeout','exit','cancel','success'])test(`afefb855 工作线程 ${mode} 唯一终态并释放等待`,async t=>{
 const f=await fixture(t),worker=path.join(f.dir,'worker.cjs'),controller=new AbortController();
 fs.writeFileSync(worker,mode==='success'?`require('node:worker_threads').parentPort.postMessage({type:'result',result:${JSON.stringify(output)}});`:mode==='exit'?'process.exit(3);':'setInterval(()=>{},1000);');
 const work=api.workerRunner(worker,f.dir,mode==='timeout'?50:2000)(()=>{},controller.signal);
 if(mode==='cancel')controller.abort();
 if(mode==='success')assert.equal((await work).report,output.report);
 else await assert.rejects(work,e=>mode==='timeout'?e.code==='ETIMEDOUT':mode==='exit'?e.code==='ERR_WORKER_PREMATURE_EXIT':e.name==='AbortError');
 const terminal=f.rows.filter(r=>r.operation==='diagnostics.worker'&&r.stage!=='start');assert.equal(terminal.length,1);
 assert.equal(terminal[0].stage,mode==='cancel'?'cancelled':mode==='success'?'completed':'failed');
 const scanned=await f.scan();assert.equal(scanned.general.errors,mode==='success'||mode==='cancel'?0:1);
});
test('afefb855 年度日历失败与恢复可关联，不泄露异常正文',async t=>{
 const f=await fixture(t),lines=[];let fail=true;
 const calendar=new api.WorkdayCalendar(path.join(f.dir,'calendar'),line=>lines.push(line),()=>{},async url=>{
  if(fail)throw Object.assign(new Error('PRIVATE_TOKEN https://secret.invalid/?token=PRIVATE_TOKEN'),{code:'ECONNRESET'});
  const year=Number(url.match(/(\d{4})\.json$/)[1]);return {ok:true,text:async()=>JSON.stringify({year,papers:[],days:[]})};
 });t.after(()=>calendar.dispose());
 await calendar.refresh(true,new Date('2026-10-30T00:00:00Z'));fail=false;await calendar.refresh(true,new Date('2026-10-30T00:00:01Z'));
 assert.equal(f.rows.filter(r=>r.operation==='calendar.update'&&r.stage==='failed').length,2);
 assert.equal(f.rows.filter(r=>r.operation==='calendar.update'&&r.stage==='recovered').length,2);
 const scan=await f.scan();assert.equal(scan.general.linkedRecoveries,2);assert.doesNotMatch(JSON.stringify([f.rows,lines,scan]),/PRIVATE_TOKEN/);
});
test('afefb855 诊断页面未处理拒绝保留类别并落盘，拒绝携带任意正文',async t=>{
 const f=await fixture(t),jobs=new (require('node:events').EventEmitter)();
 const page=new api.DiagnosticsPage({},jobs,async()=>{},async()=>{});t.after(()=>page.dispose());
 await page.message({type:'webviewError',category:'webview.unhandledrejection: TypeError'});
 await page.message({type:'webviewError',category:'PRIVATE_TOKEN'});
 assert.equal(f.rows[0].errorType,'TypeError');assert.equal(f.rows[0].phase,'webview.unhandledrejection');
 assert.equal(f.rows[1].phase,'webview.runtime');assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN/);
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('webview.unhandledrejection')));
});
test('afefb855 长修复提示保留全部问题与完整报告入口，省掉重复 60000 字符',()=>{
 const record={...scope,id:randomUUID(),createdAt:Date.now(),diagnosticScope:'local-plugin-full',findings:[{id:'late',title:'必须核验',evidence:'完整证据',recommendation:'验证恢复',traceIds:[]}],options:{kind:'general',engine:'rules'}};
 const report='重复正文'.repeat(20000)+'最终覆盖位置';
 const prompt=api.diagnosticRepairPrompt(record,report,'/tmp/full report.md');
 assert.match(prompt,/完整证据/);assert.match(prompt,/全部源码覆盖位置/);assert.match(prompt,/full report.md/);assert.doesNotMatch(prompt,/重复正文/);
 assert.ok(prompt.length<3000);
 const fallback=api.diagnosticRepairPrompt(record,report);assert.match(fallback,/重复正文/);assert.match(fallback,/60000/);
 assert.match(api.diagnosticRepairPrompt(record,'短报告','/tmp/report.md'),/短报告/);
});
