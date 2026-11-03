const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {DiagnosticLedger}=require('../dist/test/diagnostics/ledger.js');
const {DiagnosticJobs}=require('../dist/test/diagnostics/jobs.js');
const {GeneralAccumulator}=require('../dist/test/diagnostics/general.js');
const {scanPluginLogs}=require('../dist/test/diagnostics/scan.js');
const {findingCount}=require('../dist/test/diagnostics/tracking.js');
const now=Date.now();
const finding=(key='timeout',at=now-10000,version='0.1.197')=>({id:key,fingerprint:`test-v1:${key}`,title:key,severity:'warning',evidence:'测试日志',recommendation:'复验',traceIds:[],observations:[{version,firstAt:at,lastAt:at,count:1}]});
const record=(findings=[finding()],createdAt=now)=>({id:randomUUID(),status:'completed',trackingSchema:1,createdAt,updatedAt:createdAt,pluginVersion:'0.1.197',workspaceId:'a',workspaceName:'A',windowId:'a',findings,notification:{status:'sent'}});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'diagnostic-ledger-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,ledger:new DiagnosticLedger(dir)};}
async function receipt(ledger,r,b,results,revision=1,extra={}){await fs.writeFile(ledger.receiptPath(b.batchId),JSON.stringify({schema:1,diagnosticId:r.id,batchId:b.batchId,revision,results,...extra}));return (await ledger.sync([r])).get(r.id);}
async function begin(ledger,r){const b=await ledger.begin(r);await ledger.bind(b.batchId,'session-a');return b;}

test('同类错误中的时间戳不再拆组，事件次数与不同HTTP错误保留',()=>{
 const a=new GeneralAccumulator();
 for(let n=0;n<3;n++) a.add('',{type:'runtime_error',message:`2026-11-03T06:00:0${n}.123456Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out`},{file:'codex-chat-2026-11-03.log',line:n+1,atMs:now+n,pluginVersion:'0.1.197'});
 const result=a.result();assert.equal(result.findings.length,1);assert.equal(result.findings[0].occurrences,3);assert.equal(result.findings[0].observations[0].lastAt,now+2);
 a.add('',{type:'runtime_error',event:'upstream_http_error',httpStatusCode:403,targetKind:'mcp_transport'},{file:'a',line:4});
 a.add('',{type:'runtime_error',event:'upstream_http_error',httpStatusCode:503,targetKind:'mcp_transport'},{file:'a',line:5});
 assert.equal(a.result().findings.length,3);
});

test('重叠扫描复用问题，模型解释不另计；历史修复会话不自动销项',async t=>{
 const {ledger}=await fixture(t),r=record([finding(),{...finding('model-1'),origin:'model'}]);
 const first=(await ledger.sync([r])).get(r.id);assert.equal(first.issues.length,1);assert.equal(first.modelCount,1);assert.equal(findingCount(r.findings),1);
 const next=record([finding()],now+100);const view=(await ledger.sync([next])).get(next.id);
 assert.equal(view.issues[0].id,first.issues[0].id);assert.equal(view.issues[0].relation,'historical');
 const legacy={...record([{...finding(),fingerprint:undefined}]),trackingSchema:undefined,repair:{status:'started',sessionId:'old'}};
 const old=(await ledger.sync([legacy])).get(legacy.id);assert.equal(old.legacy,true);assert.equal(old.issues[0].state,'open');assert.notEqual(old.issues[0].id,first.issues[0].id);
});

test('两个窗口不能重复分配同一问题；重启后仍能读取批次与处理状态',async t=>{
 const {ledger,dir}=await fixture(t),other=new DiagnosticLedger(dir),r=record(),r2=record();
 const values=await Promise.allSettled([ledger.begin(r),other.begin(r2)]);
 assert.equal(values.filter(v=>v.status==='fulfilled').length,1);assert.equal(values.filter(v=>v.status==='rejected').length,1);
 const views=await new DiagnosticLedger(dir).sync([r,r2]);assert.equal(views.get(r.id).issues[0].state,'repairing');
});

