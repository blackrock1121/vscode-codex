// 固定全部保留日志快照对比；只输出计数、哈希和白名单字段，不执行日志中的内容。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),logDir=process.argv[2],baseline='35daf5c05f215ef6c8e718f8931d9061888eab01';
if(!logDir)throw new Error('请提供原日志目录');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-a86-verify-'));
const hash=v=>createHash('sha256').update(v).digest('hex');
(async()=>{
 const oldRoot=path.join(temp,'before');fs.mkdirSync(oldRoot);
 const archive=execFileSync('git',['archive',baseline,'src','native','scripts/log-audit.cjs','package.json'],{cwd:root,maxBuffer:16*1024*1024});
 execFileSync('tar',['-x','-C',oldRoot],{input:archive});fs.symlinkSync(path.join(root,'node_modules'),path.join(oldRoot,'node_modules'),'dir');
 await require('esbuild').build({entryPoints:[path.join(oldRoot,'src/diagnostics/scan.ts')],outfile:path.join(temp,'before-scan.js'),bundle:true,platform:'node',format:'cjs',plugins:[require(path.join(oldRoot,'scripts/log-audit.cjs')).logAuditPlugin(oldRoot)]});
 const old=require(path.join(temp,'before-scan.js')),next=require('../dist/test/diagnostics/scan.js');
 const copy=path.join(temp,'logs');fs.mkdirSync(copy);const snapshot=[],account=[],notification=[],terminals=[];
 const failureIds=new Set(['a4b11ad9-b245-4652-8130-c4b311a67baf','32203c32-4bd1-4a8f-bc25-cee1f74a2ac2']);
 const signals={mcp403:0,modelsRefreshTimeout:0,systemSkillsInstallFailed:0,dynamicToolCancellation:0};
 const fields=['operation','event','stage','outcome','phase','operationId','processRunId','previousProcessRunId','failureId','previousFailureId','traceId','durationMs','elapsedMs','reason','scope','sessionConfigurationChanged','model','effort','serviceTier'];
 const selectedTraces=new Set(['cc383b9b-2f0d-43dc-a9fa-03992d7aaabd','b3ac2ee9-97e4-4bef-854f-38bcdf8e936c']);
 for(const name of fs.readdirSync(logDir).filter(n=>/^codex-chat-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort()){
  const file=path.join(copy,name);fs.copyFileSync(path.join(logDir,name),file);fs.chmodSync(file,0o600);
  const buffer=fs.readFileSync(file);snapshot.push({file:name,bytes:buffer.length,sha256:hash(buffer)});
  let number=0;
  for(const line of buffer.toString('utf8').split('\n')){
   number++;const match=/\[(operation|perf|transport|compaction|compaction_route)\] (\{.*\})$/.exec(line);if(!match)continue;
   let row;try{row=JSON.parse(match[2]);}catch{continue;}
   const at=next.diagnosticLogTime(line,name,row);if(at>Date.parse('2026-11-03T05:52:11.625Z'))continue;
   const safe=()=>({file:name,line:number,atMs:at,...Object.fromEntries(fields.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]))});
   if(failureIds.has(row.failureId)||failureIds.has(row.previousFailureId))account.push(safe());
   if(row.operation?.startsWith('notification.')&&line.slice(0,230).includes('1ff8dedd-753c-4928-9020-58e5da39aed0')&&at>=1793601620000&&at<=1793602145000)notification.push(safe());
   if(selectedTraces.has(row.traceId)&&(row.event==='turn_summary'||['end','response','usage_updated','transport_end'].includes(row.stage)))terminals.push(safe());
   const text=String(row.message??'');
   if(row.httpStatusCode===403&&row.targetKind==='mcp_transport')signals.mcp403++;
   if(/codex_models_manager.*failed to refresh available models.*timed out/i.test(text))signals.modelsRefreshTimeout++;
   if(/codex_skills_extension.*failed to install system skills/i.test(text))signals.systemSkillsInstallFailed++;
   if(/dynamic tool call was cancelled before receiving a response/i.test(text))signals.dynamicToolCancellation++;
  }
 }
 const request={kind:'general',hours:0,engine:'rules',toMs:Date.parse('2026-11-03T05:52:11.625Z')};
 const summarize=r=>({coverage:{...r.coverage,sources:undefined},summary:r.summary,general:{...r.general,recoveryEvidence:undefined},
  classifications:Object.fromEntries([...new Set(r.findings.map(f=>f.category))].map(c=>[c,r.findings.filter(f=>f.category===c).length]))});
 const at=performance.now(),before=await old.scanPluginLogs(copy,()=>{},request),beforeMs=performance.now()-at;
 const afterAt=performance.now(),after=await next.scanPluginLogs(copy,()=>{},request),afterMs=performance.now()-afterAt;
 assert.deepEqual(before.coverage,after.coverage);assert.deepEqual(before.summary,after.summary);
 const live=await next.scanPluginLogs(copy,()=>{},{kind:'general',hours:0,engine:'rules'});
 const result={diagnosticId:'a86dec96-a71d-478c-bba8-cc13095c8ce1',baseline,currentVersion:require('../package.json').version,
  snapshot,before:summarize(before),after:summarize(after),allRetained:summarize(live),scanMs:{before:Math.round(beforeMs),after:Math.round(afterMs)},
  historicalEvidence:{signals,account,notification,compactionTerminals:terminals,
   interpretation:['两次账户读取失败均有同 failureId 的 account.usage recovered，属于已恢复历史故障。','通知失败后新的点击 operationId 有完整 completed；不是原失败点击迟到成功，也不保证用户看到通知。','压缩只改请求副本；日志语义完成和下一轮配置、取消恢复由现有回归验证；无真实后端耗时改善结论。','signals 是日志行计数，可能重复，不能当作独立故障次数。']},
  faultInjection:{verification:'test/diagnostic-a86-fix.test.cjs；发送释放、目录冷却、工具分类在旧版均失败；修复后七项通过，并检查日志落盘和诊断检出。',
   sendCleanup:{before:'ENOSPC 后 sending=true，下一次被阻挡',after:'sending=false，可再次发送；原始发送异常不被收尾错误覆盖'},
   modelMenu:{threeOpensBeforeRequests:4,threeOpensAfterRequests:1,reductionPercent:75,retryCooldownMs:[5000,60000],selectionChanged:false},
   relay:{before:'响应头等待只有请求开始与最终结束，不能区分首响应',afterHeaderHeartbeatMs:30000,testHeartbeatMs:20,forcedTimeoutAdded:false,streamNotTruncated:true,clientCancellationObserved:true},
   logging:'磁盘不可写且输出回调抛错仍走独立 console；恢复后落盘并检出',
   classification:'patch_mismatch / tool_session_missing；动态取消来源保持 unknown'},
  limitations:['扫描耗时单次测量不代表性能提升；历史 summary 必须一致，不能靠删除历史错误证明改善。','固定诊断时刻扫描与全部保留日志扫描分别呈现，原报告默认24小时不能直接比较总数。','未复验历史上游访问控制、真实收费模型压缩、系统通知可见性或休眠恢复。','保留全部日志，仅删除本脚本临时副本。']};
 fs.mkdirSync(path.join(root,'benchmarks'),{recursive:true});fs.writeFileSync(path.join(root,'benchmarks/diagnostic-a86-results.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({files:snapshot.length,bytes:snapshot.reduce((n,f)=>n+f.bytes,0),scanMs:result.scanMs,before:result.before.general,after:result.after.general,signals,accountRecovery:account.filter(x=>x.operation==='account.usage'&&x.stage==='recovered').length,allRetained:result.allRetained.coverage},null,2));
})().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
