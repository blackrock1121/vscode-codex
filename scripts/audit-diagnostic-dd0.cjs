// 只读指定报告、台账和日志，输出有界结构化证据；不执行日志正文，不修改台账。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline');
const root=path.resolve(__dirname,'..'),base=process.argv[2];if(!base)throw Error('请指定 .codex-chat 目录');
const diagnosticId='dd0c053e-6cfe-4477-9bb8-2476a3aa2050',batchId='d806c02c-42c6-4bf5-aef4-e72f7bd0d71b';
const report=fs.readFileSync(path.join(base,'diagnostics',diagnosticId+'.report.md'),'utf8');
const ledger=JSON.parse(fs.readFileSync(path.join(base,'diagnostics/tracking/ledger.json'),'utf8'));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const fields=['atMs','event','stage','operation','operationId','failureId','traceId','threadId','processRunId','connectionId','itemId','call_id','tool','tool_name','kind','outcome','exitCode','failureCategory','failureEvidence','errorType','errorCode','reason','phase','durationMs','elapsedMs','firstOutputMs','outputIdleMs','httpStatusCode','targetKind','targetService','responseKind','model','fromModel','toModel','fromEffort','effort','serviceTier','configurationScope','sessionConfigurationChanged','maxHandlerMs','maxDecodeMs','maxEventLoopDelayMs','incompleteSpans','droppedSpans','method','type','success'];
const select=r=>Object.fromEntries(fields.filter(k=>['string','number','boolean'].includes(typeof r[k])||r[k]===null).map(k=>[k,r[k]]));
const sections=new Map([...report.matchAll(/^## ([^\n]+) · (log-[a-f\d]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map(m=>[m[2],m[3]]));
const references=new Map();for(const [id,section]of sections)for(const match of section.matchAll(/(codex-chat-\d{4}-\d\d-\d\d\.log):(\d+)/g))references.set(match[1]+':'+match[2],{findingId:id,file:match[1],line:Number(match[2])});
const rows=[],samples=new Map(),from=Date.parse('2026-11-09T02:59:16.033Z'),to=Date.parse('2026-11-10T02:59:16.033Z');
(async()=>{
 for(const file of [...new Set([...references.values()].map(r=>r.file))]){let n=0;const filePath=path.join(base,'logs',file);
  for await(const line of readline.createInterface({input:fs.createReadStream(filePath),crlfDelay:Infinity})){
   n++;const key=file+':'+n,match=line.match(/\[(perf|operation|transport|compaction|compaction_route)\] (\{.*\})$/);let row;
   if(match){try{row=JSON.parse(match[2]);}catch{throw Error('结构化证据解析失败 '+key);}}
   const version=line.match(/pluginVersion=([^ ]+)/)?.[1],windowId=line.match(/windowId=([^ ]+)/)?.[1];
   const iso=line.match(/\[(\d{4}-\d\d-\d\dT[^\]]+)\]/)?.[1];const at=iso?Date.parse(iso):row?.receivedAtMs??row?.atMs;
   if(references.has(key))samples.set(key,{...references.get(key),version,windowId,...(row?select(row):{structured:false,elapsedMs:Number(line.match(/elapsedMs=(\d+)/)?.[1])||undefined})});
   if(row&&at>=from&&at<=to)rows.push({file,line:n,version,windowId,...select(row),messageClass:/failed to refresh available models/.test(String(row.message))?'model_catalog':/BatchLogProcessor.ExportError/.test(String(row.message))?'telemetry_export':undefined});
  }
 }
 const reviews={
  'src/codex/rpc.ts':'JSON/信封失败进入 rpc.process；写入失败结算所有 pending；请求错误/超时有 rpc.request 终态。原 maxHandlerMs/maxDecodeMs 为进程累计，本次分离轮次窗口并保留 processMax。CLI stderr 工具错误不是扩展宿主异常；模型目录刷新与遥测导出分开。',
  'src/codex/process.ts':'send/compact 以 PerformanceTrace.begin 开始；finish/stop/dispose 负责终态。compactionRouted 已写 request_only 和 sessionConfigurationChanged=false，自动压缩不修改共享配置；旧兼容路径有 compaction.restore 开始、成功、失败和取消。此次没有更改选模、推理、服务档位及权限。',
  'src/codex/performanceTrace.ts':'工具 started/completed、首次输出/静默、审批、取消和 finish 已有日志。非零退出分类不是根因。缺失子线程终态会保留 incomplete；不能凭退出码143猜取消来源。轮次开始重置处理计时窗口，旧轮次先结算。',
  'src/codex/session.ts':'read/hydrate/RPC统一记录；readMetadata catch 清理失败缓存后重抛，非吞错。模型列表和对话连接独立，断线只对只读请求恢复一次。',
  'src/codex/compactionRelay.ts':'非 responses 路由按原字节透传；HTTP/WS已统一终态，解析/URL非匹配为正常降级。本次补安全路由类别、请求是否改写、响应类型和已知错误码，400与提前断流原因分开；没有改写图像请求或重试。历史400正文已丢弃，不能补出其业务根因。',
  'src/notifications.ts':'show/clear/focus 经 observeOperation。原 chmod 在 try 外会遗留临时目录，finally rm 抛错会覆盖主错误；本次修复并为清理错误单独落盘。确认超时补 ETIMEDOUT 与 await_result，成功/失败状态保留。队列 catch 只保证下一动作继续，原 promise 仍交回调用方。',
  'src/notificationRouter.ts':'点击在 observeOperation notification.click 下，透传失败为500；prepared不代表聚焦。并发点击共用运行操作；未知/失效窗口拒绝。',
  'src/panel/chatViewProvider.ts':'页面消息顶层、配置持久化、历史读取、发送准备、通知和图片读取有统一错误边界。首次历史 Promise 的空 catch 仅提前观察拒绝，ready 后统一处理；修复会话标题 catch 已由 observeOperation 记录。此次修复原生点击 missing_session 返回伪成功。通知失败已有 webhook fallback，不擅自发送新消息。',
  'src/webviewDelivery.ts':'页面投递失败和恢复统一由 postWebviewMessage 记录，不在每个调用点重复埋点。',
  'src/imageFile.ts':'文件句柄 try/finally、有界读取；宿主 loadLocalImage 记录 start/completed/unavailable/failed。两条历史missing_or_unresolved不足以断言脚本崩溃。',
  'src/diagnostics/scan.ts':'完整扫描和时间过滤独立；原压缩摘要白名单漏掉配置范围、false和原effort，本次保留已有证据，不补造历史未知值。',
  'src/diagnostics/general.ts':'failureId和同窗口callId已去重；不猜不同ID的父子关系。本次把 API/websocket 后端失败从插件运行分类中分开。',
  'src/codex/telemetry.ts':'接收/解码/回调失败都有日志；字段白名单不保存工具正文，未知原因保持未知。导出重置来自CLI采集链，不能推断主RPC断开。',
  'src/codex/executionPolicy.ts':'已有前置检查、按失败原因处理、只并发独立操作和避免重复验证的指令。插件不拥有外部工具的命令、会话ID或进程终止生命周期，不通过改权限或自动重跑掩盖失败。'
 };
 const manifest=require('./log-audit.cjs').buildLogAudit(root).manifest;
 const output={diagnosticId,batchId,baseline:'0a837d0',version:require('../package.json').version,at:new Date().toISOString(),reportSha256:sha(report),reportLines:report.split('\n').length,
  reportSourceCoverage:'报告明确未包含源码规则审查；以下是本次额外核验的调用链，不代表全部源码分支均动态测试。',
  sourceHash:manifest.sourceHash,sourceReview:Object.entries(reviews).map(([file,review])=>({file,sha256:sha(fs.readFileSync(path.join(root,file))),candidates:manifest.files.find(f=>f.file===file)?.candidates,review})),
  issues:ledger.batches[batchId].issueIds.map(issueId=>{const findingId=ledger.records[diagnosticId].ids[issueId][0];return {issueId,findingId,title:ledger.issues[issueId].title,samples:[...samples.values()].filter(s=>s.findingId===findingId)};}),
  rawEvidence:{sampleReferences:references.size,foundSamples:samples.size,
   hostRows:rows.filter(r=>r.event==='turn_summary'&&(r.maxHandlerMs>100||r.maxDecodeMs>100)),
   incomplete:rows.filter(r=>r.event==='span_end'&&r.outcome==='incomplete'||r.event==='span_unmatched_end'),
   preparation:rows.filter(r=>r.event==='preparation_stage'&&r.durationMs>5000),
   compaction:rows.filter(r=>r.configurationScope==='request_only'&&['50bb6ab0-36fb-4812-8c9e-8514b45df212','554731cb-799c-431f-896e-eaf7c3549508'].includes(r.traceId)),
   modelCatalog:{refreshErrors:rows.filter(r=>r.messageClass==='model_catalog').length,modelListCompleted:rows.filter(r=>r.method==='model/list'&&(r.outcome==='completed'||r.stage==='completed')).length},
   telemetryExports:rows.filter(r=>r.messageClass==='telemetry_export')},
  limits:['工具完整命令/输出未保存在插件日志；不能按分类批量认定环境根因。','后端细分timing、历史400正文和取消来源无法从已脱敏日志恢复。','原始运行范围固定24小时、跨版本；不把本次源码模拟测试当成线上故障已恢复。']};
 if(samples.size!==references.size)throw Error('报告引用的原日志缺失');
 const decisions=JSON.parse(fs.readFileSync(path.join(root,'benchmarks/diagnostic-dd0-dispositions.json'),'utf8'));
 if(decisions.length!==output.issues.length)throw Error('人工核验结论数量不符');
 for(const issue of output.issues){
  const decision=decisions.find(d=>d.issueId===issue.issueId&&d.findingId===issue.findingId);
  if(!decision)throw Error('缺少人工核验结论 '+issue.issueId);
  issue.outcome=decision.outcome;issue.reason=decision.reason;
 }
 output.resultSummary=output.issues.reduce((a,i)=>(a[i.outcome]=(a[i.outcome]||0)+1,a),{});
 fs.writeFileSync(path.join(root,'benchmarks/diagnostic-dd0-audit.json'),JSON.stringify(output,null,2)+'\n');
 console.log(JSON.stringify({issues:output.issues.length,samples:samples.size,files:output.sourceReview.length,hostRows:output.rawEvidence.hostRows.length,incomplete:output.rawEvidence.incomplete.length,modelCatalog:output.rawEvidence.modelCatalog,compactionEvidence:output.rawEvidence.compaction.length}));
})().catch(e=>{console.error(e);process.exitCode=1;});
