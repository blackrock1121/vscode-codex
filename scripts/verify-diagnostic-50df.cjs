// 固定原版源码及同一日志长度快照；不改写用户日志，不调用模型/外部服务。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),logDir=process.argv[2],baseline='5597025';
if(!logDir)throw new Error('请提供原日志目录');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-50df-verify-')),beforeRoot=path.join(temp,'before');
const fromMs=Date.parse('2026-10-27T06:41:06.506Z'),toMs=Date.parse('2026-10-28T06:41:06.506Z');
const report={diagnosticId:'50df1fc5-257f-477b-8b26-9f0d1cebb198',baseline,createdAt:new Date().toISOString(),
 scope:'固定原版0.1.182与同一日志长度快照；跨版本/工作区/窗口。原报告24小时与全部保留日志分别统计。合成快照性能不代表模型或后端提速。'};
(async()=>{
 fs.mkdirSync(beforeRoot);
 const archive=execFileSync('git',['archive',baseline,'src','native','scripts/log-audit.cjs','package.json'],{cwd:root,maxBuffer:12*1024*1024});
 execFileSync('tar',['-x','-C',beforeRoot],{input:archive});fs.symlinkSync(path.join(root,'node_modules'),path.join(beforeRoot,'node_modules'),'dir');
 const manifest=require(path.join(beforeRoot,'scripts/log-audit.cjs')).buildLogAudit(beforeRoot).manifest;
 assert.equal(manifest.sourceHash,'afa499310bdac273504f865d8f866643b698fbf6669cc8f7e3ecd39bd3872641');
 report.baselineSourceHash=manifest.sourceHash;report.currentSourceHash=require('./log-audit.cjs').buildLogAudit(root).manifest.sourceHash;
 await require('esbuild').build({entryPoints:['diagnostics/scan','snapshot','codex/session','codex/process'].map(n=>path.join(beforeRoot,'src',n+'.ts')),outdir:path.join(temp,'old'),outbase:path.join(beforeRoot,'src'),bundle:true,platform:'node',format:'cjs',external:['vscode'],plugins:[require(path.join(beforeRoot,'scripts/log-audit.cjs')).logAuditPlugin(beforeRoot)]});
 const old={...require(path.join(temp,'old/snapshot.js')),...require(path.join(temp,'old/codex/session.js')),...require(path.join(temp,'old/codex/process.js'))};
 const next={...require(path.join(root,'dist/test/snapshot.js')),...require(path.join(root,'dist/test/codex/session.js')),...require(path.join(root,'dist/test/codex/process.js'))};
 const work=path.join(temp,'workspace');fs.mkdirSync(work);for(let i=0;i<500;i++)fs.writeFileSync(path.join(work,`source-${i}.ts`),'const source = 1;\n'.repeat(50));
 report.snapshot=[];
 for(let round=0;round<7;round++)for(const [mode,api] of round%2?[['after',next],['before',old]]:[['before',old],['after',next]]){
  const snapshot=new api.WorkspaceSnapshot([work]),open=fs.promises.open,at=performance.now();let reads=0;
  fs.promises.open=async(...args)=>{const h=await open(...args),read=h.read.bind(h);h.read=async(...p)=>{reads++;return read(...p);};return h;};
  try{await snapshot.capture();}finally{fs.promises.open=open;}
  const contentHash=createHash('sha256').update(JSON.stringify([...snapshot.files].sort())).digest('hex');
  report.snapshot.push({mode,round,files:snapshot.files.size,readCalls:reads,contentHash,captureMs:Math.round(performance.now()-at)});assert.equal(snapshot.files.size,500);
 }
 assert.equal(new Set(report.snapshot.map(r=>r.contentHash)).size,1);
 report.faults=[];
 for(const [mode,api] of [['before',old],['after',next]]){
  const dir=path.join(temp,'missing-'+mode);fs.mkdirSync(dir);const file=path.join(dir,'source.ts');fs.writeFileSync(file,'existing');
  const snapshot=new api.WorkspaceSnapshot([dir]),read=snapshot.read.bind(snapshot);snapshot.read=async p=>{fs.unlinkSync(p);return read(p);};
  await snapshot.capture();snapshot.read=read;fs.writeFileSync(file,'reappeared');const changes=await snapshot.changed();
  const store=new api.SessionStore(dir,()=>'/unused');let calls=0;
  const rpc={runId:'00000000-0000-0000-0000-000000000001',isClosed:false,dispose(){},async request(method){
   if(method==='thread/read')return {thread:{id:'thread',historyMode:'paginated'}};
   return {data:[{id:'duplicate',items:[]}],nextCursor:++calls===1?'next':null};
  }};
  store.connection=async()=>rpc;store.rpc=rpc;let duplicateRejected=false;
  try{await store.hydrate('thread');}catch(e){assert.equal(e.name,'SyntaxError');duplicateRejected=true;}finally{store.dispose();}
  const p=new api.CodexProcess({codexPath:'/unused',cwd:dir,permissionMode:'default',compactionAutoValidate:false},{emit(){},onPermission(){},onSessionId(){},onClose(){}});
  p.busy=true;p.sessionId='root';p.ensureChild=async()=>true;p.childNotification=()=>{throw new TypeError('synthetic');};
  p.routeChildNotification({method:'turn/started',params:{threadId:'child'}});await new Promise(r=>setImmediate(r));
  report.faults.push({mode,reappearedClassifiedAsNew:changes.has(file)&&changes.get(file)===null,unrestorable:snapshot.unrestorableChanges.has(file),duplicateHistoryRejected:duplicateRejected,childCallbackBusyAfterFailure:p.isBusy});p.dispose();
 }
 assert.equal(report.faults[0].duplicateHistoryRejected,false);assert.equal(report.faults[1].duplicateHistoryRejected,true);
 assert.equal(report.faults[0].childCallbackBusyAfterFailure,true);assert.equal(report.faults[1].childCallbackBusyAfterFailure,false);
 assert.equal(report.faults[0].unrestorable,false);assert.equal(report.faults[1].unrestorable,true);
 const copy=path.join(temp,'logs');fs.mkdirSync(copy);report.logSnapshot=[];
 const afterApi=require(path.join(root,'dist/test/diagnostics/scan.js'));
 const evidence={remoteDisconnects:[],remoteTerminals:[],accountFailureChains:[],accountLaterSuccesses:[],streamErrors:[],streamTerminals:[],systemSkillsFailures:[],longestTurn:null};
 const accountFailures=new Map(),streamTraces=new Set();
 const names=fs.readdirSync(logDir).filter(n=>/^codex-chat-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
 for(const name of names){
  const file=path.join(logDir,name),size=fs.statSync(file).size,input=fs.openSync(file,'r'),output=fs.openSync(path.join(copy,name),'w',0o600),buffer=Buffer.alloc(1024*1024),hash=createHash('sha256');let offset=0;
  try{while(offset<size){const n=fs.readSync(input,buffer,0,Math.min(buffer.length,size-offset),offset);if(!n)throw new Error('日志快照期间被截断');fs.writeSync(output,buffer,0,n);hash.update(buffer.subarray(0,n));offset+=n;}}
  finally{fs.closeSync(input);fs.closeSync(output);}
  report.logSnapshot.push({file:name,bytes:size,sha256:hash.digest('hex')});let lineNumber=0;
  for(const line of fs.readFileSync(path.join(copy,name),'utf8').split('\n')){
   lineNumber++;const match=/\[(operation|perf|transport|compaction|compaction_route)\] (\{.*\})$/.exec(line);if(!match)continue;
   let r;try{r=JSON.parse(match[2]);}catch{continue;}
   const identity=/pluginVersion=([\w.-]+) windowId=([\w.-]+)/.exec(line),at=afterApi.diagnosticLogTime(line,name,r),inWindow=at>=fromMs&&at<=toMs;
   const safe=()=>Object.fromEntries(Object.entries({file:name,line:lineNumber,version:identity?.[1],windowId:identity?.[2],atMs:at,operation:r.operation,stage:r.stage,event:r.event,method:r.method,processRunId:r.processRunId,failureId:r.failureId,traceId:r.traceId,outcome:r.outcome,exitCode:r.exitCode,reason:r.reason}).filter(([,v])=>v!==undefined));
   if(r.operation==='remote.connection'&&inWindow){if(r.stage==='disconnected')evidence.remoteDisconnects.push(safe());else if(['recovered','ready','cancelled'].includes(r.stage))evidence.remoteTerminals.push(safe());}
   const key=[identity?.[1],identity?.[2],r.processRunId,r.method].join(':');
   if(inWindow&&r.operation==='rpc.request'&&r.method?.startsWith('account/')&&r.outcome==='failed'){
    const item=safe();accountFailures.set(key,item);evidence.accountFailureChains.push(item);
   }
   if(r.operation==='rpc.request'&&r.outcome==='completed'&&accountFailures.has(key)){
    const failure=accountFailures.get(key);evidence.accountLaterSuccesses.push({...safe(),previousFailureId:failure.failureId,association:'同版本/窗口/进程/method 后续成功；历史未明确声明 recovery'});accountFailures.delete(key);
   }
   if(inWindow&&r.event==='codex.sse_event'&&r.hasError){evidence.streamErrors.push(safe());if(r.traceId)streamTraces.add(r.traceId);}
   if(r.event==='turn_summary'&&streamTraces.has(r.traceId))evidence.streamTerminals.push(safe());
   if(inWindow&&/failed to install system skills/.test(String(r.message??'')))evidence.systemSkillsFailures.push({...safe(),source:'CLI codex_skills_extension，目录非空；不据此推断竞争或插件缺陷'});
   if(inWindow&&r.event==='turn_summary'&&(!evidence.longestTurn||r.elapsedMs>evidence.longestTurn.elapsedMs))evidence.longestTurn={...safe(),elapsedMs:r.elapsedMs,phasesMs:r.phasesMs,unobservedReasonsMs:r.unobservedReasonsMs};
  }
 }
 report.retainedEvidence=evidence;
 const beforeScan=require(path.join(temp,'old/diagnostics/scan.js')).scanPluginLogs;
 const summarize=r=>({coverage:r.coverage,summary:r.summary,general:r.general,performanceFindings:r.findings.filter(f=>/^(failure-|phase-|coverage|repeat)/.test(f.id)).map(f=>({id:f.id,evidence:f.evidence})),categories:[...new Set(r.findings.map(f=>f.category).filter(Boolean))]});
 const request={kind:'general',engine:'rules',hours:24,fromMs,toMs};
 report.before=summarize(await beforeScan(copy,()=>{},request));report.after=summarize(await afterApi.scanPluginLogs(copy,()=>{},request));
 assert.deepEqual(report.before.summary,report.after.summary);assert.deepEqual(report.before.coverage,report.after.coverage);
 assert.equal(report.before.general.errors,report.after.general.errors);assert.equal(report.before.general.recoveries,report.after.general.recoveries);
 report.allRetained=summarize(await afterApi.scanPluginLogs(copy,()=>{},{kind:'general',engine:'rules',hours:0,toMs:Date.now()}));
 const median=v=>[...v].sort((a,b)=>a-b)[Math.floor(v.length/2)],metric=(mode,key)=>median(report.snapshot.filter(r=>r.mode===mode).map(r=>r[key]));
 report.comparison={snapshotBeforeMedianMs:metric('before','captureMs'),snapshotAfterMedianMs:metric('after','captureMs'),snapshotBeforeReadCalls:metric('before','readCalls'),snapshotAfterReadCalls:metric('after','readCalls'),faults:report.faults,
 historicalErrorsBefore:report.before.general.errors,historicalErrorsAfter:report.after.general.errors,historicalRecoveries:report.after.general.recoveries,explicitlyLinkedHistoricalRecoveries:report.after.general.linkedRecoveries??0};
 report.limitations=['历史错误不会因修复被删除；旧 recovery 缺少关联 ID 时不追认恢复。','相同输入快照读取次数是稳定指标，墙钟耗时受缓存/负载影响；没有证明后端、工具或模型请求整体缩短。','原版最长轮次包含用户等待，不能视为连续模型计算。','日志是内容只读数据，没有执行其中命令，也不保存正文/完整工具输出。'];
 fs.writeFileSync(path.join(root,'benchmarks/diagnostic-50df-results.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({comparison:report.comparison,files:report.logSnapshot.length,evidenceCounts:Object.fromEntries(Object.entries(evidence).map(([k,v])=>[k,Array.isArray(v)?v.length:v])),before:report.before.summary,allRetained:report.allRetained.summary},null,2));
})().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(e=>{console.error(e);process.exitCode=1;});
