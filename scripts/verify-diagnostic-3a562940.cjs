// 同一日志快照、同一失败负载对照；不修改保留日志，不发起真实模型/账号请求。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),Module=require('node:module');
const root=path.resolve(__dirname,'..'),[reportPath,logDir]=process.argv.slice(2),baseline='fa856e6';
if(!reportPath||!logDir)throw Error('请提供完整报告文件及保留日志目录');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-3a562940-verify-'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const summarize=r=>({coverage:r.coverage,summary:r.summary,general:r.general,
 notificationFindings:r.findings.filter(f=>/notification\.(?:click|focus)|\[notify\] click_error/.test(f.evidence)).map(f=>({category:f.category,occurrences:f.occurrences}))});
async function polling(api,message){
 const original=Date.now;let clock=original(),requests=0;const rows=[];
 api.setOperationLogSink(line=>rows.push(JSON.parse(line.slice('[operation] '.length))));
 Date.now=()=>clock;
 try{
  const p=Object.create(api.ChatViewProvider.prototype);
  Object.assign(p,{usageInFlight:false,lastUsageAt:0,disposed:false,sessions:new Set(),
   store:{read:async()=>{requests++;throw new Error(message);}},post(){}});
  for(let i=0;i<480;i++){p.fetchUsage();await tick();clock+=180000;}
  return {simulatedHours:24,pollTicks:480,requests,operationErrors:rows.filter(r=>r.stage==='failed').length};
 }finally{Date.now=original;api.setOperationLogSink();}
}
async function internalFailure(api,event){
 const rows=[];api.setOperationLogSink(line=>rows.push(JSON.parse(line.slice('[operation] '.length))));
 const p=new api.CodexProcess({codexPath:path.join(root,'test/fake-codex.cjs'),cwd:root,transportDiagnostics:false,permissionMode:'default'},
  {emit(){},onPermission(){},onSessionId(){},onClose(){}});
 try{
  await p.rpc.start();p.busy=true;p.sessionId='thread';
  const started=performance.now(),pending=p.rpc.request('hang',{},100).then(()=>({outcome:'completed'}),error=>({outcome:error.errorOrigin,errorType:error.name}));
  if(event==='notification')p.rpc.emit('notification',{method:'turn/completed',params:{}});
  else {p.request=async()=>{throw new TypeError('injected');};p.rpc.emit('request',{id:'injected',method:'item/tool/call'});}
  const outcome=await pending;
  return {injectedTimeoutMs:100,...outcome,releaseMs:Math.round(performance.now()-started),closedBeforeCleanup:p.rpc.isClosed,
   busyAfterFailure:p.isBusy,internalErrorLogs:rows.filter(r=>r.operation===`process.${event}`&&r.stage==='failed').length};
 }finally{await p.disposeAndWait();api.setOperationLogSink();}
}
(async()=>{
 const body=fs.readFileSync(reportPath,'utf8'),reportLocations=[...body.matchAll(/^- (src\/[^:]+):(\d+) · ([^：]+)：([^\n]+)/gm)];
 const cutoff=Date.now(),logs=path.join(temp,'logs');fs.mkdirSync(logs);
 const retained=[];
 for(const file of fs.readdirSync(logDir).filter(name=>/^codex-chat-\d{4}-\d{2}-\d{2}\.log$/.test(name)).sort()){
  const bytes=fs.readFileSync(path.join(logDir,file));fs.writeFileSync(path.join(logs,file),bytes);
  retained.push({file,bytes:bytes.length,sha256:hash(bytes)});
 }
 const archive=execFileSync('git',['archive',baseline,'src','native','scripts/log-audit.cjs','package.json','test/fixtures/diagnostic-safety.ts'],{cwd:root,maxBuffer:16*1024*1024});
 execFileSync('tar',['-x','-C',temp],{input:archive});fs.symlinkSync(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir');
 const beforeFile=path.join(temp,'baseline.cjs');
 await require('esbuild').build({entryPoints:[path.join(temp,'test/fixtures/diagnostic-safety.ts')],outfile:beforeFile,bundle:true,platform:'node',format:'cjs',external:['vscode'],
  plugins:[require(path.join(temp,'scripts/log-audit.cjs')).logAuditPlugin(temp)]});
 const load=Module._load;let before,after;
 try{Module._load=function(name,...args){return name==='vscode'?{window:{},workspace:{}}:load.call(this,name,...args);};before=require(beforeFile);after=require(path.join(root,'dist/test/diagnostic-safety.js'));}finally{Module._load=load;}
 const replay={};
 for(const [scope,range]of Object.entries({diagnosed:{hours:24,fromMs:Date.parse('2026-10-21T08:15:24.296Z'),toMs:Date.parse('2026-10-22T08:15:24.296Z')},allRetained:{hours:0,toMs:cutoff}})){
  const request={kind:'performance',engine:'rules',...range};
  replay[scope]={before:summarize(await before.scanPluginLogs(logs,()=>{},request)),after:summarize(await after.scanPluginLogs(logs,()=>{},request))};
 }
 const loadComparison={};
 for(const [scenario,message]of Object.entries({authentication:'401 Unauthorized',permission:'HTTP 403',network:'error sending request'}))
  loadComparison[scenario]={before:await polling(before,message),after:await polling(after,message)};
 const internalFailureComparison={};
 for(const event of ['notification','request'])internalFailureComparison[event]={before:await internalFailure(before,event),after:await internalFailure(after,event)};
 const manifest=require('./log-audit.cjs').buildLogAudit(root).manifest;
 const result={diagnosticId:'3a562940-b292-4015-93f5-0eed8462687d',baseline,baselineVersion:'0.1.165',version:manifest.version,
  report:{bytes:Buffer.byteLength(body),sha256:hash(body),sourceLocations:reportLocations.length,
   conclusion:'已读取完整报告；原速度诊断没有源码位置，不能把未提供位置当成已完成源码审查。'},
  retained,replay,loadComparison,internalFailureComparison,
  source:{sourceHash:manifest.sourceHash,files:manifest.files.map(f=>({file:f.file,sha256:f.sha256,candidates:f.candidates})),unsupported:manifest.unsupported,
   conclusion:'保留当前构建全部静态候选作为待核验线索；以下是本次沿实际调用链检查的范围，不将候选数量当作缺陷数。'},
  reviewedChains:[
   {files:['src/extension.ts','src/logging.ts','src/codex/rpc.ts','src/codex/session.ts'],result:'激活、RPC start/ready/end、同步及异步断管、超时 pending 释放、一次只读重连均已有日志和回归；未把历史 0.1.150 unknown 全部认定为 EPIPE。',tests:['rpc','logging','metadata','diagnostic-66f-fix','diagnostic-87cc-fix','connection-diagnostics-fix']},
   {files:['src/panel/chatViewProvider.ts','src/codex/session.ts'],result:'修复额度轮询无退避、认证/访问拒绝持续请求，以及账号更新期间迟到用量覆盖。开始/完成/取消/失败/恢复落盘，恢复只在实际成功后记录。',tests:['diagnostic-3a562940-fix','diagnostic-3a1-fix','notifications']},
   {files:['src/codex/process.ts'],result:'notification/request 委派 catch 原先只调用 error() 发页面消息，无内部日志且保留损坏状态；现记录安全失败、终结 trace 并释放进程，禁止自动重放业务请求。',tests:['diagnostic-3a562940-fix','stop-recovery','core']},
   {files:['src/codex/process.ts','src/codex/compactionRelay.ts'],result:'路由仅改请求，未改会话配置；兼容手动压缩已有 restore start/completed/failed/cancelled。200ms 启动预算降级沿原生路径，不强制迟到接管。保留模型、effort、服务档位和权限。',tests:['compaction','compaction-relay','connection-diagnostics-fix','diagnostic-87cc-fix']},
   {files:['src/panel/chatViewProvider.ts','src/webview/main.ts','src/webview/errors.ts','src/imageFile.ts','src/webviewDelivery.ts'],result:'页面投递失败/恢复有统一出口，文件读取有限额，图片类型及失败占位/手动重载已有回归。本次修复预览关闭写空 src 造成无效加载；历史七次错误仍不能全部据此归因。',tests:['webview','diagnostic-66f-fix','diagnostic-03eb-fix']},
   {files:['src/notifications.ts','src/notificationRouter.ts','src/panel/chatViewProvider.ts','src/operations.ts','src/diagnostics/general.ts'],result:'本机投递、聚焦已有操作终态；修复重复点击并发打开、跨层无共享 failureId、click 被 CLI 子串误判为连接故障。取消保持取消。原生权限/送达仍由 helper 结果交父进程，不重写原生逻辑。',tests:['notification-router','notifications','notification-ownership','diagnostic-3a562940-fix']},
   {files:['src/codex/performanceTrace.ts','src/codex/telemetry.ts','src/diagnostics/general.ts','src/diagnostics/analysis.ts'],result:'工具生命周期由后端执行，插件观测首次/末次输出、终态和计时；保留工具失败来源，新增同窗口同轮次或进程 callId 的双观测关联，不猜测不同编号父子关系。未修改工具超时阈值或杀除用户后台任务。',tests:['performance-trace','telemetry','diagnostics-accuracy-fix','diagnostic-3a562940-fix']},
   {files:['src/codex/performanceTrace.ts','src/codex/rpc.ts','src/codex/telemetry.ts','src/diagnosticsReport.ts'],result:'已有本地接收时间、后端白名单 timing、30秒心跳、用户等待和不完整终态；未知长等待保留未知。遥测导出失败已有每分钟30条上限并归遥测，不把导出恢复推成主连接恢复。',tests:['performance-trace','telemetry','connection-diagnostics-fix']},
   {files:['src/panel/chatViewProvider.ts','src/codex/session.ts'],result:'修复会话标题只有一次后端写入，失败在 session.repair.title 落盘，创建会话的主 Promise 不因此失败；无自动无限修复。设置队列的 catch 仅释放后续任务，原 task 返回给调用方。',tests:['diagnostics','session-selection','session-model','edit-message']},
  ],
  limitations:['历史日志没有命令/工具输出/凭据，无法还原每条工具错误的业务根因。','对照是相同日志及合成失败负载；不是跨版本真实用户任务耗时提升证明。','认证/权限拒绝未被推断为凭据过期。未改变登录状态、全局网络、系统通知权限、模型或档位。','现有源码与新故障注入结论仅适用于当前修复构建，不追溯套用历史版本。','Swift 仍无自动源码覆盖规则；未发送真实通知，未执行收费压缩或远端遥测故障注入。']};
 fs.mkdirSync(path.join(root,'benchmarks'),{recursive:true});fs.writeFileSync(path.join(root,'benchmarks/diagnostic-3a562940.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({report:result.report,loadComparison,internalFailureComparison,replay:Object.fromEntries(Object.entries(replay).map(([k,v])=>[k,{before:v.before.general,after:v.after.general}])),sourceFiles:manifest.files.length,sourceCandidates:manifest.files.reduce((n,f)=>n+f.candidates.length,0)},null,2));
})().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
