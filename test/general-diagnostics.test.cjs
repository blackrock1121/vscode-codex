const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { scanPluginLogs } = require('../dist/test/diagnostics/scan.js');
const { analyzeWithModel, diagnosticModelPrompt } = require('../dist/test/diagnostics/model.js');
const { diagnosticOptions } = require('../dist/test/diagnostics/options.js');
const { redactDiagnosticText } = require('../dist/test/diagnostics/redact.js');
const { GeneralAccumulator } = require('../dist/test/diagnostics/general.js');
const end = Date.parse('2026-10-15T12:00:00Z');
const request = { kind:'general',hours:24,engine:'model',model:'model-a',effort:'high',fromMs:end-86400000,toMs:end };
const output = { report:'# 本地证据',sourceNote:'全局',findings:[{id:'log-1',title:'压缩失败',severity:'error',evidence:'compaction failed at file.log:12',recommendation:'验证',traceIds:['trace-a']}],summary:{turns:1,tools:2,failures:1,longestTurnMs:1000,versions:['0.1.131']} };
function line(at,message,version='0.1.131',window='window-a') {return `[12:00:00] [pluginVersion=${version} windowId=${window} hostId=123] [${new Date(at).toISOString()}] ${message}\n`;}

test('全面诊断检查滚动24小时普通报错、压缩恢复失败、重试及多版本来源，排除区间外记录',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-general-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'codex-chat-2026-10-14.log'),line(end-30*3600000,'[error] old failure')+line(end-23*3600000,'[diag] [compaction] '+JSON.stringify({stage:'error',errorCategory:'badRequest',httpStatusCode:400,traceId:'compact-a'}),'0.1.130','window-old'));
 await fs.writeFile(path.join(root,'codex-chat-2026-10-15.log'),line(end-3600000,'[compaction_restore] 恢复失败 token=TOPSECRET https://example.invalid/private?key=SECRET')+
  line(end-3000000,'[diag] [compaction] '+JSON.stringify({stage:'retry',traceId:'compact-a'}))+
  line(end-2000000,'[webview] 脚本错误 TypeError: Cannot read properties of undefined')+
  line(end-1000000,'[notify] failed status=502')+line(end-900000,'[connection] 恢复成功')+
  line(end+1000,'[error] future failure')+'[error] 未标时间失败\n');
 const result=await scanPluginLogs(root,()=>{},request);
 assert.equal(result.general.errors,4);assert.equal(result.general.warnings,1);assert.equal(result.general.compactionErrors,2);assert.equal(result.general.retries,1);assert.equal(result.general.recoveries,1);
 assert.equal(result.coverage.outsideRangeLines,2);assert.equal(result.coverage.unknownTimeLines,1);assert.equal(result.coverage.windows,2);
 assert.deepEqual(result.summary.versions,['0.1.130','0.1.131']);
 assert.ok(result.findings.some(f=>f.category==='页面脚本'));assert.ok(result.findings.some(f=>f.evidence.includes('badRequest')));
 assert.match(result.report,/codex-chat-2026-10-14.log:2/);assert.match(result.report,/版本 0.1.130/);
 assert.doesNotMatch(result.report,/TOPSECRET|example.invalid|key=SECRET|old failure|future failure|未标时间失败/);
 const perf=await scanPluginLogs(root,()=>{},{...request,kind:'performance'});assert.equal(perf.general.errors,4);
 assert.ok(perf.findings.some(f=>f.category==='页面脚本'),'速度诊断也必须携带页面异常证据');
});

test('异常归类合并重复事件，保留最早和最近示例，不把主动取消当内部错误',()=>{
 const accumulator=new GeneralAccumulator();
 for(let i=0;i<5;i++)accumulator.add(`[error] connection failed attempt ${i}`,undefined,{file:'codex-chat-2026-10-15.log',line:i+1,atMs:end+i});
 accumulator.add('[error] 用户主动取消任务',undefined,{file:'x',line:10});
 const result=accumulator.result();assert.equal(result.summary.errors,5);assert.equal(result.findings.length,1);assert.match(result.findings[0].evidence,/\.log:1/);assert.match(result.findings[0].evidence,/\.log:5/);
});

