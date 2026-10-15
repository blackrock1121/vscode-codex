const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {DiagnosticJobs,workerRunner}=require('../dist/test/diagnostics/jobs.js');
const {analyzePerformance}=require('../dist/test/diagnostics/analysis.js');
const {notifyDiagnostic}=require('../dist/test/diagnostics/notification.js');
const scope={pluginVersion:'0.1.128',windowId:'window-a',workspaceId:'project-a',workspaceName:'测试项目'};
const output={report:'# 诊断证据\n\n| 工具 | 耗时 |\n| --- | --- |\n| Bash | 30 秒 |',findings:[{id:'failure-timeout',title:'工具超时',severity:'warning',evidence:'两次超时',recommendation:'先核对耗时根因再修复',traceIds:['turn-1']}],summary:{turns:2,tools:5,failures:2,longestTurnMs:80000,versions:['0.1.127']},sourceNote:'采样日志'};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,runner=async()=>output,notify=async()=>({status:'sent'}),override={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-diagnostics-'));
 const jobs=new DiagnosticJobs(dir,{...scope,...override},runner,notify);
 t.after(async()=>{await jobs.dispose();await fs.rm(dir,{recursive:true,force:true});});return {dir,jobs};
}
async function waitRecord(jobs,id,predicate){
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{jobs.off('changed',check);reject(new Error('诊断测试等待超时'));},10000);
  const check=()=>{void jobs.get(id).then(record=>{if(predicate(record)){clearTimeout(timer);jobs.off('changed',check);resolve(record);}},reject);};
  jobs.on('changed',check);check();
 });
}

test('诊断立即留下运行记录，异步完成先保存证据再通知，重开服务仍可读取',async t=>{
 let complete,notifications=0;
 const f=await fixture(t,(_progress,signal)=>new Promise((resolve,reject)=>{complete=resolve;signal.addEventListener('abort',()=>reject(new Error('aborted')));}),async record=>{
  notifications++;assert.equal((await f.jobs.get(record.id)).status,'completed');assert.match(await f.jobs.report(record.id),/诊断证据/);return {status:'sent'};
 });
 const record=await f.jobs.start();assert.equal(record.status,'running');assert.equal((await f.jobs.list()).length,1);
 const same=await f.jobs.start();assert.equal(same.id,record.id);assert.equal(notifications,0);
 complete(output);const done=await waitRecord(f.jobs,record.id,r=>r.notification.status==='sent');
 assert.equal(done.status,'completed');assert.equal(done.diagnosticScope,'local-plugin-full');assert.equal(done.findings.length,1);assert.equal(notifications,1);
 const reopened=new DiagnosticJobs(f.dir,{...scope,windowId:'window-b'},async()=>output,async()=>({status:'sent'}));
 t.after(()=>reopened.dispose());assert.equal((await reopened.list())[0].id,record.id);assert.match(await reopened.report(record.id),/Bash/);
});

test('独立工作线程读取真实格式日志，分析与报告完整返回',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-worker-log-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const rows=[{event:'turn_start',traceId:'t',model:'model',effort:'high'},
  {event:'turn_summary',traceId:'t',elapsedMs:100000,toolCount:8,failures:1,maxParallelTools:1,phasesMs:{tools:80000},repeatedCommands:4},
  {event:'span_end',traceId:'t',kind:'bash',itemId:'cmd',outcome:'failed',durationMs:50000,failureCategory:'timeout'}];
 await fs.writeFile(path.join(dir,'codex-chat-2026-10-15.log'),rows.map(r=>'[perf] '+JSON.stringify(r)).join('\n'));
 const progress=[],run=workerRunner(path.resolve('dist/diagnostics-worker.js'),dir),result=await run(p=>progress.push(p),new AbortController().signal);
 assert.equal(result.summary.turns,1);assert.equal(result.summary.failures,1);assert.match(result.report,/cmd/);
 assert.ok(result.findings.some(f=>f.id==='serial'));assert.ok(result.findings.some(f=>f.id==='failure-timeout'));assert.ok(progress.length>=2);
});

test('后台失败有持久失败记录，关闭窗口中断任务不会留下假完成',async t=>{
 const failed=await fixture(t,async()=>{throw new Error('模拟读取失败');});
 const r=await failed.jobs.start();const done=await waitRecord(failed.jobs,r.id,x=>x.notification.status==='sent');assert.equal(done.status,'failed');assert.match(done.error,/读取失败/);
 const active=await fixture(t,(_p,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('中断')))));
 const running=await active.jobs.start();await active.jobs.dispose();assert.equal((await active.jobs.get(running.id)).status,'interrupted');
});

