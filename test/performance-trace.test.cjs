const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PerformanceTrace,failureCategory,performanceContext}=require('../dist/test/codex/performanceTrace.js');
const {performanceReport}=require('../dist/test/diagnosticsReport.js');
const {CodexProcess}=require('../dist/test/codex/process.js');

function fixture(t){
 let time=0;const rows=[];
 const trace=new PerformanceTrace(r=>rows.push(r),()=>time,()=>100000+time);
 trace.begin('root',{model:'test-model',effort:'high'},{traceId:'trace-1',startedAt:0,startedWallMs:100000,queueMs:123});
 const note=(method,item,extra={})=>trace.observe({method,params:{threadId:'root',turnId:'turn-1',...(item?{item}:{}),...extra}});
 t.after(()=>trace.finish('disposed'));
 return {trace,rows,at:n=>time=n,note,summary:()=>rows.find(r=>r.event==='turn_summary')};
}
const bash=(id,extra={})=>({id,type:'commandExecution',command:'npm test',...extra});

test('并行工具累计耗时不冒充墙钟，审批单列，首次输出和退出码可关联',t=>{
 const f=fixture(t);f.at(10);f.note('item/started',bash('a'));f.at(20);f.note('item/started',bash('b'));
 f.at(25);f.trace.approval('approve',false,'root','turn-1','a');
 f.at(30);f.note('item/commandExecution/outputDelta',null,{itemId:'a',delta:'PRIVATE_TOOL_OUTPUT'});
 f.at(35);f.trace.resolved('approve','allow');
 f.at(50);f.note('item/completed',bash('a',{exitCode:0,durationMs:25}));
 f.at(70);f.note('item/completed',bash('b',{exitCode:2,aggregatedOutput:'error TS2345 PRIVATE_ERROR'}));
 f.at(100);f.trace.finish('completed');const s=f.summary();
 assert.equal(s.elapsedMs,100);assert.equal(s.queueMs,123);assert.equal(s.toolCount,2);assert.equal(s.failures,1);
 assert.equal(s.maxParallelTools,2);assert.equal(s.parallelToolMs,30);
 assert.equal(s.phasesMs.tools,50);assert.equal(s.phasesMs.user_wait,10);assert.equal(s.phasesMs.unobserved,40);
 assert.equal(s.kinds.bash.totalMs,90);assert.equal(s.repeatedCommands,1);
 const a=f.rows.find(r=>r.event==='span_end'&&r.kind==='bash'&&r.itemId==='a');assert.equal(a.firstOutputMs,20);assert.equal(a.serverDurationMs,25);
 const b=f.rows.find(r=>r.event==='span_end'&&r.itemId==='b');assert.equal(b.failureCategory,'build_or_test');
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE|npm test/);
});

test('同名工具的子线程隔离，根轮次结束后仍统计子任务尾部',t=>{
 const f=fixture(t);
 const note=(thread,method,item,extra={})=>f.trace.observe({method,params:{threadId:thread,turnId:thread+'-turn',...(item?{item}:{}),...extra}},true,'root');
 f.at(10);note('child-a','turn/started');f.at(20);note('child-b','turn/started');
 note('child-a','item/started',bash('same'));note('child-b','item/started',bash('same'));
 f.at(40);f.note('turn/completed',null,{turn:{id:'turn-1',status:'completed'}});
 f.at(50);note('child-a','item/completed',bash('same',{exitCode:0}));note('child-a','turn/completed',null,{turn:{status:'completed'}});
 f.at(60);note('child-b','item/completed',bash('same',{exitCode:0}));
 f.at(80);note('child-b','turn/completed',null,{turn:{status:'completed'}});f.trace.finish('completed');
 const s=f.summary();assert.equal(s.maxParallelAgents,2);assert.equal(s.childTailMs,40);assert.equal(s.toolCount,2);assert.equal(s.incompleteSpans,0);
 assert.equal(f.rows.filter(r=>r.event==='span_end'&&r.itemId==='same').length,2);
 assert.equal(s.phasesMs.child_tail,20);
});

test('压缩、模型可见输出和无事件等待分别统计，停止残留阶段明确不完整',t=>{
 const f=fixture(t);f.at(10);f.note('item/started',{id:'think',type:'reasoning'});
 f.at(20);f.note('item/reasoning/textDelta',null,{itemId:'think',delta:'PRIVATE_REASONING'});
 f.at(30);f.note('item/completed',{id:'think',type:'reasoning'});
 f.note('item/started',{id:'compact',type:'contextCompaction'});
 f.at(50);f.note('item/completed',{id:'compact',type:'contextCompaction'});
 f.at(60);f.note('item/started',bash('running'));f.at(70);f.trace.finish('interrupted');
 const s=f.summary();assert.equal(s.phasesMs.model_visible,20);assert.equal(s.phasesMs.compaction,20);
 assert.equal(s.firstReasoningMs,20);assert.equal(s.firstTextMs,null);assert.equal(s.incompleteSpans,1);
 assert.equal(s.outcome,'interrupted');assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE/);
});

