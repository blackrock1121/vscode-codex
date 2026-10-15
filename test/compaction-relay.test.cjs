const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {WebSocket,WebSocketServer}=require('ws');
const {CompactionRelay,routeCompaction,compactionUpstream}=require('../dist/test/codex/compactionRelay.js');
const make=(extra={})=>({type:'response.create',model:'gpt-6-astra',reasoning:{effort:'medium',context:'all_turns'},
 input:[{type:'message',role:'user',content:[{type:'input_text',text:'保留约束'}]},{type:'function_call_output',call_id:'a',output:'完整输出'},{type:'compaction_trigger'}],tools:[{type:'function',name:'test'}],...extra});
const raw=body=>Buffer.from(JSON.stringify(body));

test('原生压缩只换模型和推理：缺省/普通/快速档位及历史工具逐项保留',()=>{
 for(const tier of [undefined,null,'default','priority']){
  const input=make(tier===undefined?{}:{service_tier:tier});
  const r=routeCompaction(raw(input),false,()=>true),body=JSON.parse(r.body);
  assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning.effort,'xhigh');
  assert.equal(body.service_tier,tier);assert.equal(r.route.serviceTier,tier??null);
  assert.deepEqual(body,{...input,model:'gpt-6.1-sol',reasoning:{...input.reasoning,effort:'xhigh'}});
 }
});

test('普通回答、其他模型、未知协议、旧接口和不支持的档位均按原字节透传',()=>{
 const cases=[make({input:[{type:'message',content:'compaction_trigger'}]}),make({model:'gpt-6-luna'}),
  make({type:'response.append'}),make({service_tier:'unknown'}),make({input:[{type:'compaction_trigger'},{type:'message'}]})];
 for(const body of cases){const b=raw(body);assert.equal(routeCompaction(b,false,()=>true).body,b);}
 for(const legacy of [false,true]){const b=raw(make());assert.equal(routeCompaction(b,legacy,()=>false).body,b);}
 const b=raw(make());assert.equal(routeCompaction(b,true,()=>true).body,b);
 for(const b of [Buffer.from('{broken'),Buffer.alloc(33*1024*1024)])assert.equal(routeCompaction(b,false,()=>true).body,b);
});

test('仅识别官方账号与默认提供方，自定义网关及未知账号不接管',()=>{
 assert.equal(compactionUpstream({}, {type:'chatgpt'}),'https://chatgpt.com/backend-api/codex');
 assert.equal(compactionUpstream({model_provider:'openai'},{type:'apiKey'}),'https://api.openai.com/v1');
 for(const c of [null,{model_provider:'custom'},{openai_base_url:'https://example.invalid'},
  {chatgpt_base_url:'https://example.invalid'},{chatgpt_base_url:{}}])assert.equal(compactionUpstream(c,{type:'chatgpt'}),undefined);
 assert.equal(compactionUpstream({},{}),undefined);
});

async function fixture(t,handler=()=>{},onRoute){
 const server=http.createServer(handler),wss=new WebSocketServer({server}),routes=[];
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const relay=await CompactionRelay.start(`http://127.0.0.1:${server.address().port}/v1`,()=>true,onRoute??(r=>routes.push(r)));
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
 await assert.rejects(CompactionRelay.start('https://example.invalid',()=>true,()=>{}));
});

test('诊断回调失败不阻断请求',async t=>{
 const {base}=await fixture(t,(_req,res)=>res.end('ok'),()=>{throw Error('仅诊断失败');});
 assert.equal((await request(base+'/responses',raw(make()))).body.toString(),'ok');
});
