// 原生 CLI + 本机模拟上游：验证候选评测的压缩/读回/质量门槛/限额/取消；不调用在线模型。
const http=require('node:http'),assert=require('node:assert/strict');
const {WebSocketServer}=require('ws');
const {validateCompactionModel}=require('../dist/test/codex/compactionValidation');
const answer={facts:{port:'4317',timeout:'4700',branch:'feature/orbit',commit:'f83a902',architecture:'amd64',logPattern:'logs/session-*.jsonl',job:'job-P73',checksum:'SUM-9182',version:'0.8.17',timezone:'Asia/Shanghai',retryLimit:'2',testCount:'57',rolloutPhase:'paused',minSamples:'9',owner:'乔宁',artifact:'release/orbit.vsix'},decisions:{deployAllowed:false,fastWhenNormal:false,continueWhenSyncFails:false,tailMustRemain:true,toolPairMaySplit:false,claimLatencyDecomposed:false}};
(async()=>{
 const server=http.createServer((_req,res)=>res.writeHead(501).end()),wss=new WebSocketServer({server});
 let mode='pass',generated=0,compactions=0,readers=0;const requests=[];let control;
 wss.on('connection',ws=>ws.on('message',async data=>{
  const b=JSON.parse(data),compact=b.input?.at(-1)?.type==='compaction_trigger',id='fixture-'+requests.length;
  requests.push(b);assert.equal(b.service_tier,'default');assert.equal(b.tool_choice,'none');assert.deepEqual(b.tools,[]);
  assert.equal(b.max_output_tokens,compact?20000:2048);
  if(mode==='abort'&&b.generate!==false){control.abort();return;}
  let output=[];
  if(b.generate!==false){
   generated++;
   if(compact){
    compactions++;assert.ok(b.input.some(x=>x.type==='message'&&JSON.stringify(x).includes('job-P73')));
    if(compactions===1)await new Promise(r=>setTimeout(r,100));
    output=[{id:'cmp-'+compactions,type:'compaction',encrypted_content:'LOCAL_SYNTHETIC_EVALUATION'}];
   }else{
    readers++;assert.ok(b.input.some(x=>x.type==='compaction'));assert.equal(b.model,'gpt-6.1-sol');
    const outputAnswer=structuredClone(answer);if(mode==='loss'&&readers===2)outputAnswer.facts.port='3000';
    output=[{id:'msg-'+readers,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(outputAnswer),annotations:[]}]}];
   }
  }
  ws.send(JSON.stringify({type:'response.created',response:{id,status:'in_progress'}}));
  for(const item of output)ws.send(JSON.stringify({type:'response.output_item.done',output_index:0,item}));
  ws.send(JSON.stringify({type:'response.completed',response:{id,model:b.model,status:'completed',output,usage:{input_tokens:100,output_tokens:10,total_tokens:110,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}}));
 }));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  for(mode of ['pass','loss','abort']){
   generated=compactions=readers=0;requests.length=0;control=new AbortController();
   const run=validateCompactionModel({codexPath:'codex',upstream:`http://127.0.0.1:${server.address().port}/v1`,candidate:'gpt-6.2-sol',baseline:'gpt-6.1-sol',reader:'gpt-6.1-sol',signal:control.signal});
   if(mode==='abort'){await assert.rejects(run);continue;}
   const r=await run;assert.equal(r.passed,mode==='pass');assert.equal(r.candidateScore,mode==='pass'?22:21);
   assert.equal(r.baselineScore,22);assert.equal(generated,4);assert.equal(compactions,2);assert.equal(readers,2);
   assert.ok(requests.length<=12);assert.equal(requests.filter(b=>b.generate!==false).reduce((sum,b)=>sum+b.max_output_tokens,0),44096);
   console.log(JSON.stringify({scenario:mode,...r}));
  }
  console.log(JSON.stringify({success:true,scenarios:['通过启用','丢失事实拒绝','取消释放']}));
 }finally{for(const ws of wss.clients)ws.terminate();wss.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
