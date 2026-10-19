const {test}=require('node:test');
const assert=require('node:assert/strict');
const {gzipSync}=require('node:zlib');
const {LocalTelemetry,transportDiagnostics}=require('../dist/test/codex/telemetry.js');
const attributes=a=>Object.entries(a).map(([key,value])=>({key,value:
 typeof value==='boolean'?{boolValue:value}:typeof value==='number'?{doubleValue:value}:{stringValue:value}}));
const logs=(a,extra={})=>({resourceLogs:[{resource:{attributes:attributes({'app.version':'0.162.1'})},scopeLogs:[{logRecords:[{
 timeUnixNano:'1791954000123000000',attributes:attributes(a),body:{stringValue:'PRIVATE_BODY'},...extra}]}]}]});

test('3a1 后端 timing 嵌套指标和无 success 的请求错误保持分类，畸形 timing 明确标记',()=>{
 const row=transportDiagnostics(logs({'event.name':'codex.api_request','error.message':'failed to fetch codex rate limits: error sending request PRIVATE',
  timing_metrics:JSON.stringify({ttft_ms:125,duration_ms:350,engine_service_total_ms:200,PRIVATE:999})}))[0];
 assert.equal(row.failureCategory,'network_or_service');assert.equal(row.ttft_ms,125);assert.equal(row.duration_ms,350);assert.equal(row.engine_service_total_ms,200);
 assert.equal(transportDiagnostics(logs({'event.name':'codex.api_request',timing_metrics:'{PRIVATE'}))[0].timingStatus,'invalid_data');
 assert.doesNotMatch(JSON.stringify(row),/PRIVATE/);
});