test('脱敏覆盖凭据、URL、路径、邮箱和正文，设置不允许不支持的推理值',()=>{
 const value=redactDiagnosticText('error Authorization: Bearer PRIVATE_TOKEN api_key="ABCSECRET" path=/Users/alice/secret.txt https://host.invalid/key?token=QUERY alice@example.com sk-abcdefghijk');
 assert.doesNotMatch(value,/PRIVATE_TOKEN|ABCSECRET|alice|host.invalid|QUERY|sk-abc/);assert.match(value,/error/);
 assert.doesNotMatch(redactDiagnosticText('error {"input":"PRIVATE_BODY"}'),/PRIVATE_BODY/);
 assert.equal(diagnosticOptions({kind:'general',hours:24,engine:'model',model:'m',effort:'xhigh'}).effort,'xhigh');
 assert.throws(()=>diagnosticOptions({kind:'general',hours:1,engine:'rules'}),/无效/);assert.throws(()=>diagnosticOptions({...request,effort:'极高'}),/reasoning effort/);
});

class FakeRpc extends EventEmitter {
 constructor(mode='ok'){super();this.mode=mode;this.calls=[];this.disposed=0;}
 async start(){}
 async request(method,params){
  this.calls.push({method,params});
  if(method==='config/read')return {config:{mcp_servers:{existing:{env:{token:'NEVER_SENT'}}}}};
  if(method==='thread/start')return {thread:{id:'diagnostic-thread'},model:this.mode==='fallback'?'wrong-model':'model-a',reasoningEffort:'high'};
  if(method==='turn/start'){
   const p={threadId:'diagnostic-thread'};
   queueMicrotask(()=>{
    if(this.mode==='waiting')return;
    if(this.mode==='tool'){this.emit('request',{id:7,method:'item/tool/call',params:{threadId:'diagnostic-thread'}});return;}
    this.emit('notification',{method:'item/agentMessage/delta',params:{threadId:'unrelated',delta:'IGNORE'}});
    const answer={summary:'压缩失败需要核验',findings:[{title:'压缩请求被拒绝',severity:'error',evidenceIds:[this.mode==='bad-ref'?'invented':'log-1'],explanation:'依据错误日志',recommendation:'核验配置恢复'}]};
    this.emit('notification',{method:'item/completed',params:{...p,item:{type:'agentMessage',text:this.mode==='bad-json'?'invalid':JSON.stringify(answer)}}});
    this.emit('notification',{method:'turn/completed',params:{...p,turn:{id:'diagnostic-turn',status:this.mode==='failed'?'failed':'completed'}}});
   });
   return {turn:{id:'diagnostic-turn'}};
  }
  return {};
 }
 reject(id,message){this.rejected={id,message};}
 async disposeAndWait(){this.disposed++;this.emit('close',0);}
}

test('模型诊断独立临时线程、采用所选档位、关闭工具并验证证据引用，不改业务配置',async()=>{
 const rpc=new FakeRpc();const result=await analyzeWithModel(rpc,output,request,os.tmpdir(),()=>{},new AbortController().signal);
 assert.equal(result.modelAnalysis.status,'completed');assert.equal(result.modelAnalysis.model,'model-a');assert.equal(result.modelAnalysis.effort,'high');assert.equal(result.findings[0].origin,'model');assert.deepEqual(result.findings[0].traceIds,['trace-a']);
 const thread=rpc.calls.find(c=>c.method==='thread/start').params;assert.equal(thread.ephemeral,true);assert.equal(thread.allowProviderModelFallback,false);assert.equal(thread.sandbox,'read-only');assert.equal(thread.config['features.shell_tool'],false);assert.equal(thread.config.mcp_servers.existing.enabled,false);
 const turn=rpc.calls.find(c=>c.method==='turn/start').params;assert.equal(turn.model,'model-a');assert.equal(turn.effort,'high');assert.equal(turn.serviceTier,'default');assert.equal(turn.sandboxPolicy.networkAccess,false);assert.ok(turn.outputSchema);
 assert.doesNotMatch(turn.input[0].text,/NEVER_SENT|IGNORE/);assert.equal(rpc.calls.some(c=>/config.*write|thread\/settings/.test(c.method)),false);assert.ok(rpc.disposed);
 assert.doesNotMatch(diagnosticModelPrompt({...output,report:'PRIVATE_RAW_LOG'}),/PRIVATE_RAW_LOG/);
});

