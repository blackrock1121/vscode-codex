const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PerformanceTrace,failureCategory}=require('../dist/test/codex/performanceTrace.js');
const {analyzePerformance}=require('../dist/test/diagnostics/analysis.js');
const {classifyIncident}=require('../dist/test/diagnostics/general.js');
const {performanceReport}=require('../dist/test/diagnosticsReport.js');
const {transportDiagnostics}=require('../dist/test/codex/telemetry.js');

function fixture(t){
 let time=0; const rows=[];
 const trace=new PerformanceTrace(row=>rows.push(row),()=>time,()=>100000+time);
 trace.begin('root',{}, {traceId:'trace-question',startedAt:0,startedWallMs:100000});
 const note=(method,item,extra={},child=false)=>trace.observe({method,params:{threadId:'root',turnId:'turn-1',...(item?{item}:{}),...extra}},child,'root');
 t.after(()=>trace.finish('disposed'));
 return {trace,rows,note,at:n=>time=n,summary:()=>rows.find(row=>row.event==='turn_summary')};
}
const question={id:'question-call',type:'dynamicToolCall',tool:'AskUserQuestion'};
const toolResult=(extra={})=>({type:'event',event:'codex.tool_result','conversation.id':'root',turn_id:'turn-1',call_id:question.id,tool_name:question.tool,success:false,failureCategory:'unknown',...extra});

test('已确认的问题暂停保留原始失败字段，并按调用标识排除预期中断',t=>{
 const f=fixture(t);f.note('item/started',question);
 f.trace.expectQuestionPause(question.id,'root','turn-1');
 assert.equal(f.trace.annotateTransport(toolResult()).expectedCancellation,undefined,'仅发起中断不等于暂停成功');
 f.at(20);f.note('turn/completed',null,{turn:{id:'turn-1',status:'interrupted'}});
 f.at(21);f.trace.approval('card',true,'root','turn-1',question.id);
 const expected=f.trace.annotateTransport(toolResult());
 assert.equal(expected.success,false);assert.equal(expected.failureCategory,'unknown');
 assert.equal(expected.expectedCancellation,true);assert.equal(classifyIncident('',expected),undefined);
 for(const mismatch of [{call_id:'another-call'},{'conversation.id':'other'},{turn_id:'turn-2'},{failureCategory:'permission'},{failureCategory:'timeout'},{sourceTimeMs:99999},{sourceTimeMs:101021},{turn_id:undefined}]){
  const other=f.trace.annotateTransport(toolResult(mismatch));assert.equal(other.expectedCancellation,undefined);assert.ok(classifyIncident('',other));
 }
 f.at(60021);f.trace.resolved('card','allow');f.trace.finish('answered');
 assert.equal(f.summary().childTailMs,0);assert.equal(f.summary().phasesMs.user_wait,60000);
 assert.equal(f.summary().incompleteSpans,0);
 assert.equal(f.rows.find(row=>row.event==='span_end'&&row.itemId===question.id).outcome,'waiting_for_user');
 f.trace.begin('root',{}, {traceId:'next',startedAt:60021,startedWallMs:160021});
 assert.equal(f.trace.annotateTransport(toolResult()).expectedCancellation,true,'延迟 OTLP 保留原调用的预期取消关联');
 assert.equal(f.trace.annotateTransport(toolResult({call_id:'new-call'})).expectedCancellation,undefined);
 assert.equal(f.trace.annotateTransport(toolResult({turn_id:undefined,sourceTimeMs:160021})).expectedCancellation,undefined);
});

test('正常失败、未确认暂停和未知工具错误仍计为异常',t=>{
 const f=fixture(t);f.note('item/started',question);f.trace.expectQuestionPause(question.id,'root','turn-1');
 f.note('turn/completed',null,{turn:{id:'turn-1',status:'failed'}});
 assert.equal(f.trace.annotateTransport(toolResult()).expectedCancellation,undefined);
 assert.ok(classifyIncident('',toolResult()));
 assert.ok(classifyIncident('',{...toolResult(),expectedCancellation:true,cancellationReason:'other',outcome:'failed'}));
 assert.ok(classifyIncident('',{...toolResult(),expectedCancellation:true,cancellationReason:'question_pause',outcome:'waiting_for_user',failureCategory:'permission'}));
 f.trace.finish('failed');assert.equal(f.summary().incompleteSpans,1);
});

