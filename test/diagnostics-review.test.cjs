const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const os=require('node:os');
const {GeneralAccumulator,classifyIncident}=require('../dist/test/diagnostics/general.js');
const {diagnosticLogTime}=require('../dist/test/diagnostics/scan.js');
const {selectDiagnosticEvidence}=require('../dist/test/diagnostics/evidence.js');
const {analyzeWithModel,diagnosticModelPrompt}=require('../dist/test/diagnostics/model.js');
const {diagnosticWait}=require('../dist/test/diagnostics/wait.js');
const {loadDiagnosticConfiguration}=require('../dist/test/diagnostics/configuration.js');
const request={kind:'general',hours:24,engine:'model',model:'model-a',effort:'high',toMs:Date.now()};
const output={report:'本地结果',sourceNote:'测试',findings:[{id:'evidence',title:'错误',severity:'error',evidence:'有效证据',recommendation:'验证',traceIds:[]}],summary:{turns:0,tools:0,failures:0,longestTurnMs:0,versions:[]}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('压缩 RPC 和 stderr 错误正确归类，证据保留模型、推理、触发和 HTTP 状态',()=>{
 const rpc=classifyIncident('',{type:'rpc',method:'thread/compact/start',stage:'end',outcome:'failed'});
 assert.equal(rpc.category,'压缩');
 const stderr=classifyIncident('',{type:'runtime_error',severity:'error',message:'compaction failed while restoring model'});assert.equal(stderr.category,'压缩');
 const detail=classifyIncident('',{diagnosticType:'compaction',stage:'restore_failed',model:'model-a',effort:'xhigh',trigger:'auto',httpStatusCode:400});
 assert.match(detail.message,/model=model-a/);assert.match(detail.message,/effort=xhigh/);assert.match(detail.message,/trigger=auto/);assert.match(detail.message,/HTTP 400/);
});

test('异常分组保留不同 HTTP/退出码，归并波动耗时；JSON false/空警告不误报也不漏报',()=>{
 const a=new GeneralAccumulator();
 for(const [i,code] of [400,500,400].entries())a.add(`[error] HTTP ${code} attempt ${i} durationMs=${i*100}`,undefined,{file:'log',line:i+1});
 assert.equal(a.result().findings.length,2);assert.equal(a.result().findings[0].occurrences,2);
 const exits=new GeneralAccumulator();for(const exitCode of [1,2])exits.add('',{event:'span_end',kind:'bash',outcome:'failed',failureCategory:'nonzero_exit',exitCode},{file:'log',line:exitCode});assert.equal(exits.result().findings.length,2);
 assert.equal(classifyIncident('[notify] {"ok":false,"status":502}').severity,'error');assert.equal(classifyIncident('[tool] {"isError":true}').severity,'error');
 for(const line of ['[status] {"warnings":[],"error":null,"success":true}','[status] warnings=0 errors=0','[status] {"warning":false}'])assert.equal(classifyIncident(line),undefined,line);
});

test('警告填满分组后仍保留新错误，模型输入按类别取证不会挤掉压缩和性能',()=>{
 const a=new GeneralAccumulator();for(let i=0;i<160;i++)a.add(`[warning] message ${i}`,undefined,{file:'log',line:i});
 a.add('[error] compaction HTTP 400',undefined,{file:'log',line:200});const result=a.result();assert.equal(result.findings.length,160);assert.ok(result.findings.some(f=>f.category==='压缩'&&f.severity==='error'));assert.equal(result.summary.overflow,1);
 const findings=Array.from({length:80},(_,i)=>({...output.findings[0],id:`tool-${i}`,category:'工具执行'}));
 findings.push({...output.findings[0],id:'late-compaction',category:'压缩'},{...output.findings[0],id:'phase-unobserved'},{...output.findings[0],id:'log-coverage'});
 const selected=selectDiagnosticEvidence(findings);assert.equal(selected.length,60);for(const id of ['late-compaction','phase-unobserved','log-coverage'])assert.ok(selected.some(f=>f.id===id));
 assert.equal(findings[0].id,'tool-0');const prompt=diagnosticModelPrompt({...output,findings,compactionEvidence:[{model:'model-a',effort:'xhigh',stage:'error'}]});assert.match(prompt,/late-compaction/);assert.match(prompt,/compactionEvidence/);assert.match(prompt,/xhigh/);
});

test('毫秒级观测优先于粗粒度时钟，错误正文内旧日期不污染24小时范围',()=>{
 const file='codex-chat-2026-10-15.log',at=new Date(2026,9,15,12,0,0,900).getTime();
 assert.equal(diagnosticLogTime('[12:00:00] [perf] {}',file,{atMs:at}),at);
 assert.equal(diagnosticLogTime('[12:00:00] [error] upstream received [2000-01-01T00:00:00Z]',file),new Date(2026,9,15,12).getTime());
 assert.equal(diagnosticLogTime('[12:00:00] [2026-10-15T04:00:00.123Z] [error] old [2000-01-01T00:00:00Z]',file),Date.parse('2026-10-15T04:00:00.123Z'));
 assert.equal(diagnosticLogTime('[29:99:99] [error] bad clock',file),undefined);
});

test('准备等待支持立即取消和超时，迟到结果不推进诊断；离线保留原有规则设置',async()=>{
 let release,ran=0;const controller=new AbortController();
 const pending=diagnosticWait(()=>{ran++;return new Promise(resolve=>release=resolve);},controller.signal,5000);await flush();controller.abort();await assert.rejects(pending,/中断/);release('late');await flush();assert.equal(ran,1);
 const aborted=new AbortController();aborted.abort();await assert.rejects(diagnosticWait(()=>{ran++;return Promise.resolve();},aborted.signal),/中断/);assert.equal(ran,1);
 await assert.rejects(diagnosticWait(()=>new Promise(()=>{}),undefined,5,'目录超时'),/目录超时/);
 let reads=0;const offline=await loadDiagnosticConfiguration({kind:'general',hours:168,engine:'rules'},{model:'chosen',effort:'high'},async()=>{reads++;throw new Error('offline');});
 assert.equal(offline.options.engine,'rules');assert.equal(offline.options.hours,168);assert.equal(offline.error,undefined);assert.equal(reads,0);
 const forced=await loadDiagnosticConfiguration(offline.options,{effort:'high'},async()=>{reads++;throw new Error('offline');},100,true);assert.equal(forced.error,'offline');assert.equal(reads,1);
 const timed=await loadDiagnosticConfiguration(request,{effort:'medium'},()=>new Promise(()=>{}),5);assert.equal(timed.options.model,'model-a');assert.equal(timed.options.effort,'high');assert.match(timed.error,/超时/);
});

class ReviewRpc extends EventEmitter {
 constructor(mode){super();this.mode=mode;this.calls=[];this.closed=0;}
 async start(){if(this.mode==='start-hang')return new Promise(()=>{});}
 request(method,params){this.calls.push(method);
  if(method==='config/read')return this.mode==='config-hang'?new Promise(()=>{}):Promise.resolve({config:{}});
  if(method==='thread/start')return Promise.resolve({thread:{id:'diag'},model:'model-a',reasoningEffort:'high'});
  if(method==='turn/start'){
   queueMicrotask(()=>{
    const answer=JSON.stringify({summary:'结论',findings:[]});
    this.emit('notification',{method:'item/completed',params:{threadId:'diag',item:{type:'agentMessage',text:this.mode==='oversize'?'x'.repeat(120001):answer}}});
    this.emit('notification',{method:'turn/completed',params:{threadId:'diag',turn:{id:'turn',status:'completed',...(this.mode==='bad-items'?{items:{invalid:true}}:{})}}});
   });
   return this.mode==='ack-hang'?new Promise(()=>{}):Promise.resolve({turn:{id:'turn'}});
  }
  return Promise.resolve({});
 }
 reject(){}
 async disposeAndWait(){this.closed++;this.emit('close',0);}
}

test('连接准备未返回也能取消，准备阶段截止后停止，模型完成不被迟到受理回执阻塞',async()=>{
 const rpc=new ReviewRpc('start-hang'),controller=new AbortController();const pending=analyzeWithModel(rpc,output,request,os.tmpdir(),()=>{},controller.signal);await flush();controller.abort();await assert.rejects(pending,/中断/);assert.ok(rpc.closed);assert.equal(rpc.calls.includes('turn/start'),false);
 const keeper=setInterval(()=>{},1000);
 try{
  const timed=await analyzeWithModel(new ReviewRpc('config-hang'),output,request,os.tmpdir(),()=>{},new AbortController().signal,5);assert.equal(timed.modelAnalysis.status,'failed');assert.match(timed.report,/本地结果/);
  const ack=new ReviewRpc('ack-hang');const result=await analyzeWithModel(ack,output,request,os.tmpdir(),()=>{},new AbortController().signal,500);assert.equal(result.modelAnalysis.status,'completed');assert.equal(result.modelAnalysis.evidenceSent,1);assert.ok(ack.closed);
 }finally{clearInterval(keeper);}
});

test('超长完成消息和损坏 turn.items 安全失败，不抛事件处理异常且释放监听',async()=>{
 for(const mode of ['oversize','bad-items']){const rpc=new ReviewRpc(mode);const result=await analyzeWithModel(rpc,output,request,os.tmpdir(),()=>{},new AbortController().signal);assert.equal(result.modelAnalysis.status,'failed');assert.match(result.report,/本地结果/);assert.ok(rpc.closed);assert.equal(rpc.listenerCount('notification'),0);}
});

test('大量工具错误占满分组时，新出现的压缩故障仍保留证据',()=>{
 const a=new GeneralAccumulator();for(let i=0;i<160;i++)a.add(`[tool] error code ${i}`,undefined,{file:'log',line:i});
 a.add('[error] compaction HTTP 400',undefined,{file:'log',line:200});const result=a.result();assert.equal(result.summary.errors,161);assert.equal(result.summary.compactionErrors,1);assert.equal(result.summary.overflow,1);assert.ok(result.findings.some(f=>f.category==='压缩'));
});
