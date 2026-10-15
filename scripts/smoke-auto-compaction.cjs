const http=require('node:http');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
// 原生 CLI 集成检查：上游仅为本机 fixture，不调用在线模型。先运行 node scripts/build-test.cjs。
const {WebSocketServer}=require('ws');
const {CodexRpc,resolveCodex}=require('../dist/test/codex/rpc.js');
const {CompactionRelay}=require('../dist/test/codex/compactionRelay.js');
(async()=>{
 let count=0,tools=0,compacted=0,fail,finish,timer;const seen=[],routes=[];
 const server=http.createServer((_req,res)=>res.writeHead(501).end());const wss=new WebSocketServer({server});
 wss.on('connection',ws=>ws.on('message',data=>{
  const b=JSON.parse(data);const compact=b.input?.at(-1)?.type==='compaction_trigger';
  seen.push({model:b.model,effort:b.reasoning?.effort,tier:b.service_tier??null,compact,generate:b.generate,inputTypes:b.input?.map(x=>x.type)});
  const id='resp_mock_'+(++count);let output=[];
  if(b.generate!==false){
   if(compact)output=[{id:'cmp_1',type:'compaction',encrypted_content:'MOCK_COMPACTION_ONLY_FOR_LOCAL_TEST'}];
   else if(tools===0)output=[{id:'fc_1',type:'function_call',call_id:'call_1',name:'fixture',arguments:'{}',status:'completed'}];
   else output=[{id:'msg_1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'DONE',annotations:[]}]}];
  }
  ws.send(JSON.stringify({type:'response.created',response:{id,status:'in_progress'}}));
  for(const item of output)ws.send(JSON.stringify({type:'response.output_item.done',output_index:0,item}));
  ws.send(JSON.stringify({type:'response.completed',response:{id,model:b.model,status:'completed',output,usage:{input_tokens:!compact&&tools===0?80000:100,output_tokens:10,total_tokens:!compact&&tools===0?80010:110,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}));
 }));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const relay=await CompactionRelay.start(`http://127.0.0.1:${server.address().port}/v1`,()=>true,r=>routes.push(r));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-auto-fixture-')),executable=path.join(dir,'codex-fixture');
 const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
 const upstream=`http://127.0.0.1:${server.address().port}/v1`;
 fs.writeFileSync(executable,'#!/bin/sh\nexec '+quote(resolveCodex('codex'))+' -c '+quote('openai_base_url="'+upstream+'"')+' "$@"\n',{mode:0o700});
 const rpc=new CodexRpc(executable,process.cwd());
 let resumed,threadId;
 rpc.on('request',m=>{if(m.method==='item/tool/call'&&m.params.tool==='fixture'){tools++;rpc.respond(m.id,{success:true,contentItems:[{type:'inputText',text:'TOOL_RESULT_7241'}]});}else rpc.reject(m.id,'不执行工具');});
 rpc.on('notification',({method,params:p})=>{
  if(method==='item/completed'&&p.item?.type==='contextCompaction')compacted++;
  if(method==='turn/completed'){if(p.turn.status==='completed')finish();else{console.error(JSON.stringify({stage:'fixture_turn_failed',turn:p.turn,seen}));fail(Error(p.turn.status));}}
  if(method==='error'&&!p.willRetry){console.error(JSON.stringify({stage:'fixture_error',message:p.error?.message,errorInfo:p.error?.codexErrorInfo,seen}));fail(Error(p.error?.message??'error'));}
 });
 try{
  await rpc.start();
  const t=await rpc.request('thread/start',{model:'gpt-6-astra',serviceTier:'default',approvalPolicy:'never',sandbox:'read-only',config:{openai_base_url:relay.baseUrl,model_auto_compact_token_limit:50000},dynamicTools:[{name:'fixture',description:'测试 fixture',inputSchema:{type:'object',properties:{}}}]});
  threadId=t.thread.id;
  const done=new Promise((r,j)=>{finish=r;fail=j;timer=setTimeout(()=>j(Error('timeout')),30000);});
  await rpc.request('turn/start',{threadId:t.thread.id,model:'gpt-6-astra',effort:'medium',serviceTier:'default',input:[{type:'text',text:'local fixture',text_elements:[]}],environments:[]});
  await done;
  assert.equal(tools,1);assert.equal(compacted,1);
  const compact=seen.find(x=>x.compact);assert.equal(compact.model,'gpt-6.1-sol');assert.equal(compact.effort,'xhigh');assert.equal(compact.tier,null);
  assert.ok(compact.inputTypes.includes('function_call_output'));
  assert.equal(seen.at(-1).model,'gpt-6-astra');assert.equal(seen.at(-1).effort,'medium');
  assert.ok(seen.at(-1).inputTypes.includes('compaction'));
  assert.equal(routes.find(x=>x.stage==='response').servedModel,'gpt-6.1-sol');
  clearTimeout(timer);await rpc.disposeAndWait();relay.close();
  // 换进程且不再传回环配置，模拟关闭平衡模式。已关闭的旧端口不能留在恢复线程中。
  resumed=new CodexRpc(executable,process.cwd());await resumed.start();
  assert.equal((await resumed.request('config/read',{includeLayers:false})).config.openai_base_url,upstream);
  const r=await resumed.request('thread/resume',{threadId,model:'gpt-6-astra',approvalPolicy:'never',sandbox:'read-only'});
  const next=new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('恢复超时')),15000);
   resumed.on('notification',({method,params:p})=>{if(method==='error')console.error(JSON.stringify({stage:'resume_error',error:p.error}));if(method==='turn/completed'){if(p.turn.status==='completed')resolve();else{console.error(JSON.stringify({stage:'resume_failed',turn:p.turn,seen}));reject(Error(p.turn.status));}}});
  });
  await resumed.request('turn/start',{threadId:r.thread.id,model:'gpt-6-astra',effort:'medium',serviceTier:'default',input:[{type:'text',text:'resume fixture',text_elements:[]}],environments:[]});
  await next;clearTimeout(timer);
  await resumed.request('thread/archive',{threadId});
  console.log(JSON.stringify({success:true,tools,compacted,manualCompactCalls:0,resumedWithoutRelay:true,seen,routes}));
 }finally{clearTimeout(timer);if(resumed)await resumed.disposeAndWait();await rpc.disposeAndWait();relay.close();for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
