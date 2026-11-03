// 固定源码与日志长度回放；日志只作为数据，不执行其中内容，不写用户配置。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),baseline='0440923',id='4d94bbc6-a6ea-4687-9b49-0c8539141058';
const home=path.join(os.homedir(),'.codex-chat'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-4d94-verify-'));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
(async()=>{
 const oldRoot=path.join(temp,'before');fs.mkdirSync(oldRoot);
 const archive=execFileSync('git',['archive',baseline,'src','native','scripts/log-audit.cjs','package.json'],{cwd:root,maxBuffer:16*1024*1024});
 execFileSync('tar',['-x','-C',oldRoot],{input:archive});fs.symlinkSync(path.join(root,'node_modules'),path.join(oldRoot,'node_modules'),'dir');
 const fixture=fs.readFileSync(path.join(root,'test/fixtures/diagnostic-safety.ts'),'utf8').replaceAll('../../src/','./src/');
 const oldApi=path.join(temp,'before.cjs');
 await require('esbuild').build({stdin:{contents:fixture,resolveDir:oldRoot},outfile:oldApi,bundle:true,platform:'node',format:'cjs',external:['vscode'],plugins:[require(path.join(oldRoot,'scripts/log-audit.cjs')).logAuditPlugin(oldRoot)]});
 const regression=spawnSync(process.execPath,['--test','test/diagnostic-4d94-fix.test.cjs'],{cwd:root,env:{...process.env,DIAGNOSTIC_4D94_API:oldApi},encoding:'utf8',timeout:30000});
 if(regression.error)throw regression.error;
 assert.equal(regression.status,1,'基线应触发已确认的回归断言');
 const baselineTests={exitCode:regression.status,pass:Number(regression.stdout.match(/# pass (\d+)/)?.[1]),fail:Number(regression.stdout.match(/# fail (\d+)/)?.[1])};
 assert.equal(baselineTests.fail,6); // 成功、失败与恢复断言在旧构建中必须证明差异。
 const load=require('node:module')._load;let old;
 try{require('node:module')._load=function(name,...args){return name==='vscode'?{}:load.call(this,name,...args);};old=require(oldApi);}finally{require('node:module')._load=load;}
 const next=require('../dist/test/diagnostics/scan.js'),record=JSON.parse(fs.readFileSync(path.join(home,'diagnostics',id+'.json'),'utf8'));
 const report=fs.readFileSync(path.join(home,'diagnostics',id+'.report.md'),'utf8');
 const snapshot=path.join(temp,'logs');fs.mkdirSync(snapshot);const files=[];
 for(const name of fs.readdirSync(path.join(home,'logs')).filter(n=>/^codex-chat-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort()){
  const input=fs.openSync(path.join(home,'logs',name),'r'),size=fs.fstatSync(input).size,output=fs.openSync(path.join(snapshot,name),'w',0o600),digest=crypto.createHash('sha256');
  try{let offset=0;const b=Buffer.alloc(1024*1024);while(offset<size){const n=fs.readSync(input,b,0,Math.min(b.length,size-offset),offset);if(!n)throw Error('日志快照被截短');fs.writeSync(output,b,0,n);digest.update(b.subarray(0,n));offset+=n;}}
  finally{fs.closeSync(input);fs.closeSync(output);}files.push({name,bytes:size,sha256:digest.digest('hex')});
 }
 const summarize=r=>({summary:r.summary,coverage:r.coverage,general:r.general,findingsByCategory:Object.fromEntries([...new Set(r.findings.map(f=>f.category??'性能阶段/工具分类'))].map(c=>[c,r.findings.filter(f=>(f.category??'性能阶段/工具分类')===c).length]))});
 const before=await old.scanPluginLogs(snapshot,()=>{},record.options),after=await next.scanPluginLogs(snapshot,()=>{},record.options);
 const {longestTurn,...unchangedSummary}=after.summary;
 assert.deepEqual(before.summary,unchangedSummary);assert.deepEqual(before.coverage,after.coverage);assert.deepEqual(before.general,after.general);
 const allRetained=await next.scanPluginLogs(snapshot,()=>{},{kind:'general',engine:'rules',hours:0,toMs:record.options.toMs});
 const selected=new Set(['f8e60f6d-73da-4373-8442-98b05174e2e8','e44ce531-bb50-4356-9edd-2b21ab36c909','6b29ca1b-8d1d-4f76-a502-ba62bb8d0da6']);
 const failures=new Set(['a4b11ad9-b245-4652-8130-c4b311a67baf','32203c32-4bd1-4a8f-bc25-cee1f74a2ac2','336f0770-bd88-4e36-b1fa-31cd0b269fda']);
 const evidence=[],signals={mcp403:0,modelCatalogTimeout:0,systemSkillsInstall:0},unknownTimeByFile={};
 const keys=['event','operation','method','stage','outcome','traceId','operationId','processRunId','failureId','previousFailureId','requestId','routeId','connectionId','elapsedMs','durationMs','reason','scope','phasesMs','model','effort','serviceTier','rpcCode'];
 for(const file of files){let lineNo=0;for(const line of fs.readFileSync(path.join(snapshot,file.name),'utf8').split('\n')){lineNo++;if(!line)continue;const m=/\[(perf|transport|operation|compaction|compaction_route)\] (\{.*\})$/.exec(line);let row;
  if(m){try{row=JSON.parse(m[2]);}catch{continue;}}
  const at=next.diagnosticLogTime(line,file.name,row);if(at===undefined){unknownTimeByFile[file.name]=(unknownTimeByFile[file.name]??0)+1;continue;}
  if(at<record.options.fromMs||at>record.options.toMs||!row)continue;
  if(row.httpStatusCode===403&&row.targetKind==='mcp_transport')signals.mcp403++;
  if(/codex_models_manager.*failed to refresh available models.*timed out/.test(row.message??''))signals.modelCatalogTimeout++;
  if(/codex_skills_extension.*failed to install system skills/.test(row.message??''))signals.systemSkillsInstall++;
  if((selected.has(row.traceId)&&(['turn_summary','retry'].includes(row.event)||['end','response','request','usage_updated'].includes(row.stage)&&['compaction','compaction_route'].includes(m[1])))||failures.has(row.failureId)||failures.has(row.previousFailureId)||row.processRunId==='f1f6b5b6-581f-4fa9-9677-4642a993274d'&&(['config/read','getAuthStatus','thread/resume'].includes(row.method)||m[1]==='compaction_route'))evidence.push({file:file.name,line:lineNo,atMs:at,...Object.fromEntries(keys.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]))});
 }}
 // 本机 CLI 原生协议复验，只建临时线程和改名，不发 turn/start，不读取或复制凭据。
 const {CodexRpc}=require('../dist/test/codex/rpc.js'),{CodexProcess}=require('../dist/test/codex/process.js'),{SessionStore}=require('../dist/test/codex/session.js');
 const cliHome=path.join(temp,'cli');fs.mkdirSync(cliHome);const a=new CodexRpc('codex',cliHome,{CODEX_HOME:cliHome}),b=new CodexRpc('codex',cliHome,{CODEX_HOME:cliHome});let titleProbe;
 try{await a.start();await b.start();const r=await a.request('thread/start',{cwd:cliHome,model:'gpt-6-astra',approvalPolicy:'never',sandbox:'read-only'});
  let rejected;const beforeAt=performance.now();try{await b.request('thread/name/set',{threadId:r.thread.id,name:'诊断临时测试'});}catch(e){rejected=e;}
  assert.equal(rejected?.rpcCode,-32600);assert.match(rejected.message,/no rollout found/);const beforeMs=performance.now()-beforeAt;
  const owner=new CodexProcess({cwd:cliHome,codexPath:'codex',permissionMode:'default'}, {emit(){},onClose(){},onSessionId(){},onPermission(){}});owner.rpc=a;owner.sessionId=r.thread.id;
  const store=new SessionStore(cliHome,()=> 'codex');store.connection=async()=>assert.fail('不能走管理连接');const afterAt=performance.now();await store.setCustomTitle(r.thread.id,'诊断临时测试',owner);
  titleProbe={before:{outcome:'failed',rpcCode:rejected.rpcCode,reason:'no_rollout',durationMs:Math.round(beforeMs)},after:{outcome:'completed',durationMs:Math.round(performance.now()-afterAt)},generationRequests:0};
 }finally{await Promise.all([a.disposeAndWait(),b.disposeAndWait()]);}
 const result={diagnosticId:id,baseline,currentVersion:require('../package.json').version,baselineTests,titleProbe,
  report:{bytes:Buffer.byteLength(report),lines:report.split('\n').length,sha256:hash(report),sourceCandidatesInOriginal:[...report.matchAll(/^- src\/[^:]+:\d+ ·/gm)].length},
  files,before:summarize(before),after:summarize(after),allRetained:summarize(allRetained),historicalEvidence:{signals,unknownTimeByFile,evidence},
  limitations:['所有保留文件在固定长度快照上读取；24 小时与全部保留口径分别报告。未修改或删除原日志。','原始报告未含源码候选；另附当前构建审查清单，规则候选不是已确认缺口。','历史 HTTP403/503、容量、限流、模型目录刷新和技能安装无法由本机改动证明恢复。','工具失败未整体归因插件；历史缺失的命令正文、休眠与请求关联不能补造。','合成超时、取消和断流测试不证明真实后端任务总耗时降低；未做收费生成。']};
 fs.writeFileSync(path.join(root,'benchmarks/diagnostic-4d94-results.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({baselineTests,titleProbe,report:result.report,files:files.length,historical24h:after.summary,allRetained:allRetained.summary,signals},null,2));
})().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