test('模型失败、错误JSON、伪造证据和模型替换都保留本地结果并明确标为模型失败',async()=>{
 for(const mode of ['failed','bad-json','bad-ref','fallback']){
  const result=await analyzeWithModel(new FakeRpc(mode),output,request,os.tmpdir(),()=>{},new AbortController().signal);
  assert.equal(result.modelAnalysis.status,'failed',mode);assert.match(result.report,/本地证据/);assert.equal(result.findings[0].id,'log-1');
 }
});

test('模型尝试交互、超时和主动停止都会释放连接，不继续后台工具',async()=>{
 const tool=new FakeRpc('tool');assert.equal((await analyzeWithModel(tool,output,request,os.tmpdir(),()=>{},new AbortController().signal)).modelAnalysis.status,'failed');assert.equal(tool.rejected.id,7);assert.ok(tool.disposed);
 const timeout=new FakeRpc('waiting');const keeper=setInterval(()=>{},1000);
 try {assert.match((await analyzeWithModel(timeout,output,request,os.tmpdir(),()=>{},new AbortController().signal,10)).modelAnalysis.message,/超过/);}finally{clearInterval(keeper);}
 const stopped=new FakeRpc('waiting'),controller=new AbortController();const pending=analyzeWithModel(stopped,output,request,os.tmpdir(),()=>{},controller.signal);setImmediate(()=>controller.abort());await assert.rejects(pending,/中断/);assert.ok(stopped.disposed);
});

test('后台作业固定本次设置，不会默默把新模型请求合并进旧诊断，可主动停止',async t=>{
 const {DiagnosticJobs}=require('../dist/test/diagnostics/jobs.js');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-diagnostic-options-'));let received;
 const jobs=new DiagnosticJobs(root,{pluginVersion:'v',windowId:'w',workspaceId:'x',workspaceName:'x'},async(_p,signal,options)=>{received=options;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('stopped'))));},async()=>({status:'sent'}));
 t.after(async()=>{await jobs.dispose();await fs.rm(root,{recursive:true,force:true});});
 const record=await jobs.start({kind:'general',hours:24,engine:'model',model:'model-a',effort:'high'});
 assert.equal(received.model,'model-a');assert.equal(received.fromMs,received.toMs-86400000);
 await assert.rejects(jobs.start({kind:'general',hours:24,engine:'model',model:'model-b',effort:'high'}),/不同设置/);
 await jobs.cancel(record.id);await jobs.dispose();const saved=await jobs.get(record.id);assert.equal(saved.status,'interrupted');assert.equal(saved.options.model,'model-a');
});

test('正常零失败计数、成功通知和用户回退记录不误报，实际失败标记仍识别',()=>{
 const {classifyIncident}=require('../dist/test/diagnostics/general.js');
 for(const text of ['[notify] clear_previous completed=28 failed=0 elapsedMs=1800','[status] 0 errors, 0 failures','[trace] {"error":null,"isError":false,"failed":0}','[restore] 派生分支，原会话保留，回退点 3 个','[rewind] 回退准备 2502ms'])assert.equal(classifyIncident(text),undefined,text);
 assert.equal(classifyIncident('[notify] remote_result ok=false status=502').severity,'error');
 assert.equal(classifyIncident('[webview] TypeError: undefined').severity,'error');
});