test('部分回写保留未完成项，提交与测试不等于运行验证通过，重复回写幂等',async t=>{
 const {ledger}=await fixture(t),r=record([finding('a'),finding('b')]),batch=await begin(ledger,r);
 let v=(await ledger.sync([r])).get(r.id),id=v.issues[0].id;
 const fixed={issueId:id,outcome:'fixed',reason:'修复状态释放',version:'0.1.198',commit:'abcdef0',tests:'node --test：通过'};
 v=await receipt(ledger,r,batch,[fixed]);assert.equal(v.issues[0].state,'awaiting_verification');assert.equal(v.issues[1].state,'repairing');assert.equal(v.batch.reported,1);
 const count=v.issues[0].history.length;v=(await ledger.sync([r])).get(r.id);assert.equal(v.issues[0].history.length,count);
 v=await receipt(ledger,r,batch,[{...fixed,verification:{outcome:'passed',at:Date.now(),version:'0.1.198',scenario:'新版本失败后再次发送',evidence:'操作成功，日志 trace-a'}}],2);
 assert.equal(v.issues[0].state,'verified');assert.equal(v.issues[1].state,'repairing');
});

test('越界、缺证据和错误批次整批拒绝，不部分修改；旧revision不能倒退状态',async t=>{
 const {ledger}=await fixture(t),r=record(),b=await begin(ledger,r),id=(await ledger.sync([r])).get(r.id).issues[0].id;
 let v=await receipt(ledger,r,b,[{issueId:id,outcome:'fixed',reason:'已改'}]);assert.match(v.batch.error,/版本、提交和测试/);assert.equal(v.issues[0].state,'repairing');
 v=await receipt(ledger,r,b,[{issueId:'other',outcome:'not_a_bug',reason:'跳过'}]);assert.match(v.batch.error,/越界/);assert.equal(v.issues[0].state,'repairing');
 v=await receipt(ledger,r,b,[{issueId:id,outcome:'external',reason:'上游限流'}],2);assert.equal(v.issues[0].state,'external');
 v=await receipt(ledger,r,b,[{issueId:id,outcome:'not_a_bug',reason:'旧结果'}],1);assert.equal(v.issues[0].state,'external');
 v=await receipt(ledger,r,b,[],3,{diagnosticId:randomUUID()});assert.match(v.batch.error,/不匹配/);assert.equal(v.issues[0].state,'external');
});

test('释放未完成批次后可重试，迟到旧批次不能覆盖新会话',async t=>{
 const {ledger}=await fixture(t),r=record(),b=await begin(ledger,r),id=(await ledger.sync([r])).get(r.id).issues[0].id;
 await ledger.cancel(b.batchId);const next=await begin(ledger,r);
 const v=await receipt(ledger,r,b,[{issueId:id,outcome:'not_a_bug',reason:'迟到旧结果'}]);
 assert.equal(v.issues[0].latestBatchId,next.batchId);assert.equal(v.issues[0].state,'repairing');
});

test('只有目标修复版本的新事件触发再次发现；旧日志和无样本不自动通过',async t=>{
 const {ledger}=await fixture(t),r=record(),b=await begin(ledger,r),id=(await ledger.sync([r])).get(r.id).issues[0].id;
 await receipt(ledger,r,b,[{issueId:id,outcome:'fixed',reason:'修复',version:'0.1.198',commit:'abcdef0',tests:'测试通过'}]);
 const after=Date.now()+1000,old=record([finding('timeout',after,'0.1.197')],after),empty=record([],after+1);
 let views=await ledger.sync([old,empty]);assert.equal(views.get(old.id).issues[0].state,'awaiting_verification');
 const fresh=record([finding('timeout',after+2,'0.1.198')],after+3);views=await ledger.sync([fresh]);assert.equal(views.get(fresh.id).issues[0].state,'recurred');
});

