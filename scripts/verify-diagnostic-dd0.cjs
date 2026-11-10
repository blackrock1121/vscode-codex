// 同一输入对照固定基线和当前源码；仅本机模拟，不调用真实模型或系统通知。
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),Module=require('node:module');
const {execFileSync}=require('node:child_process'),{performance}=require('node:perf_hooks');
const assert=require('node:assert/strict'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),baseline='0a837d0',version=require('../package.json').version;
const overrides=['src/notifications.ts','src/panel/chatViewProvider.ts','src/codex/compactionRelay.ts','src/codex/performanceTrace.ts','src/codex/process.ts','src/codex/rpc.ts','src/diagnostics/general.ts','src/diagnostics/scan.ts','src/diagnostics/analysis.ts','src/diagnosticsReport.ts'];
const vscode={window:{state:{focused:true},onDidChangeWindowState:()=>({dispose(){}})},commands:{executeCommand:()=>new Promise(()=>{})},workspace:{}};
(async()=>{
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'codex-dd0-compare-'));
 try{
  const results={};
  for(const label of ['before','after']){
   const outfile=path.join(dir,label+'.cjs');
   const plugin={name:'fixed-baseline',setup(build){build.onLoad({filter:/\.ts$/},args=>{
    const relative=path.relative(root,args.path).split(path.sep).join('/');
    if(label==='before'&&overrides.includes(relative))return {contents:execFileSync('git',['show',baseline+':'+relative],{cwd:root,encoding:'utf8'}),loader:'ts'};
   });}};
   await esbuild.build({entryPoints:[path.join(root,'test/fixtures/diagnostic-safety.ts')],outfile,bundle:true,platform:'node',format:'cjs',external:['vscode'],plugins:[plugin]});
   const load=Module._load;let api;try{Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};api=require(outfile);}finally{Module._load=load;}
   const began=performance.now();let focus='completed';try{await api.focusNotificationWindow();}catch(e){focus=e.code;}
   const focusMs=Math.round(performance.now()-began);
   const events=[],p=new api.CodexProcess({codexPath:'/unused',cwd:root,permissionMode:'default'},{emit:e=>events.push(e),onPermission(){},onSessionId(){},onClose(){}});
   p.latency.begin('root',{});p.rpc.maxHandlerMs=350;if(p.rpc.turnTimings)p.rpc.turnTimings.handlerMs=350;
   p.latency.begin('root',{});p.latency.finish('completed');p.dispose();
   const summaries=events.filter(e=>e.kind==='diag'&&e.message.startsWith('[perf] ')).map(e=>JSON.parse(e.message.slice(7))).filter(r=>r.event==='turn_summary');
   const acc=new api.PerformanceAccumulator();summaries.forEach(r=>acc.add(r));
   const logs=path.join(dir,label);await fsp.mkdir(logs);
   const writer=new api.DailyLogWriter(logs,{pluginVersion:label==='before'?'0.1.206':version,windowId:'test',hostId:'test'});
   writer.write('[compaction_route] '+JSON.stringify({atMs:Date.now(),stage:'response',fromModel:'gpt-6-astra',fromEffort:'high',toModel:'gpt-6.1-sol',effort:'xhigh',serviceTier:null,configurationScope:'request_only',sessionConfigurationChanged:false}));
   writer.write('[transport] '+JSON.stringify({atMs:Date.now(),type:'event',event:'codex.api_request',success:false,failureCategory:'network_or_service'}));await writer.flush();
   const scan=await api.scanPluginLogs(logs,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()+1000});await writer.dispose();
   const evidence=scan.compactionEvidence[0];
   results[label]={focus,focusMs,handlerPeaks:summaries.map(r=>r.maxHandlerMs),hostFindings:acc.result().findings.find(r=>r.id==='host')?.occurrences,
    preservedCompactionFields:['fromEffort','configurationScope','sessionConfigurationChanged','serviceTier'].filter(k=>Object.hasOwn(evidence,k)),
    apiFailureCategory:scan.findings.find(r=>r.evidence.includes('codex.api_request'))?.category};
  }
  assert.equal(results.before.focus,'completed');assert.ok(results.before.focusMs>=1900);assert.equal(results.after.focus,'completed');assert.ok(results.after.focusMs<1000);
  assert.deepEqual(results.before.handlerPeaks,[350,350]);assert.deepEqual(results.after.handlerPeaks,[350,0]);
  assert.equal(results.after.preservedCompactionFields.length,4);assert.equal(results.after.apiFailureCategory,'后端服务');
  const output={diagnosticId:'dd0c053e-6cfe-4477-9bb8-2476a3aa2050',baseline,version,at:new Date().toISOString(),scope:'源码隔离模拟和日志落盘回扫，不是已安装扩展的运行复测',...results};
  await fsp.mkdir(path.join(root,'benchmarks'),{recursive:true});await fsp.writeFile(path.join(root,'benchmarks/diagnostic-dd0-comparison.json'),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
 }finally{await fsp.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
