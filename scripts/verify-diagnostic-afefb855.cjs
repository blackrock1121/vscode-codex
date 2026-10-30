// 只读日志固定快照，对同一历史区间和全部保留日志回放，不发送模型/通知请求。
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),baseline='2eeb5e57bec2955656b5a31de7a52362af452689';
const diagnosticId='afefb855-38d6-4ff4-9400-b75242324b63';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'afefb855-replay-'));
const logDir=process.argv[2]||path.join(os.homedir(),'.codex-chat/logs');
const reportDir=process.argv[3]||path.join(os.homedir(),'.codex-chat/diagnostics');
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function main(){
 const snapshot=path.join(temp,'logs');fs.mkdirSync(snapshot);
 const files=fs.readdirSync(logDir).filter(n=>/^codex-chat-\d{4}-\d{2}-\d{2}\.log$/.test(n));
 for(const name of files)fs.copyFileSync(path.join(logDir,name),path.join(snapshot,name));
 const old=path.join(temp,'baseline');fs.mkdirSync(old);
 execFileSync('tar',['-xf','-','-C',old],{input:execFileSync('git',['archive',baseline],{cwd:root,maxBuffer:100*1024*1024})});
 for(const [label,dir]of [['before',old],['after',root]])esbuild.buildSync({stdin:{contents:"export * from './src/diagnostics/scan'; export * from './src/diagnostics/jobs';",resolveDir:dir},bundle:true,platform:'node',outfile:path.join(temp,label+'.cjs'),external:['vscode'],logLevel:'silent'});
 const before=require(path.join(temp,'before.cjs')),after=require(path.join(temp,'after.cjs'));
 const toMs=Date.parse('2026-10-30T02:46:35.122Z'),request={kind:'performance',engine:'rules',hours:24,toMs,fromMs:toMs-86400000};
 const durations={before:[],after:[]},results={};
 for(let i=0;i<3;i++)for(const [name,api]of i%2?[['after',after],['before',before]]:[['before',before],['after',after]]){
  const start=performance.now(),result=await api.scanPluginLogs(snapshot,()=>{},request);durations[name].push(Math.round(performance.now()-start));results[name]=result;
 }
 assert.deepEqual(results.before.summary,results.after.summary);
 assert.equal(results.before.general.errors,59);assert.equal(results.after.general.errors,58);assert.equal(results.after.general.transportResponseLines,1);
 assert.equal(results.after.general.toolFailureChains,35);assert.equal(results.after.coverage.includedLines,24500);
 assert.equal(results.after.findings.filter(f=>f.category==='插件运行').length,0);
 assert.doesNotMatch(results.after.report,/_cf_chl_|challenge-error-text/);
 const full=await after.scanPluginLogs(snapshot,()=>{},{...request,hours:0,fromMs:undefined,toMs:Date.now()+1000});
 const record=JSON.parse(fs.readFileSync(path.join(reportDir,diagnosticId+'.json'),'utf8'));
 const report=fs.readFileSync(path.join(reportDir,diagnosticId+'.report.md'),'utf8'),reportPath=path.join(reportDir,diagnosticId+'.report.md');
 const beforePrompt=before.diagnosticRepairPrompt(record,report,reportPath),afterPrompt=after.diagnosticRepairPrompt(record,report,reportPath);
 assert.ok(beforePrompt.length-afterPrompt.length>59000);assert.ok(afterPrompt.includes('全部源码覆盖位置'));
 assert.ok(record.findings.every(f=>afterPrompt.includes(f.evidence)));
 const core=require('../benchmarks/afefb855-core-review.json'),codex=require('../benchmarks/afefb855-codex-review.json'),ui=require('../benchmarks/afefb855-ui-remote-review.json');
 const expected=[...report.matchAll(/^- (src\/[^:]+):(\d+) · ([^：]+)：([^\n]+)/gm)].map(([,file,line,symbol,rule])=>JSON.stringify([file,+line,symbol,rule])).sort();
 const actual=[...core.entries,...codex.candidates,...ui.entries].map(e=>JSON.stringify([e.file,e.line??e.reportLine,e.symbol??e.function,e.kind??e.rule])).sort();
 assert.deepEqual(actual,expected);assert.equal(actual.length,736);
 const project=r=>({general:r.general,summary:r.summary,coverage:r.coverage});
 const result={diagnosticId,baseline,sourceCandidatesReviewed:actual.length,scope:'全部保留7文件固定快照；24小时同区间比较，另回放截至本次快照的全部保留日志（无工作区/窗口/会话/版本过滤）。未修改原始日志。',
  before:project(results.before),after:project(results.after),allRetained:project(full),
  scanTiming:{beforeMs:durations.before,afterMs:durations.after,beforeMedianMs:median(durations.before),afterMedianMs:median(durations.after),meaning:'进程内墙钟，受磁盘缓存影响；不是用户整轮耗时，未声称后端提速。'},
  repairPrompt:{beforeChars:beforePrompt.length,afterChars:afterPrompt.length,savedChars:beforePrompt.length-afterPrompt.length,reductionPct:+((1-afterPrompt.length/beforePrompt.length)*100).toFixed(1),findingsPreserved:record.findings.length,fullReportReferenced:true},
  limitations:['未改变历史工具失败35次、真实HTTP拒绝或未知等待；减少的1条仅为相邻HTTP正文误分类。','源码覆盖仍为人工核验，Swift自动规则仍unsupported。','报告读取和故障注入不证明远端实际恢复。']};
 fs.writeFileSync(path.join(root,'benchmarks/afefb855-replay-metrics.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({reviewed:actual.length,beforeErrors:result.before.general.errors,afterErrors:result.after.general.errors,fullLogLines:full.coverage.includedLines,fullTurns:full.summary.turns,scanTiming:result.scanTiming,repairPrompt:result.repairPrompt}));
}
main().finally(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(error=>{console.error(error);process.exitCode=1;});