test('延迟 OTLP 用源时间及线程关联，不串下一轮，聚合指标永不归轮',t=>{
 const f=fixture(t);f.note('turn/started',null,{turn:{id:'turn-1'}});f.at(100);f.trace.finish('completed');
 f.at(200);f.trace.begin('root',{}, {traceId:'trace-2',startedAt:200,startedWallMs:100200});f.at(300);
 assert.equal(f.trace.associate({type:'event',thread_id:'root',sourceTimeMs:100050}),'trace-1');
 assert.equal(f.trace.associate({type:'event',thread_id:'root',sourceTimeMs:100250}),'trace-2');
 assert.equal(f.trace.associate({type:'event',thread_id:'external',sourceTimeMs:100250}),null);
 assert.equal(f.trace.associate({type:'event',thread_id:'root'}),null);
 assert.equal(f.trace.associate({type:'metric',thread_id:'root',sourceTimeMs:100250}),null);
 assert.equal(f.trace.associate({type:'event',turn_id:'turn-1'}),'trace-1');
});

test('重复事件不重复累计，缺少开始通知不伪造工具时长',t=>{
 const f=fixture(t);f.note('item/started',bash('a'));f.note('item/started',bash('a'));
 f.at(20);f.note('item/completed',bash('a',{exitCode:0}));f.note('item/completed',bash('a',{exitCode:0}));
 f.note('item/completed',bash('unknown',{durationMs:33,exitCode:0}));f.trace.finish('completed');
 assert.equal(f.summary().toolCount,1);assert.equal(f.rows.filter(r=>r.event==='span_end').length,1);
 const missing=f.rows.find(r=>r.event==='span_unmatched_end');assert.equal(missing.durationMs,null);assert.equal(missing.serverDurationMs,33);
});

test('无匹配的 rg 非零退出不计为失败，依赖/架构/网络失败只给分类',t=>{
 const f=fixture(t);const item=bash('search',{command:'rg missing src'});f.note('item/started',item);f.note('item/completed',{...item,exitCode:1,aggregatedOutput:''});f.trace.finish('completed');
 assert.equal(f.summary().failures,0);assert.equal(f.rows.find(r=>r.event==='span_end').expectedNoMatch,true);
 assert.equal(failureCategory('ModuleNotFoundError: PRIVATE'),'missing_dependency');
 assert.equal(failureCategory('exec format error PRIVATE'),'architecture_mismatch');
 assert.equal(failureCategory('ECONNREFUSED PRIVATE'),'network_or_service');
 assert.equal(failureCategory('',127),'command_not_found');
 assert.equal(performanceContext(-1).queueMs,undefined);assert.equal(performanceContext(Infinity).queueMs,undefined);
});

test('长工具心跳有进展字节和静默时间；日志数不随 delta 数量增长',t=>{
 const f=fixture(t);f.note('item/started',bash('long'));
 for(let i=0;i<10000;i++) f.note('item/commandExecution/outputDelta',null,{itemId:'long',delta:'x'});
 assert.equal(f.rows.length,2);f.at(31000);f.trace.heartbeat();
 const h=f.rows.at(-1);assert.equal(h.event,'heartbeat');assert.equal(h.active[0].outputBytes,10000);assert.equal(h.active[0].outputIdleMs,31000);
 assert.equal(h.maxEventLoopDelayMs,1000);assert.ok(h.rssBytes>0);
});

test('采集上限明确标记，命令指纹跨采集进程不复用',t=>{
 const f=fixture(t);f.note('item/started',bash('a'));const first=f.rows.at(-1).commandFingerprint;
 const other=[];const trace=new PerformanceTrace(r=>other.push(r));trace.begin('root',{});trace.observe({method:'item/started',params:{item:bash('a')}});
 assert.notEqual(first,other.at(-1).commandFingerprint);trace.finish('completed');
 for(let i=0;i<2050;i++)f.trace.start('cap-'+i,'tool');f.trace.finish('completed');assert.ok(f.summary().droppedSpans>0);
});

test('诊断报告显示并行/失败/未知边界且不复制无关原始日志内容',t=>{
 const f=fixture(t);f.note('item/started',bash('a'));f.at(60);f.note('item/completed',bash('a',{exitCode:127,aggregatedOutput:'PRIVATE_COMMAND: command not found'}));f.trace.finish('completed');
 const report=performanceReport([...f.rows,{event:'unrelated',message:'PRIVATE_SECRET'}]);
 assert.match(report,/command_not_found/);assert.match(report,/不能直接相加/);assert.match(report,/未归因等待/);assert.match(report,/trace-1/);assert.doesNotMatch(report,/PRIVATE/);
});

