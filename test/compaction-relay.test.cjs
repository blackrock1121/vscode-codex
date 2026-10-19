const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {WebSocket,WebSocketServer}=require('ws');
const {CompactionRelay,routeCompaction,compactionUpstream}=require('../dist/test/codex/compactionRelay.js');
const {CompactionPolicy,CompactionValidationStore}=require('../dist/test/codex/compactionPolicy.js');
const policy=new CompactionPolicy(new CompactionValidationStore());
const select=(source,tier)=>policy.select(source,tier,[{id:'gpt-6.1-sol',efforts:['xhigh'],speedModes:['default','fast']}]);
const make=(extra={})=>({type:'response.create',model:'gpt-6-astra',reasoning:{effort:'medium',context:'all_turns'},
 input:[{type:'message',role:'user',content:[{type:'input_text',text:'保留约束'}]},{type:'function_call_output',call_id:'a',output:'完整输出'},{type:'compaction_trigger'}],tools:[{type:'function',name:'test'}],...extra});
const raw=body=>Buffer.from(JSON.stringify(body));

test('原生压缩只换模型和推理：缺省/普通/快速档位及历史工具逐项保留',()=>{
 for(const tier of [undefined,null,'default','priority']){
  const input=make(tier===undefined?{}:{service_tier:tier});
  const r=routeCompaction(raw(input),false,select),body=JSON.parse(r.body);
  assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning.effort,'xhigh');
  assert.equal(body.service_tier,tier);assert.equal(r.route.serviceTier,tier??null);
  assert.deepEqual(body,{...input,model:'gpt-6.1-sol',reasoning:{...input.reasoning,effort:'xhigh'}});
 }
});

test('普通回答、其他模型、未知协议、旧接口和不支持的档位均按原字节透传',()=>{
 const cases=[make({input:[{type:'message',content:'compaction_trigger'}]}),make({model:'gpt-6-luna'}),
  make({type:'response.append'}),make({generate:false}),make({stream_id:'parallel'}),make({conversation:'c'}),make({context_management:[]}),make({service_tier:'unknown'}),make({input:[{type:'compaction_trigger'},{type:'message'}]})];
 for(const body of cases){const b=raw(body);assert.equal(routeCompaction(b,false,select).body,b);}
 for(const legacy of [false,true]){const b=raw(make());assert.equal(routeCompaction(b,legacy,()=>undefined).body,b);}
 const b=raw(make());assert.equal(routeCompaction(b,true,select).body,b);
 for(const b of [Buffer.from('{broken'),Buffer.alloc(33*1024*1024)])assert.equal(routeCompaction(b,false,select).body,b);
});

test('仅识别官方账号与默认提供方，自定义网关及未知账号不接管',()=>{
 assert.equal(compactionUpstream({}, {type:'chatgpt'}),'https://chatgpt.com/backend-api/codex');
 assert.equal(compactionUpstream({model_provider:'openai'},{type:'apiKey'}),'https://api.openai.com/v1');
 for(const c of [null,{model_provider:'custom'},{openai_base_url:'https://example.invalid'},
  {chatgpt_base_url:'https://example.invalid'},{chatgpt_base_url:{}}])assert.equal(compactionUpstream(c,{type:'chatgpt'}),undefined);
 assert.equal(compactionUpstream({},{}),undefined);
});

async function fixture(t,handler=()=>{},onRoute,options){
 const server=http.createServer(handler),wss=new WebSocketServer({server}),routes=[];
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const relay=await CompactionRelay.start(`http://127.0.0.1:${server.address().port}/v1`,select,onRoute??(r=>routes.push(r)),options);
 const base=relay.baseUrl;
 t.after(()=>{relay.close();for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections();server.close();});
 return {server,wss,relay,base,routes};
}
function request(url,body,headers={}){
 return new Promise((resolve,reject)=>{const req=http.request(url,{method:'POST',headers},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
 });req.on('error',reject);req.end(body);});
}
async function connect(t,base){const ws=new WebSocket(base.replace('http:','ws:')+'/responses',{headers:{'thread-id':'thread-test'}});t.after(()=>ws.terminate());await once(ws,'open');return ws;}
async function exchange(ws,body,binary=false){const next=once(ws,'message');ws.send(body,{binary});return await next;}

for(const terminal of ['response.failed','response.incomplete','error'])test(`3a1 压缩 ${terminal} 先记录终态再清理历史，下一次普通请求配置不变`,async t=>{
 const {base,wss,routes}=await fixture(t);const received=[];
 wss.on('connection',ws=>ws.on('message',data=>{const b=JSON.parse(data);received.push(b);ws.send(JSON.stringify({type:terminal,response:{model:b.model}}));}));
 const ws=await connect(t,base),original=make();await exchange(ws,raw(original));
 assert.deepEqual(routes.map(r=>r.stage),['request','response']);assert.equal(routes[1].outcome,terminal==='response.incomplete'?'incomplete':'failed');
 assert.equal(routes[1].fromModel,'gpt-6-astra');assert.equal(routes[1].fromEffort,'medium');
 const normal=make({input:[]});await exchange(ws,raw(normal));assert.deepEqual(received[1],normal);assert.doesNotMatch(JSON.stringify(routes),/完整输出|保留约束/);
});

