const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {CodexProcess}=require('../dist/test/codex/process.js');
const {SessionStore}=require('../dist/test/codex/session.js');
const {classifyIncident}=require('../dist/test/diagnostics/general.js');
const Module=require('node:module'),originalLoad=Module._load;
Module._load=function(id,...args){return id==='vscode'?{}:originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;

async function until(check) {
 const end=Date.now()+3000;
 while(!check()) { if(Date.now()>end)throw Error('等待测试事件超时');await new Promise(r=>setTimeout(r,5)); }
}

test('真实动态提问 callId 贯穿暂停、问题卡片与迟到遥测，不再产生 unknown 误报',async t=>{
 const events=[],requests=[];
 const p=new CodexProcess({codexPath:path.resolve('test/fake-codex.cjs'),cwd:process.cwd(),permissionMode:'default',transportDiagnostics:true},
  {emit:e=>events.push(e),onPermission:r=>requests.push(r),onSessionId:()=>{},onClose:()=>{}});
 t.after(()=>p.disposeAndWait());await p.start();p.sendUserMessage('wait');await until(()=>p.turnId);
 const turnId=p.turnId,callId='question-call';
 p.notification({method:'item/started',params:{threadId:'thread-1',turnId,item:{type:'dynamicToolCall',id:callId,tool:'AskUserQuestion'}}});
 await p.request({id:18,method:'item/tool/call',params:{threadId:'thread-1',turnId,callId,tool:'AskUserQuestion',arguments:{questions:[{id:'q',question:'继续吗？',options:[]}]}}});
 await until(()=>requests.length);
 assert.equal(requests[0].toolUseId,callId);
 const rows=()=>events.filter(e=>e.kind==='diag'&&e.message.startsWith('[perf] ')).map(e=>JSON.parse(e.message.slice(7)));
 const ended=rows().find(r=>r.event==='span_end'&&r.itemId===callId);
 assert.equal(ended.outcome,'waiting_for_user');
 assert.equal(rows().find(r=>r.event==='span_start'&&r.kind==='question').itemId,callId);
 const raw={type:'event',event:'codex.tool_result','conversation.id':'thread-1',tool_name:'AskUserQuestion',call_id:callId,sourceTimeMs:Date.now(),success:false,failureCategory:'unknown'};
 const annotated=p.latency.annotateTransport(raw);
 assert.equal(annotated.expectedCancellation,true);assert.equal(annotated.success,false);
 assert.equal(classifyIncident('',annotated),undefined);
 assert.ok(classifyIncident('',p.latency.annotateTransport({...raw,call_id:'unrelated'})));
 assert.equal(p.isBusy,true);assert.equal(events.some(e=>e.kind==='result'),false);
 p.answerQuestion(requests[0].requestId,{q:'继续'});
 await until(()=>events.some(e=>e.kind==='result'));
 assert.equal(rows().find(r=>r.event==='turn_summary'&&r.outcome==='answered').incompleteSpans,0);
 assert.equal(p.latency.annotateTransport(raw).expectedCancellation,true);
});

test('发送前按 notLoaded 分页读取准确轮数，不传输正文也不覆盖完整历史',async()=>{
 const store=new SessionStore('/tmp',()=>'/unused'),calls=[];
 store.threads.set('thread',{id:'thread',turns:[{id:'cached',items:[{type:'agentMessage',text:'保留完整内容'}]}]});
 store.connection=async()=>({request:async(method,params)=>{
  calls.push({method,params});assert.equal(method,'thread/turns/list');
  return params.cursor?{data:[{id:'t3'}],nextCursor:null}:{data:[{id:'t1'},{id:'t2'}],nextCursor:'page2'};
 }});
 assert.equal(await store.readTurnCount('thread'),3);
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.params.itemsView==='notLoaded'&&c.params.sortDirection==='asc'));
 assert.equal(store.countLines('thread'),1);assert.equal(store.threads.get('thread').turns[0].items[0].text,'保留完整内容');
});

test('轮数读取拒绝重复游标、重复轮次和损坏页面，不以缓存或部分结果放行发送',async()=>{
 for(const kind of ['cursor','duplicate','invalid']) {
  const store=new SessionStore('/tmp',()=>'/unused');let calls=0;
  store.connection=async()=>({request:async()=>{calls++;assert.ok(calls<=3);return kind==='invalid'?{data:null,nextCursor:null}:
   {data:[{id:kind==='duplicate'?'same':'turn-'+calls}],nextCursor:'page2'};}});
  await assert.rejects(store.readTurnCount('thread'),/分页|重复|无效/);
 }
});

test('仅旧 CLI 明确不支持轻量接口时回退，认证和超时错误直接保留',async()=>{
 for(const error of ['Method not found (-32601)','401 Unauthorized (-32603)','Codex 请求超时：thread/turns/list']) {
  const store=new SessionStore('/tmp',()=>'/unused');let hydrated=0;
  store.connection=async()=>({isClosed:false,request:async()=>{throw Error(error);}});
  store.hydrate=async()=>{hydrated++;};store.countLines=()=>7;
  if(error.includes('-32601'))assert.equal(await store.readTurnCount('thread'),7);
  else await assert.rejects(store.readTurnCount('thread'),e=>e.message===error);
  assert.equal(hydrated,error.includes('-32601')?1:0);
 }
});

