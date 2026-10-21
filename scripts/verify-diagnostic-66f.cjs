// 固定旧源码和同一日志快照对照；不改写原日志、不发送模型/通知请求。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),logDir=process.argv[2],baseline='c9c6d5f';
if(!logDir)throw new Error('请提供原日志目录');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-66f-verify-')),beforeRoot=path.join(temp,'before');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={diagnosticId:'66fdf62b-5543-454b-ae28-f0634faa59ad',baseline,createdAt:new Date().toISOString(),
 scope:'隔离临时目录、固定全部保留日志的长度快照；基线完整取自0.1.159。只输出计数/哈希/白名单指标。耗时试验为合成磁盘等待，不代表真实模型或网络提速。'};
(async()=>{
 fs.mkdirSync(beforeRoot);
 const archive=execFileSync('git',['archive',baseline,'src','native','scripts/log-audit.cjs','package.json'],{cwd:root,maxBuffer:12*1024*1024});
 execFileSync('tar',['-x','-C',beforeRoot],{input:archive});fs.symlinkSync(path.join(root,'node_modules'),path.join(beforeRoot,'node_modules'),'dir');
 const manifest=require(path.join(beforeRoot,'scripts/log-audit.cjs')).buildLogAudit(beforeRoot).manifest;
 assert.equal(manifest.sourceHash,'ab70acf73dba5f3098524041742bd26a22dc4ff80632d060d764d62cfdeaab50');
 report.baselineSourceHash=manifest.sourceHash;report.currentSourceHash=require('./log-audit.cjs').buildLogAudit(root).manifest.sourceHash;
 const esbuild=require('esbuild');
 await esbuild.build({entryPoints:['diagnostics/scan','diagnostics/jobs','snapshot'].map(n=>path.join(beforeRoot,'src',n+'.ts')),outdir:path.join(temp,'old'),outbase:path.join(beforeRoot,'src'),bundle:true,platform:'node',format:'cjs',plugins:[require(path.join(beforeRoot,'scripts/log-audit.cjs')).logAuditPlugin(beforeRoot)]});
 const old={...require(path.join(temp,'old/diagnostics/jobs.js')),...require(path.join(temp,'old/snapshot.js'))};
 const next={...require(path.join(root,'dist/test/diagnostics/jobs.js')),...require(path.join(root,'dist/test/snapshot.js'))};
 report.progress=[];
 for(let round=0;round<3;round++)for(const [mode,api] of round%2?[['after',next],['before',old]]:[['before',old],['after',next]]){
  let progress,finish,writes=0;
  const jobs=new api.DiagnosticJobs(path.join(temp,`jobs-${mode}-${round}`),{pluginVersion:mode,windowId:'bench',workspaceId:'bench',workspaceName:'bench'},p=>{progress=p;return new Promise(r=>finish=r);},async()=>({status:'not_configured'}));
  const started=await jobs.start(),save=jobs.saveInner.bind(jobs);
  jobs.saveInner=async record=>{if(record.status==='running'){writes++;await delay(5);}return save(record);};
  const at=performance.now();for(let i=0;i<100;i++)progress('扫描 '+i);
  finish({report:'synthetic',findings:[],summary:{turns:0,tools:0,failures:0,longestTurnMs:0,versions:[]},sourceNote:'synthetic'});
  await Promise.all([...jobs.tasks]);assert.equal((await jobs.get(started.id)).status,'completed');
  report.progress.push({mode,round,progressEvents:100,progressWrites:writes,completeMs:Math.round(performance.now()-at)});await jobs.dispose();
 }
 const work=path.join(temp,'workspace');fs.mkdirSync(work);for(let i=0;i<500;i++)fs.writeFileSync(path.join(work,`source-${i}.ts`),'const source = 1;\n'.repeat(50));
 report.snapshot=[];
 for(let round=0;round<3;round++)for(const [mode,api] of round%2?[['after',next],['before',old]]:[['before',old],['after',next]]){
  const snapshot=new api.WorkspaceSnapshot([work]),at=performance.now();await snapshot.capture();
  report.snapshot.push({mode,round,files:snapshot.files.size,captureMs:Math.round(performance.now()-at)});assert.equal(snapshot.files.size,500);
 }
 const copy=path.join(temp,'logs');fs.mkdirSync(copy);report.logSnapshot=[];
 const names=fs.readdirSync(logDir).filter(n=>/^codex-chat-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
 const rawSummary={rpcFailures:{},rpcExitCodes:{},unknownToolDurations:0,zeroToolDurations:0,compactionFallbacks:[],longestUnknownWaits:[]};
 for(const name of names){
  const file=path.join(logDir,name),size=fs.statSync(file).size,source=fs.openSync(file,'r'),dest=fs.openSync(path.join(copy,name),'w',0o600),buffer=Buffer.alloc(1024*1024),hash=createHash('sha256');let offset=0;
  try{while(offset<size){const read=fs.readSync(source,buffer,0,Math.min(buffer.length,size-offset),offset);if(!read)throw new Error('日志在快照期间截断');fs.writeSync(dest,buffer,0,read);hash.update(buffer.subarray(0,read));offset+=read;}}
  finally{fs.closeSync(source);fs.closeSync(dest);}
  report.logSnapshot.push({file:name,bytes:size,sha256:hash.digest('hex')});
  for(const line of fs.readFileSync(path.join(copy,name),'utf8').split('\n')){
   const match=/\[(operation|perf|compaction_route)\] (\{.*\})$/.exec(line);if(!match)continue;
   let row;try{row=JSON.parse(match[2]);}catch{continue;}
   const version=/pluginVersion=([\w.-]+)/.exec(line)?.[1]??'unknown';
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
 rawSummary.longestUnknownWaits.sort((a,b)=>b.unobservedMs-a.unobservedMs);rawSummary.longestUnknownWaits=rawSummary.longestUnknownWaits.slice(0,8);report.retainedEvidence=rawSummary;
 const beforeScan=require(path.join(temp,'old/diagnostics/scan.js')).scanPluginLogs,afterScan=require(path.join(root,'dist/test/diagnostics/scan.js')).scanPluginLogs;
 const request={kind:'general',hours:24,engine:'rules',fromMs:Date.parse('2026-10-20T02:23:58.648Z'),toMs:Date.parse('2026-10-21T02:23:58.648Z')};
 const summarize=r=>({coverage:r.coverage,summary:r.summary,general:r.general,loggingAudit:r.loggingAudit,
  performanceFindings:r.findings.filter(f=>/^(failure-|phase-|coverage|repeat)/.test(f.id)).map(f=>({id:f.id,evidence:f.evidence}))});
 report.before=summarize(await beforeScan(copy,()=>{},request));report.after=summarize(await afterScan(copy,()=>{},request));
 assert.deepEqual(report.before.summary,report.after.summary);assert.deepEqual(report.before.coverage,report.after.coverage);
 report.allRetained=summarize(await afterScan(copy,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()}));
 const med=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 report.comparison={progressBeforeMedianMs:med(report.progress.filter(x=>x.mode==='before').map(x=>x.completeMs)),progressAfterMedianMs:med(report.progress.filter(x=>x.mode==='after').map(x=>x.completeMs)),
  snapshotBeforeMedianMs:med(report.snapshot.filter(x=>x.mode==='before').map(x=>x.captureMs)),snapshotAfterMedianMs:med(report.snapshot.filter(x=>x.mode==='after').map(x=>x.captureMs))};
 report.limitations=['原始历史失败不因修复而删除；没有failureId的旧记录不擅自推断独立事故数。','历史最长未知等待、工具阶段及真实压缩耗时没有通过合成测试证明缩短。','新增快照一致性检查增加文件stat次数，安全收益与实测开销分别列出。','CLI内部遥测导出队列/重试/最终丢弃没有足够证据，不能宣称已恢复。'];
 fs.writeFileSync(path.join(root,'benchmarks/diagnostic-66f-results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({comparison:report.comparison,files:report.logSnapshot.length,before:report.before.summary,after:report.after.summary,allRetained:report.allRetained.summary},null,2));
})().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