test('HTTP/SSE 流、鉴权与错误状态透传；只改 responses 中的原生触发请求',async t=>{
 const seen=[];
 const {base,routes}=await fixture(t,async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);
  seen.push({body:Buffer.concat(chunks),auth:req.headers.authorization,path:req.url});
  res.writeHead(req.url.endsWith('/error')?429:200,{'Content-Type':'text/event-stream','x-request-id':'fixture'});
  res.write('data: first\n\n');setImmediate(()=>res.end('data: done\n\n'));
 });
 const normal=Buffer.from(' { "model": "gpt-6-astra", "input": [] } ');
 const first=await request(base+'/responses',normal,{authorization:'Bearer fixture-not-a-key'});
 assert.equal(first.body.toString(),'data: first\n\ndata: done\n\n');assert.equal(first.headers['x-request-id'],'fixture');
 assert.deepEqual(seen[0].body,normal);assert.equal(seen[0].auth,'Bearer fixture-not-a-key');
 await request(base+'/responses',raw(make()));assert.equal(JSON.parse(seen[1].body).model,'gpt-6.1-sol');
 await request(base+'/responses/compact',raw(make()));assert.equal(JSON.parse(seen[2].body).model,'gpt-6-astra');
 await request(base+'/responses',raw(make()),{'content-encoding':'gzip'});assert.equal(JSON.parse(seen[3].body).model,'gpt-6-astra');
 assert.equal((await request(base+'/error','')).status,429);assert.equal(routes.length,1);
 assert.doesNotMatch(JSON.stringify(routes),/fixture-not-a-key|完整输出|保留约束/);
});

test('同一 WebSocket 中普通→自动压缩→续答，响应模型关联正确且不修改二进制帧',async t=>{
 const {base,wss,routes}=await fixture(t);const received=[];
 wss.on('connection',ws=>ws.on('message',(data,binary)=>{
  received.push({data:Buffer.from(data),binary});
  if(binary){ws.send(data,{binary:true});return;}
  const b=JSON.parse(data);ws.send(JSON.stringify({type:'response.completed',response:{model:b.model}}));
 }));
 const ws=await connect(t,base);
 const normal=raw(make({input:[]}));await exchange(ws,normal);
 await exchange(ws,raw(make()));await exchange(ws,normal);
 const [binary,isBinary]=await exchange(ws,Buffer.from([0,255,14]),true);
 assert.equal(isBinary,true);assert.deepEqual(binary,Buffer.from([0,255,14]));
 assert.deepEqual(received[0].data,normal);assert.deepEqual(received[2].data,normal);
 assert.equal(JSON.parse(received[1].data).model,'gpt-6.1-sol');
 assert.deepEqual(routes.map(r=>r.stage),['request','response']);assert.equal(routes[1].servedModel,'gpt-6.1-sol');
 assert.equal(routes[0].threadId,'thread-test');
});

test('WS 上游异常不自行重发，关闭转发器会关闭所有连接',async t=>{
 const {base,wss,relay}=await fixture(t);let requests=0;
 wss.on('connection',ws=>ws.on('message',()=>{requests++;ws.close(1011,'fixture');}));
 const ws=await connect(t,base),closed=once(ws,'close');ws.send(raw(make()));
 const [code]=await closed;assert.equal(code,1011);assert.equal(requests,1);
 const ws2=await connect(t,base),closed2=once(ws2,'close');relay.close();await closed2;
 await assert.rejects(request(base+'/responses',''));
});

test('回环路径密钥、Origin 和路径穿越校验阻止请求到达上游',async t=>{
 let received=0;const {base}=await fixture(t,(_req,res)=>{received++;res.end();});
 const u=new URL(base);
 for(const [url,headers] of [[u.origin+'/wrong/responses',{}],[base+'/responses',{origin:'https://example.invalid'}],
  [base+'/../outside',{}],[base+'/../../other',{}]])assert.equal((await request(url,'',headers)).status,404);
 assert.equal(received,0);
 await assert.rejects(CompactionRelay.start('https://example.invalid',select,()=>{}));
});

test('诊断回调失败不阻断请求',async t=>{
 const {base}=await fixture(t,(_req,res)=>res.end('ok'),()=>{throw Error('仅诊断失败');});
 assert.equal((await request(base+'/responses',raw(make()))).body.toString(),'ok');
});