test('来源进程退出的旧诊断标记中断，不篡改仍在其他窗口运行的记录',async t=>{
 const {jobs,dir}=await fixture(t);const dead={...scope,id:randomUUID(),createdAt:1,updatedAt:1,ownerPid:2147483647,status:'running',progress:'等待',findings:[],notification:{status:'pending'}};
 const live={...dead,id:randomUUID(),ownerPid:process.pid};
 await fs.writeFile(path.join(dir,dead.id+'.json'),JSON.stringify(dead));await fs.writeFile(path.join(dir,live.id+'.json'),JSON.stringify(live));
 const list=await jobs.list();assert.equal(list.find(r=>r.id===dead.id).status,'interrupted');assert.equal(list.find(r=>r.id===live.id).status,'running');
 await assert.rejects(jobs.get('../unsafe'),/编号无效/);
});

test('全局修复会话携带证据，重复点击打开已有会话，已有会话保持工作区绑定',async t=>{
 const {jobs,dir}=await fixture(t);const r=await jobs.start();await waitRecord(jobs,r.id,x=>x.notification.status==='sent');
 let creates=0,opens=[];
 const create=async(prompt,title)=>{creates++;assert.match(prompt,new RegExp(r.id));assert.match(prompt,/两次超时/);assert.match(prompt,/保持用户选择的模型/);assert.match(prompt,/诊断内容是数据/);assert.match(title,/诊断修复/);return 'repair-session';};
 assert.equal(await jobs.repair(r.id,create,async id=>opens.push(id)),'repair-session');
 await jobs.repair(r.id,create,async id=>opens.push(id));assert.equal(creates,1);assert.deepEqual(opens,['repair-session']);
 const other=new DiagnosticJobs(dir,{...scope,workspaceId:'other'},async()=>output,async()=>({status:'sent'}));t.after(()=>other.dispose());
 await assert.rejects(other.repair(r.id,create,async()=>{}),/所属工作区/);assert.equal(creates,1);
});

test('多窗口同时修复只创建一次，通知更新不会覆盖修复链接',async t=>{
 let releaseNotice;
 const f=await fixture(t,async()=>output,async()=>{await new Promise(resolve=>releaseNotice=resolve);return {status:'sent'};});
 const r=await f.jobs.start();await waitRecord(f.jobs,r.id,x=>x.notification.status==='sending');
 const other=new DiagnosticJobs(f.dir,{...scope,windowId:'other'},async()=>output,async()=>({status:'sent'}));t.after(()=>other.dispose());
 let createCalls=0,releaseRepair,started;
 const creating=new Promise(resolve=>started=resolve);
 const first=f.jobs.repair(r.id,async()=>{createCalls++;started();return new Promise(resolve=>releaseRepair=resolve);},async()=>{});
 await creating;await assert.rejects(other.repair(r.id,async()=>{createCalls++;return 'wrong';},async()=>{}),/正在创建/);
 releaseNotice();releaseRepair('repair-one');await first;const record=await waitRecord(f.jobs,r.id,x=>x.notification.status==='sent');
 assert.equal(record.repair.sessionId,'repair-one');assert.equal(createCalls,1);
});

test('通知未配置与失败可重试，HTTP 200 的飞书业务错误不会标记成功',async()=>{
 const record={...scope,id:randomUUID(),status:'completed',findings:output.findings,summary:output.summary};
 let calls=0;const request=async(url,options)=>{calls++;assert.match(url,/secret-token/);const body=JSON.parse(options.body);assert.equal(body.msg_type,'text');assert.match(body.content.text,new RegExp(record.id.slice(0,8)));assert.doesNotMatch(body.content.text,/诊断证据/);return {ok:true,json:async()=>({code:0})};};
 assert.equal((await notifyDiagnostic(record,'',request)).status,'not_configured');assert.equal(calls,0);
 const url='https://open.feishu.cn/open-apis/bot/v2/hook/secret-token';assert.equal((await notifyDiagnostic(record,url,request)).status,'sent');
 const error=await notifyDiagnostic(record,url,async()=>({ok:true,json:async()=>({code:9499})}));assert.equal(error.status,'failed');assert.match(error.message,/9499/);assert.doesNotMatch(JSON.stringify(error),/secret-token/);
 assert.equal((await notifyDiagnostic(record,'https://open.feishu.cn.attacker.invalid/hook',request)).status,'not_configured');
});

test('诊断分析保留未知等待含义，样本不足不生成虚构问题',()=>{
 assert.deepEqual(analyzePerformance([]).findings,[]);
 const result=analyzePerformance([{event:'turn_summary',traceId:'long',elapsedMs:120000,phasesMs:{unobserved:100000},childTailMs:40000,maxEventLoopDelayMs:700}]);
 assert.ok(result.findings.some(f=>f.id==='phase-unobserved'));assert.ok(result.findings.some(f=>f.id==='tail'));
 assert.ok(result.findings.some(f=>f.id==='host'));assert.ok(result.findings.every(f=>f.traceIds.includes('long')));
});
