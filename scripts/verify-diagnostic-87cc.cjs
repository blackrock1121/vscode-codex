// 固定旧源码和同一日志快照对照；不改写原日志、不发送模型/通知请求。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),logDir=process.argv[2],baseline='a97fdd7';
if(!logDir)throw new Error('请提供原日志目录');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-87cc-verify-')),beforeRoot=path.join(temp,'before');
const report={diagnosticId:'87cc8d0b-9968-4894-82fb-fef2db4a37fc',baseline,createdAt:new Date().toISOString(),
 scope:'隔离临时目录、固定全部保留日志的长度快照；基线完整取自0.1.160。只输出计数/哈希/白名单指标。快照试验为本机合成源码文件，不代表真实模型或网络提速。'};
(async()=>{
 fs.mkdirSync(beforeRoot);
 const archive=execFileSync('git',['archive',baseline,'src','native','scripts/log-audit.cjs','package.json'],{cwd:root,maxBuffer:12*1024*1024});
 execFileSync('tar',['-x','-C',beforeRoot],{input:archive});fs.symlinkSync(path.join(root,'node_modules'),path.join(beforeRoot,'node_modules'),'dir');
 const manifest=require(path.join(beforeRoot,'scripts/log-audit.cjs')).buildLogAudit(beforeRoot).manifest;
 assert.equal(manifest.sourceHash,'4a34dec6ab4afd74c9d0e009f7716a09cd92ca3bdcd3140b75bc0d4c9ebf1861');
 report.baselineSourceHash=manifest.sourceHash;report.currentSourceHash=require('./log-audit.cjs').buildLogAudit(root).manifest.sourceHash;
 const esbuild=require('esbuild');
 await esbuild.build({entryPoints:['diagnostics/scan','logging','codex/rpc','snapshot'].map(n=>path.join(beforeRoot,'src',n+'.ts')),outdir:path.join(temp,'old'),outbase:path.join(beforeRoot,'src'),bundle:true,platform:'node',format:'cjs',plugins:[require(path.join(beforeRoot,'scripts/log-audit.cjs')).logAuditPlugin(beforeRoot)]});
 const old={...require(path.join(temp,'old/logging.js')),...require(path.join(temp,'old/codex/rpc.js')),...require(path.join(temp,'old/snapshot.js'))};
 const next={...require(path.join(root,'dist/test/logging.js')),...require(path.join(root,'dist/test/codex/rpc.js')),...require(path.join(root,'dist/test/snapshot.js'))};
 const work=path.join(temp,'workspace');fs.mkdirSync(work);for(let i=0;i<500;i++)fs.writeFileSync(path.join(work,`source-${i}.ts`),'const source = 1;\n'.repeat(50));
 report.snapshot=[];
 for(let round=0;round<5;round++)for(const [mode,api] of round%2?[['after',next],['before',old]]:[['before',old],['after',next]]){
  const snapshot=new api.WorkspaceSnapshot([work]),at=performance.now(),alloc=Buffer.allocUnsafe;let allocated=0;
  Buffer.allocUnsafe=function(size){allocated+=size;return alloc(size);};
  try{await snapshot.capture();}finally{Buffer.allocUnsafe=alloc;}
  report.snapshot.push({mode,round,files:snapshot.files.size,allocatedBytes:allocated,captureMs:Math.round(performance.now()-at)});assert.equal(snapshot.files.size,500);
 }
 report.rpc=[];report.overflow=[];
 for(const [mode,api] of [['before',old],['after',next]]){
  const rpc=new api.CodexRpc(path.join(root,'test/fake-codex.cjs'),root);
  try{
   await rpc.start();const pending=rpc.request('hang').catch(()=>{});
   rpc.child.stdin.write=()=>{throw Object.assign(new Error('synthetic pipe failure'),{code:'EPIPE'});};
   const at=performance.now();await assert.rejects(rpc.request('echo'),{code:'EPIPE'});
   report.rpc.push({mode,closed:rpc.isClosed,pendingRequests:rpc.pending.size,rejectionMs:Math.round(performance.now()-at)});
   await rpc.disposeAndWait();await pending;
  }finally{await rpc.disposeAndWait();}
  const dir=path.join(temp,'overflow-'+mode),writer=new api.DailyLogWriter(dir,{pluginVersion:mode,windowId:'test',hostId:'test'},undefined,()=>{}),fromMs=Date.now()-1000;
  for(let i=0;i<100;i++)writer.write('x'.repeat(32768));await writer.flush();await writer.flush();
  const scan=await require(path.join(root,'dist/test/diagnostics/scan.js')).scanPluginLogs(dir,()=>{},{kind:'general',engine:'rules',hours:24,fromMs,toMs:Date.now()+1000});
  report.overflow.push({mode,detectedDroppedLines:scan.coverage.droppedLines,unknownTimeLines:scan.coverage.unknownTimeLines});await writer.dispose();
 }
 const copy=path.join(temp,'logs');fs.mkdirSync(copy);report.logSnapshot=[];
 const names=fs.readdirSync(logDir).filter(n=>/^codex-chat-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
 const accountChains=[],latestAccountChain=new Map(),processEnds=new Map();
 const rawSummary={reportWindowAccount:{},trackedTerminals:[],rpcFailures:{},rpcExitCodes:{},unknownToolDurations:0,zeroToolDurations:0,compactionFallbacks:[],longestUnknownWaits:[]};
 for(const name of names){
  const file=path.join(logDir,name),size=fs.statSync(file).size,source=fs.openSync(file,'r'),dest=fs.openSync(path.join(copy,name),'w',0o600),buffer=Buffer.alloc(1024*1024),hash=createHash('sha256');let offset=0;
  try{while(offset<size){const read=fs.readSync(source,buffer,0,Math.min(buffer.length,size-offset),offset);if(!read)throw new Error('日志在快照期间截断');fs.writeSync(dest,buffer,0,read);hash.update(buffer.subarray(0,read));offset+=read;}}
  finally{fs.closeSync(source);fs.closeSync(dest);}
  report.logSnapshot.push({file:name,bytes:size,sha256:hash.digest('hex')});
  for(const line of fs.readFileSync(path.join(copy,name),'utf8').split('\n')){
   const match=/\[(operation|perf|compaction_route|compaction|transport)\] (\{.*\})$/.exec(line);if(!match)continue;
   let row;try{row=JSON.parse(match[2]);}catch{continue;}
   const version=/pluginVersion=([\w.-]+)/.exec(line)?.[1]??'unknown';
   const at=require(path.join(root,'dist/test/diagnostics/scan.js')).diagnosticLogTime(line,name,row);
   const inWindow=at>=Date.parse('2026-10-20T08:38:48.403Z')&&at<=Date.parse('2026-10-21T08:38:48.403Z');
   if(inWindow&&['rpc.process','session.read','account.usage'].includes(row.operation)&&(row.stage==='failed'||row.stage==='recovered'||(row.operation==='rpc.process'&&row.stage==='end'))){
    const key=[version,row.operation,row.stage,row.exitCode??row.errorCode??row.rpcCode??'unknown'].join(':');
    rawSummary.reportWindowAccount[key]=(rawSummary.reportWindowAccount[key]??0)+1;
   }
   const windowId=/windowId=([\w.-]+)/.exec(line)?.[1]??'unknown',chainKey=version+':'+windowId;
   if(inWindow&&row.operation==='rpc.process'&&row.stage==='failed'){
    const chain={version,windowId,atMs:at,operationId:row.operationId,errorCode:row.errorCode??null,operations:['rpc.process']};
    accountChains.push(chain);latestAccountChain.set(chainKey,chain);
   }else if(inWindow&&row.stage==='failed'&&['session.read','account.usage'].includes(row.operation)){
    const chain=latestAccountChain.get(chainKey);
    if(chain&&at>=chain.atMs&&at-chain.atMs<1000&&chain.errorCode===(row.errorCode??null)&&!chain.operations.includes(row.operation))chain.operations.push(row.operation);
   }
   if(row.operation==='rpc.process'&&row.stage==='end')processEnds.set(chainKey+':'+row.operationId,row.exitCode??null);
   if(['6c42e3ee-36bb-444b-a4de-fc18eee01beb','d0566cf0-25cb-49a5-935e-992b25804ac7','32deb317-be4f-46e2-bc41-1dc461c1bc1f'].includes(row.traceId)&&
    (row.event==='turn_summary'||row.event==='compaction'||match[1]==='compaction'&&['end','usage_updated'].includes(row.stage)||['response','transport_end'].includes(row.stage))){
    rawSummary.trackedTerminals.push(Object.fromEntries(Object.entries({file:name,version,atMs:at,traceId:row.traceId,processRunId:row.processRunId,event:row.event,stage:row.stage,outcome:row.outcome,elapsedMs:row.elapsedMs,durationMs:row.durationMs}).filter(([,v])=>v!==undefined)));
   }
   if(row.operation==='rpc.process'&&row.stage==='failed')rawSummary.rpcFailures[version]=(rawSummary.rpcFailures[version]??0)+1;
   if(row.operation==='rpc.process'&&row.stage==='end'){
    const key=`${version}:${row.exitCode??row.signal??'unknown'}`;rawSummary.rpcExitCodes[key]=(rawSummary.rpcExitCodes[key]??0)+1;
   }
   if(row.event==='span_end'&&['tool','bash'].includes(row.kind)&&row.outcome==='failed'){
    if(typeof row.durationMs!=='number')rawSummary.unknownToolDurations++;else if(row.durationMs===0)rawSummary.zeroToolDurations++;
   }
   if(row.event==='turn_summary'&&typeof row.phasesMs?.unobserved==='number')rawSummary.longestUnknownWaits.push({version,traceId:row.traceId,unobservedMs:row.phasesMs.unobserved,elapsedMs:row.elapsedMs});
   if(match[1]==='compaction_route'&&row.stage==='fallback')rawSummary.compactionFallbacks.push({version,reason:row.reason,processRunId:row.processRunId??null});
  }
 }
 const triplets=accountChains.filter(c=>c.operations.length===3).map(c=>({...c,exitCode:processEnds.get(c.version+':'+c.windowId+':'+c.operationId)??null}));
 rawSummary.accountPropagation={scope:'报告24小时内，同版本/窗口、相邻1秒且错误码一致的疑似传播链；历史无failureId，保留关联局限',triplets:triplets.length,
  loggedFailuresInTriplets:triplets.length*3,exit127:triplets.filter(c=>c.exitCode===127).length,samples:[...triplets.slice(0,2),...triplets.slice(-1)]};
 rawSummary.longestUnknownWaits.sort((a,b)=>b.unobservedMs-a.unobservedMs);rawSummary.longestUnknownWaits=rawSummary.longestUnknownWaits.slice(0,8);report.retainedEvidence=rawSummary;
 const beforeScan=require(path.join(temp,'old/diagnostics/scan.js')).scanPluginLogs,afterScan=require(path.join(root,'dist/test/diagnostics/scan.js')).scanPluginLogs;
 const request={kind:'general',hours:24,engine:'rules',fromMs:Date.parse('2026-10-20T08:38:48.403Z'),toMs:Date.parse('2026-10-21T08:38:48.403Z')};
 const summarize=r=>({coverage:r.coverage,summary:r.summary,general:r.general,loggingAudit:r.loggingAudit,
  performanceFindings:r.findings.filter(f=>/^(failure-|phase-|coverage|repeat)/.test(f.id)).map(f=>({id:f.id,evidence:f.evidence}))});
 report.before=summarize(await beforeScan(copy,()=>{},request));report.after=summarize(await afterScan(copy,()=>{},request));
 assert.deepEqual(report.before.summary,report.after.summary);assert.deepEqual(report.before.coverage,report.after.coverage);
 report.allRetained=summarize(await afterScan(copy,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()}));
 const med=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 report.comparison={snapshotBeforeMedianMs:med(report.snapshot.filter(x=>x.mode==='before').map(x=>x.captureMs)),snapshotAfterMedianMs:med(report.snapshot.filter(x=>x.mode==='after').map(x=>x.captureMs)),
  snapshotBeforeAllocatedBytes:med(report.snapshot.filter(x=>x.mode==='before').map(x=>x.allocatedBytes)),snapshotAfterAllocatedBytes:med(report.snapshot.filter(x=>x.mode==='after').map(x=>x.allocatedBytes)),rpc:report.rpc,overflow:report.overflow};
 report.limitations=['原始历史失败不因修复而删除；没有failureId的旧记录不擅自推断独立事故数。','历史最长未知等待、工具阶段及真实压缩耗时没有通过合成测试证明缩短。','快照实测受本机磁盘缓存和进程负载影响；分配量改进不能外推为模型或后端耗时缩短。','CLI内部遥测导出队列/重试/最终丢弃没有足够证据，不能宣称已恢复。'];
 fs.writeFileSync(path.join(root,'benchmarks/diagnostic-87cc-results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({comparison:report.comparison,files:report.logSnapshot.length,before:report.before.summary,after:report.after.summary,allRetained:report.allRetained.summary},null,2));
})().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