function longHistory(){
 const user=text=>({type:'message',role:'user',content:[{type:'input_text',text}]});
 return [user('历史约束'),...Array.from({length:12},(_,i)=>[
  {type:'function_call',name:'fixture',arguments:'{}',call_id:'history-'+i},
  {type:'function_call_output',call_id:'history-'+i,output:`日志 ${i}\n`+'x'.repeat(14000)+`\nTests: ${i+100} passed`},
 ]).flat(),user('最近任务一'),user('最近任务二')];
}
async function archiveOptions(t){
 const archiveDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'compact-relay-test-')),savings=[];
 t.after(()=>fs.rm(archiveDirectory,{recursive:true,force:true}));
 return {archiveDirectory,inputPreparationMs:10000,savings,onOptimized:(_threadId,s)=>savings.push(s)};
}

test('HTTP 仅精简合规压缩的旧工具输出，普通请求、预热及未知协议保持历史',async t=>{
 const options=await archiveOptions(t),seen=[];
 const {base}=await fixture(t,async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);seen.push(Buffer.concat(chunks));res.end('ok');
 },undefined,options);
 const original=make({input:[...longHistory(),{type:'compaction_trigger'}],service_tier:'default'});
 const headers={'thread-id':'thread-test'};
 await request(base+'/responses',raw(original),headers);
 const next=JSON.parse(seen[0]),s=options.savings[0];
 assert.ok(s.archivedOutputs>0);assert.ok(s.optimizedBytes<s.originalBytes);
 assert.equal(next.service_tier,'default');assert.equal(next.model,'gpt-6.1-sol');
 assert.deepEqual(next.input.slice(s.protectedFrom),original.input.slice(s.protectedFrom));
 assert.equal(next.input.length,original.input.length);
 for(const body of [make({input:longHistory()}),{...original,generate:false},{...original,type:'response.append'},
  {...original,previous_response_id:'unknown'},{...original,service_tier:'unknown'},{...original,model:'gpt-6-luna'}]){
  await request(base+'/responses',raw(body),headers);assert.deepEqual(JSON.parse(seen.at(-1)).input,body.input);
 }
 await request(base+'/responses',raw(original));assert.deepEqual(JSON.parse(seen.at(-1)).input,original.input);
 assert.equal(options.savings.length,1);
});

test('WS 增量压缩还原完整历史并去掉响应引用，续轮按实际转发的历史继续',async t=>{
 const options=await archiveOptions(t),seen=[],doneItems=[];
 const {base,wss}=await fixture(t,undefined,undefined,options);
 wss.on('connection',ws=>ws.on('message',data=>{
  const b=JSON.parse(data);seen.push(b);
  const output={type:'message',role:'assistant',content:[{type:'output_text',text:'响应 '+seen.length}]};doneItems.push(output);
  ws.send(JSON.stringify({type:'response.output_item.done',output_index:0,item:output}));
  ws.send(JSON.stringify({type:'response.completed',response:{id:'r'+seen.length,model:b.model,output:[]}}));
 }));
 const ws=await connect(t,base);
 const send=body=>new Promise((resolve,reject)=>{
  const onMessage=data=>{if(JSON.parse(data).type==='response.completed'){ws.off('message',onMessage);ws.off('error',reject);resolve();}};
  ws.on('message',onMessage);ws.once('error',reject);ws.send(raw(body),{binary:false});
 });
 const first=make({input:longHistory(),service_tier:'priority'});await send(first);
 const delta={type:'function_call_output',call_id:'last',output:'最近工具原文'};
 const compact=make({previous_response_id:'r1',input:[delta,{type:'compaction_trigger'}],service_tier:'priority'});await send(compact);
 const next=seen[1],s=options.savings[0],full=[...first.input,doneItems[0],...compact.input];
 assert.equal(next.previous_response_id,undefined);assert.equal(next.service_tier,'priority');
 assert.equal(next.input.length,full.length);assert.deepEqual(next.input.slice(s.protectedFrom),full.slice(s.protectedFrom));
 assert.equal(next.input.at(-3).content[0].text,'响应 1');
 // 已改写的前缀也必须进入本机跟踪，不能在后续引用中错误复活旧大段。
 await send(make({previous_response_id:'r2',input:[{type:'compaction_trigger'}]}));
 assert.equal(seen[2].previous_response_id,'r2');assert.equal(options.savings.length,1);
 await send(make({previous_response_id:'missing',input:[{type:'compaction_trigger'}]}));
 assert.equal(seen[3].previous_response_id,'missing');assert.equal(seen[3].input.length,1);
});

test('归档期间关闭转发器，不再把已取消的 HTTP 请求发送给上游',async t=>{
 let requests=0,relay;const options=await archiveOptions(t);
 const f=await fixture(t,(_req,res)=>{requests++;res.end();},undefined,{...options,onOptimized:()=>relay.close()});relay=f.relay;
 await assert.rejects(request(f.base+'/responses',raw(make({input:[...longHistory(),{type:'compaction_trigger'}]})),{'thread-id':'cancelled'}));
 assert.equal(requests,0);
});