test('OTLP 仅保留请求时序、关联标识和用量，不保留凭据、正文或工具结果',()=>{
 const rows=transportDiagnostics(logs({'event.name':'codex.sse_event','event.kind':'response.completed',
  'conversation.id':'thread-1','turn_id':'turn-1','model':'test-model','duration_ms':'1500','ttft_ms':'300',
  'input_token_count':1000,'output_token_count':40,'cached_token_count':950,'success':true,
  'error.message':'PRIVATE_ERROR','prompt':'PRIVATE_PROMPT','output':'PRIVATE_OUTPUT','Authorization':'PRIVATE_KEY',
  endpoint:'https://example.com/responses?token=PRIVATE', 'auth.connection_reused':true,
  timing_metrics:JSON.stringify({engine_service_total_ms:900,extra:'PRIVATE_TIMING'})}));
 assert.equal(rows.length,1);assert.equal(rows[0].sourceTimeMs,1791954000123);
 assert.equal(rows[0].ttft_ms,300);assert.equal(rows[0].engine_service_total_ms,900);
 assert.equal(rows[0]['conversation.id'],'thread-1');assert.equal(rows[0].hasError,true);
 assert.equal(rows[0].endpoint,'/responses');assert.equal(rows[0].connectionReused,true);
 assert.doesNotMatch(JSON.stringify(rows),/PRIVATE/);
 assert.equal(transportDiagnostics(logs({'event.name':'codex.tool_result','duration_ms':10}))[0].duration_ms,10);
 assert.deepEqual(transportDiagnostics(logs({'event.name':'codex.sse_event','event.kind':'response.output_text.delta'})),[]);
 assert.equal(transportDiagnostics(logs({'event.name':'codex.sse_event','event.kind':'response.output_text.delta','success':false})).length,1);
});
test('真实 CLI 的 event.timestamp 可在 OTLP 时间为零时提供关联时间',()=>{
 const row=transportDiagnostics(logs({'event.name':'codex.sse_event','event.kind':'response.completed',
  'event.timestamp':'2026-10-14T06:00:00.123Z'}, {timeUnixNano:'0'}))[0];
 assert.equal(row.sourceTimeMs,Date.parse('2026-10-14T06:00:00.123Z'));assert.equal(row.sourceTimeBasis,'event.timestamp');
});
test('无效数值与未知结构不会伪造时序，后端指标明确标为进程汇总',()=>{
 for(const payload of [null,{},[],{resourceLogs:[null,{scopeLogs:[null]}]}]) assert.deepEqual(transportDiagnostics(payload),[]);
 const row=transportDiagnostics(logs({'event.name':'codex.api_request','duration_ms':'PRIVATE','attempt':-1,
  'ttft_ms':Infinity,'model':'PRIVATE/FILE','input_token_count':false}, {timeUnixNano:'invalid'}))[0];
 assert.equal(row.sourceTimeMs,null);assert.equal(row.duration_ms,undefined);assert.equal(row.model,undefined);
 assert.equal(row.input_token_count,undefined);assert.equal(row.ttft_ms,undefined);
 const metrics={resourceMetrics:[{scopeMetrics:[{metrics:[{name:'codex.responses_api_inference_time.duration_ms',
  histogram:{aggregationTemporality:2,dataPoints:[{startTimeUnixNano:'1791954000000000000',timeUnixNano:'1791954010000000000',
   count:'2',sum:1200,min:500,max:700,attributes:attributes({model:'test-model',prompt:'PRIVATE'})}]}},
  {name:'codex.tool.call.duration_ms',histogram:{dataPoints:[{count:'100',sum:999}]}}]}]}]};
 const points=transportDiagnostics(metrics);assert.equal(points.length,2);assert.equal(points[0].scope,'process_aggregate');
 assert.equal(points[0].count,2);assert.equal(points[0].aggregationTemporality,2);assert.equal(points[0].sum,1200);
 assert.doesNotMatch(JSON.stringify(points),/PRIVATE/);
});
test('本机采集器接收 JSON/gzip，拒绝未知路由和损坏内容，关闭后释放端口',async t=>{
 const rows=[];const local=await LocalTelemetry.start(row=>rows.push(row));t.after(()=>local.close());
 const url=local.endpoint('logs');assert.match(url,/^http:\/\/127\.0\.0\.1:/);
 const args=local.args().join(' ');assert.match(args,/otel.log_user_prompt=false/);
 assert.match(args,/protocol = "json"/);assert.doesNotMatch(args,/analytics.enabled/);
 const data=JSON.stringify(logs({'event.name':'codex.api_request','duration_ms':12}));
 assert.equal((await fetch(url,{method:'POST',body:data})).status,200);
 assert.equal((await fetch(url,{method:'POST',headers:{'Content-Encoding':'gzip'},body:gzipSync(data)})).status,200);
 assert.equal(rows.length,2);assert.equal(rows[0].duration_ms,12);
 assert.equal((await fetch(url,{method:'POST',body:'bad'})).status,400);
 assert.equal((await fetch(url,{method:'POST',headers:{'Content-Encoding':'gzip'},body:gzipSync('x'.repeat(3*1024*1024))})).status,400);
 assert.equal((await fetch(url.replace(/\/[^/]+\/v1\//,'/wrong/v1/'),{method:'POST',body:data})).status,404);
 assert.equal((await fetch(url)).status,404);
 local.close();await assert.rejects(fetch(url));
});

test('工具 OTLP 记录标识、耗时、失败分类，原始参数和输出不会落盘',()=>{
 const row=transportDiagnostics(logs({'event.name':'codex.tool_result','tool_name':'exec_command',call_id:'call-1',
  'conversation.id':'thread-1',duration_ms:450,success:false,exit_code:127,
  output:'PRIVATE_OUTPUT: command not found',arguments:'PRIVATE_COMMAND',prompt:'PRIVATE_PROMPT'}))[0];
 assert.equal(row.tool_name,'exec_command');assert.equal(row.call_id,'call-1');assert.equal(row.duration_ms,450);
 assert.equal(row.failureCategory,'command_not_found');assert.equal(row.exitCode,127);
 assert.doesNotMatch(JSON.stringify(row),/PRIVATE|arguments|command not found/);
 const decision=transportDiagnostics(logs({'event.name':'codex.tool_decision',decision:'approved',source:'user',command:'PRIVATE'}))[0];
 assert.equal(decision.decision,'approved');assert.equal(decision.source,'user');assert.doesNotMatch(JSON.stringify(decision),/PRIVATE/);
});