test('真实进程事件入口记录 Bash、审批、子任务和汇总，不改变 UI 结果',async t=>{
 const events=[];const p=new CodexProcess({codexPath:'/unused',cwd:process.cwd(),permissionMode:'default'},
  {emit:e=>events.push(e),onPermission:()=>{},onSessionId:()=>{},onClose:()=>{}});t.after(()=>p.dispose());
 p.sessionId='root';p.activeModel='test-model';p.modelsLoaded=true;p.children.setRoot({id:'root',sessionId:'tree'});
 p.rpc.request=async method=>method==='turn/start'?{turn:{id:'turn-1'}}:{};p.rpc.respond=()=>{};
 assert.equal(p.sendUserMessage('PRIVATE_PROMPT'),true);await new Promise(r=>setImmediate(r));
 const note=(method,params)=>p.notification({method,params:{threadId:'root',turnId:'turn-1',...params}});
 note('turn/started',{turn:{id:'turn-1'}});note('item/started',{item:bash('cmd')});
 await p.request({id:7,method:'item/commandExecution/requestApproval',params:{threadId:'root',turnId:'turn-1',itemId:'cmd'}});
 assert.equal(p.respondPermission('7',{behavior:'allow'}),true);
 note('item/completed',{item:bash('cmd',{exitCode:0})});note('turn/completed',{turn:{id:'turn-1',status:'completed'}});
 const rows=events.filter(e=>e.kind==='diag'&&e.message.startsWith('[perf] ')).map(e=>JSON.parse(e.message.slice(7)));
 assert.ok(rows.some(r=>r.event==='span_end'&&r.kind==='approval'));assert.equal(rows.filter(r=>r.event==='turn_summary').length,1);
 assert.equal(rows.find(r=>r.event==='turn_summary').toolCount,1);assert.equal(events.filter(e=>e.kind==='result').length,1);
 assert.doesNotMatch(JSON.stringify(rows),/PRIVATE|npm test/);
});

test('子任务等待和 MCP 内部错误都有明确阶段，缺失或损坏字段不打断采集',t=>{
 const f=fixture(t);const wait={id:'wait',type:'collabAgentToolCall',tool:'wait',receiverThreadIds:['child']};
 f.at(10);f.note('item/started',wait);f.at(20);f.note('item/completed',wait);
 const mcp={id:'mcp',type:'mcpToolCall',tool:'query',server:'example'};
 f.note('item/started',mcp);f.at(30);f.note('item/completed',{...mcp,result:{isError:true,content:[{type:'text',text:'PRIVATE ECONNREFUSED'}]},contentItems:{bad:true}});
 f.trace.finish('completed');assert.equal(f.summary().phasesMs.agent_wait,10);assert.equal(f.summary().failures,1);
 const error=f.rows.find(r=>r.event==='span_end'&&r.itemId==='mcp');assert.equal(error.failureCategory,'network_or_service');
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE/);
});

test('报告只读取限定日志内的结构化诊断，兼容截断行和压缩实际模型',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const {readPerformanceReport}=require('../dist/test/diagnosticsReport.js');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-report-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'codex-chat-2026-10-15.log'),[
  '[unrelated] PRIVATE_LOG',
  '[diag] [perf] '+JSON.stringify({schema:1,event:'turn_summary',traceId:'example',elapsedMs:100,toolCount:0,failures:0,kinds:{},phasesMs:{unobserved:100}}),
  '[diag] [compaction] '+JSON.stringify({traceId:'example',stage:'end',trigger:'manual',model:'gpt-6.1-sol',effort:'xhigh',elapsedMs:100,outcome:'completed'}),
  '[perf] {broken',
 ].join('\n'));
 await fs.writeFile(path.join(dir,'notes.txt'),'PRIVATE_FILE');
 const report=await readPerformanceReport(dir);assert.match(report,/example/);assert.match(report,/gpt-6.1-sol/);assert.match(report,/读取最近 1/);assert.doesNotMatch(report,/PRIVATE/);
});

test('被拒绝的外部线程核验不会污染任务日志归属',async t=>{
 const p=new CodexProcess({codexPath:'/unused',cwd:process.cwd(),permissionMode:'default'},
  {emit:()=>{},onPermission:()=>{},onSessionId:()=>{},onClose:()=>{}});t.after(()=>p.dispose());
 p.sessionId='root';p.activeModel='test';p.modelsLoaded=true;p.children.setRoot({id:'root',sessionId:'tree'});
 p.rpc.request=async(method,params)=>method==='turn/start'?{turn:{id:'turn'}}:{thread:{id:params.threadId,parentThreadId:'unrelated',sessionId:'other'}};
 p.sendUserMessage('private');await new Promise(r=>setImmediate(r));
 assert.equal(await p.ensureChild('external'),false);
 assert.equal(p.latency.associate({type:'event',thread_id:'external',sourceTimeMs:Date.now()}),null);
});