test('源码审查绑定源码hash，不拿旧源码结论关闭新构建线索',async t=>{
 const {ledger}=await fixture(t),f={...finding('logging-source-file'),fingerprint:undefined};
 const a={...record([f]),loggingAudit:{sourceHash:'a'}},b={...record([f]),loggingAudit:{sourceHash:'b'}};
 const v=await ledger.sync([a,b]);assert.notEqual(v.get(a.id).issues[0].id,v.get(b.id).issues[0].id);
});

test('损坏台账不覆盖；原诊断仍可查看并明确显示台账失败',async t=>{
 const {dir,ledger}=await fixture(t),r=record();await ledger.sync([r]);
 const file=path.join(ledger.dir,'ledger.json');await fs.writeFile(file,'{broken');await assert.rejects(ledger.sync([r]));assert.equal(await fs.readFile(file,'utf8'),'{broken');
 await fs.writeFile(path.join(dir,r.id+'.json'),JSON.stringify(r));
 const jobs=new DiagnosticJobs(dir,r,async()=>{},async()=>({status:'sent'}));t.after(()=>jobs.dispose());
 const view=await jobs.get(r.id);assert.equal(view.findings.length,1);assert.match(view.trackingError,/台账暂不可用/);
});

test('修复后扫描限定实际日志版本和修复后时间，不混入旧窗口与未知版本',async t=>{
 const {dir}=await fixture(t),from=Date.parse('2026-11-03T06:00:00Z');
 const rows=[['0.1.198',from-1],['0.1.197',from+1],['0.1.198',from+2]];
 await fs.writeFile(path.join(dir,'codex-chat-2026-11-03.log'),rows.map(([v,at])=>`[${new Date(at).toISOString()}] [pluginVersion=${v} windowId=w hostId=h] [operation] ${JSON.stringify({operation:'test.read',stage:'failed',outcome:'failed',errorType:'Error',failureCategory:'timeout'})}`).join('\n'));
 const result=await scanPluginLogs(dir,()=>{},{kind:'performance',hours:24,engine:'rules',fromMs:from,toMs:from+100,targetVersion:'0.1.198'});
 assert.equal(result.coverage.includedLines,1);assert.equal(result.coverage.outsideRangeLines,2);assert.deepEqual(result.coverage.sources.map(s=>s.pluginVersion),['0.1.198']);
});

test('Jobs修复提示包含结果协议，回写后可开始本地复测且保留模型偏好',async t=>{
 const {dir}=await fixture(t),r={...record(),options:{kind:'performance',hours:24,engine:'model',model:'chosen',effort:'high',toMs:now}};
 await fs.writeFile(path.join(dir,r.id+'.json'),JSON.stringify(r));await fs.writeFile(path.join(dir,r.id+'.report.md'),'# 报告');
 let request;const jobs=new DiagnosticJobs(dir,r,async(_p,_s,q)=>{request=q;return {findings:[],report:'复测',sourceNote:'测试',summary:{turns:0,tools:0,failures:0,versions:[],longestTurnMs:0}}},async()=>({status:'sent'}));t.after(()=>jobs.dispose());
 await jobs.repair(r.id,async prompt=>{assert.match(prompt,/结果回写/);assert.match(prompt,/revision/);return 'session';},async()=>{});
 let view=await jobs.get(r.id);const id=view.tracking.issues[0].id,batch=view.tracking.batch;
 await fs.writeFile(batch.receiptPath,JSON.stringify({schema:1,diagnosticId:r.id,batchId:batch.id,revision:1,results:[{issueId:id,outcome:'fixed',reason:'修复',version:'0.1.198',commit:'abcdef0',tests:'通过'}]}));
 await jobs.get(r.id);const retest=await jobs.retest(r.id);await jobs.dispose();
 assert.equal(retest.verificationOf,r.id);assert.equal(retest.options.engine,'rules');assert.equal(retest.options.targetVersion,'0.1.198');assert.equal((await jobs.get(r.id)).options.model,'chosen');
});