test('分页历史先只读元数据，全文只拉一次；传统协议仍读取完整历史',async()=>{
 for(const mode of ['paginated','legacy']) {
  const store=new SessionStore('/tmp',()=>'/unused'),calls=[];
  store.connection=async()=>({request:async(method,params)=>{
   calls.push({method,params});
   if(method==='thread/read')return {thread:{id:'thread',historyMode:mode,turns:params.includeTurns?[{id:'old',items:[]}]:[]}};
   return {data:[{id:'new',items:[]}],nextCursor:null};
  }});
  await store.hydrate('thread');
  assert.deepEqual(calls[0],{method:'thread/read',params:{threadId:'thread',includeTurns:false}});
  assert.equal(calls.length,2);assert.equal(calls[1].method,mode==='paginated'?'thread/turns/list':'thread/read');
  assert.equal(store.rewindLeafFor('thread',1),mode==='paginated'?'new':'old');
 }
});

test('轮数读取中途断线仅重建一次，并丢弃断线前的半份分页',async()=>{
 const store=new SessionStore('/tmp',()=>'/unused');let connections=0,calls=0;
 const first={isClosed:false,request:async()=>{
  if(++calls===1)return {data:[{id:'discarded'}],nextCursor:'old-page'};
  first.isClosed=true;throw Error('连接已关闭');
 }};
 const next={request:async(_method,params)=>{assert.equal(params.cursor,null);return {data:[{id:'fresh-1'},{id:'fresh-2'}],nextCursor:null};}};
 store.connection=async()=>++connections===1?first:next;
 assert.equal(await store.readTurnCount('thread'),2);assert.equal(connections,2);
 next.request=async()=>{throw Error('连接仍不可用');};
 await assert.rejects(store.readTurnCount('thread'),/连接仍不可用/);
 assert.equal(connections,3);
});

test('遥测导出错误独立分类，不能冒充主对话连接中断或隐藏真实连接错误',()=>{
 const row={diagnosticType:'transport',type:'runtime_error',severity:'error',failureCategory:'network_or_service',
  message:'ERROR opentelemetry_sdk: name="BatchLogProcessor.ExportError" ConnectionReset'};
 assert.equal(classifyIncident('',row).category,'遥测采集');
 assert.equal(classifyIncident('',{...row,message:'[2mopentelemetry_sdk [0m: name="BatchLogProcessor.ExportError" ConnectionReset'}).category,'遥测采集');
 assert.equal(classifyIncident('',{...row,message:'ERROR connection reset by peer'}).category,'连接与进程');
 assert.equal(classifyIncident('',{type:'rpc',method:'config/read',stage:'end',outcome:'failed',failureCategory:'timeout'}).category,'连接与进程');
});

test('发送使用实时轮数创建还原点，读取失败、停止或会话变化都不能误发',async()=>{
 for(const mode of ['success','failed','stopped','changed']) {
  const provider=Object.create(ChatViewProvider.prototype),checkpoints=[],sent=[],applied=[];
  const proc={isBusy:false,setModel:async v=>applied.push(['model',v]),setEffort:async v=>applied.push(['effort',v]),
   setSpeedMode:async v=>applied.push(['speed',v]),sendUserMessage:text=>{sent.push(text);return true;}};
  const ctx={sessionId:'source',proc,checkpoints:{beginTurn:(_text,count)=>{checkpoints.push(count);return 'checkpoint';}}};
  Object.assign(provider,{
   config:()=>({get:(_key,fallback)=>false}),post:()=>{},output:{appendLine:()=>{}},ensureProcess:async()=>proc,
   waitSessionSettings:async()=>{},sessionModel:()=> 'chosen-model',sessionEffort:()=> 'high',speedMode:()=> 'fast',
   clearSessionNotification:()=>{},store:{countLines:()=>assert.fail('不能使用旧历史缓存'),hydrate:()=>assert.fail('不能拉全部正文'),
    readTurnCount:async id=>{assert.equal(id,'source');if(mode==='failed')throw Error('分页读取失败');
     if(mode==='stopped')ctx.stopSeq=ctx.sendSeq;if(mode==='changed')ctx.sessionId='another';return 123;}}
  });
  if(mode==='failed')await assert.rejects(provider.handleSend(ctx,'继续'),/分页读取失败/);
  else assert.equal(await provider.handleSend(ctx,'继续'),mode==='success');
  assert.deepEqual(checkpoints,mode==='success'?[123]:[]);assert.deepEqual(sent,mode==='success'?['继续']:[]);
  if(mode==='success')assert.deepEqual(applied,[['model','chosen-model'],['speed','fast'],['effort','high']]);
  assert.equal(ctx.sending,false);
 }
});