test('子任务尾部只统计实际子任务活动，并扣除用户等待及后续收尾',t=>{
 const f=fixture(t);f.at(10);f.note('turn/started',null,{threadId:'child',turnId:'child-turn',turn:{id:'child-turn'}},true);
 f.at(20);f.note('turn/completed',null,{turn:{id:'turn-1',status:'completed'}});
 f.at(30);f.trace.approval('child-card',true,'child','child-turn');
 f.at(50);f.trace.resolved('child-card','allow');
 f.at(60);f.note('turn/completed',null,{threadId:'child',turnId:'child-turn',turn:{id:'child-turn',status:'completed'}},true);
 f.at(100);f.trace.finish('completed');
 assert.equal(f.summary().childTailMs,20);assert.equal(f.summary().phasesMs.user_wait,20);
 assert.equal(f.summary().childTailBasis,'active_children_excluding_user_wait');
});

test('旧诊断中没有子任务的等待不再报尾部耗时，过夜问题明确显示等用户',()=>{
 const legacy={event:'turn_summary',traceId:'legacy',elapsedMs:332139,childTailMs:294880,maxParallelAgents:0,maxParallelTools:1,toolCount:6,failures:0,phasesMs:{user_wait:294878}};
 assert.equal(analyzePerformance([legacy]).findings.some(row=>row.id==='tail'),false);
 assert.equal(analyzePerformance([{...legacy,maxParallelAgents:1}]).findings.some(row=>row.id==='tail'),true);
 const report=performanceReport([legacy,{event:'heartbeat',traceId:'question-overnight',atMs:100000,elapsedMs:52143040,idleMs:51992710,activeCount:1,active:[{kind:'question'}]}]);
 const turnLine=report.split('\n').find(line=>line.startsWith('| legacy |'));
 assert.match(turnLine,/\| 1 \/ 0 \| 0\.00 秒 \|$/);
 assert.match(report,/用户审批\/回答：294\.88 秒/);assert.match(report,/正在等待用户回答或授权/);
});

test('按真实错误而非源码命中或零失败摘要分类，避免timeout和rate_limit假阳性',()=>{
 assert.equal(failureCategory('Traceback\n  client.connect(connect_timeout=8, read_timeout=8)\nKeyboardInterrupt',1),'interrupted');
 assert.equal(failureCategory('client.connect(connect_timeout=8, read_timeout=8)',1),'nonzero_exit');
 assert.equal(failureCategory('CdpRequestTimeoutError: command timed out',1),'timeout');
 assert.equal(failureCategory('PageEvaluationTimeoutError: evaluation exceeded limit',1),'timeout');
 assert.equal(failureCategory('KeyboardInterrupt',124),'timeout');
 assert.equal(failureCategory('rg: missing.ts: No such file or directory (os error 2)\nsrc/case.ts:429: rate_limit test failed',2),'missing_file');
 assert.equal(failureCategory('# tests 3\n# pass 3\n# fail 0\n# duration_ms 429',1),'nonzero_exit');
 assert.equal(failureCategory('HTTP 429 Too Many Requests',1),'rate_limit');
 assert.equal(failureCategory('status_code=429',1),'rate_limit');
 assert.equal(failureCategory('FAIL test/example.test.js',1),'build_or_test');
 assert.equal(failureCategory('ℹ FAIL assertion check\n  AssertionError: invariant failed',1),'build_or_test');
 assert.equal(failureCategory('FAIL   0',1),'nonzero_exit');
 assert.equal(failureCategory('not ok 2 - failing case',1),'build_or_test');
 assert.equal(failureCategory('error TS2345: wrong argument',1),'build_or_test');
});

test('工具错误摘要包含工具及调用ID，unknown明确说明证据可用性且不落原始内容',()=>{
 const attributes=Object.entries({'event.name':'codex.tool_result',tool_name:'exec_command',call_id:'exec-call',success:false,'error.message':'',output:'PRIVATE command not found',exit_code:'127'}).map(([key,value])=>({key,value:typeof value==='boolean'?{boolValue:value}:{stringValue:value}}));
 const [row]=transportDiagnostics({resourceLogs:[{scopeLogs:[{logRecords:[{attributes}]}]}]});
 assert.equal(row.exitCode,127);assert.equal(row.failureCategory,'command_not_found');assert.equal(row.failureEvidence,'tool_output');
 assert.doesNotMatch(JSON.stringify(row),/PRIVATE|command not found/);
 const detail=classifyIncident('',row);assert.match(detail.message,/tool=exec_command/);assert.match(detail.message,/callId=exec-call/);
 const [unknown]=transportDiagnostics({resourceLogs:[{scopeLogs:[{logRecords:[{attributes:attributes.filter(a=>!['output','exit_code'].includes(a.key))}]}]}]});
 assert.equal(unknown.failureCategory,'unknown');assert.equal(unknown.failureEvidence,'unavailable');
});
