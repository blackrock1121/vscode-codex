const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {CompactionArchive,optimizeCompactionInput:optimizeRaw,ResponseHistory}=require('../dist/test/codex/compactionInput.js');
// 内容验证给足并行测试中的调度余量；超时/取消另用指定的小预算单独验证。
const optimizeCompactionInput=(input,archive,options)=>optimizeRaw(input,archive,{maxDurationMs:10000,...options});
const user=text=>({type:'message',role:'user',content:[{type:'input_text',text}]});
const output=(id,text)=>({type:'function_call_output',call_id:id,output:text,success:true});
function history(){return [user('原始约束不得删'),...Array.from({length:14},(_,i)=>output('call-'+i,`输出 ${i}\n`+'原始日志内容\n'.repeat(2600)+`\nTests: ${i+100} passed\n结束`)),user('最近任务一'),output('recent1','最近细节'.repeat(8000)),user('最近纠正二'),output('recent2','最近细节'.repeat(8000)),{type:'compaction_trigger'}];}
async function archive(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'compact-input-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,store:new CompactionArchive(dir)};}

test('精简旧输出、保留最近两轮和最近八个结果，原文可逐字恢复且不改输入',async t=>{
 const {dir,store}=await archive(t),input=history(),before=JSON.stringify(input);
 const {input:next,savings}=await optimizeCompactionInput(input,store);
 assert.ok(savings.archivedOutputs>0);assert.ok(savings.optimizedBytes<savings.originalBytes);
 assert.equal(JSON.stringify(input),before);assert.deepEqual(next.slice(savings.protectedFrom),input.slice(savings.protectedFrom));
 assert.equal(next[0],input[0]);assert.equal(next.at(-1),input.at(-1));
 const contents=await Promise.all((await fs.readdir(dir)).map(f=>fs.readFile(path.join(dir,f),'utf8')));
 for(let i=0;i<input.length;i++)if(next[i]!==input[i]){
  assert.ok(contents.includes(input[i].output));assert.equal(next[i].call_id,input[i].call_id);assert.equal(next[i].success,true);
  assert.match(next[i].output,/Tests: \d+ passed/);assert.match(next[i].output,/完整内容保存在/);
 }
 for(const file of await fs.readdir(dir))assert.equal((await fs.stat(path.join(dir,file))).mode&0o777,0o600);
});

test('重复旧输出用明确调用引用去重，最近的同文原始结果保留',async t=>{
 const {store}=await archive(t),input=history();input[1].output=input.at(-2).output;
 const {input:next,savings}=await optimizeCompactionInput(input,store);
 assert.equal(savings.duplicateOutputs,1);assert.match(next[1].output,/recent2/);assert.equal(next.at(-2),input.at(-2));
});

test('纯文本多段输出只精简大段，调用 ID、短段和字段保留；图片及未知结构不变',async t=>{
 const {store}=await archive(t),input=history();
 input[1].output=[{type:'input_text',text:'状态元数据'},{type:'input_text',text:input[1].output,extra:true}];
 input[2].output=[{type:'input_text',text:input[2].output},{type:'input_image',image_url:'data:image/png;base64,TEST'}];
 input[3].output={unknown:input[3].output};
 const {input:next}=await optimizeCompactionInput(input,store);
 assert.equal(next[1].output[0],input[1].output[0]);assert.equal(next[1].output[1].extra,true);
 assert.ok(next[1].output[1].text.length<input[1].output[1].text.length);
 assert.equal(next[2],input[2]);assert.equal(next[3],input[3]);
});

test('归档失败、容量不足或文件损坏时保留原文；小历史不精简',async t=>{
 const {dir,store}=await archive(t),input=history();
 assert.deepEqual((await optimizeCompactionInput(input,{save:async()=>{throw Error('磁盘不可写');}})).input,input);
 assert.deepEqual((await optimizeCompactionInput(input,new CompactionArchive(dir,1))).input,input);
 const file=await store.save(input[1].output);await fs.writeFile(file,'损坏');
 assert.equal((await optimizeCompactionInput(input,store)).input[1],input[1]);
 const small=[user('最近任务'),output('last','不可删除'.repeat(10))];assert.equal((await optimizeCompactionInput(small,store)).input,small);
});

test('增量还原只使用已完成的对应响应，不把未知前缀或失败结果当成完整历史',()=>{
 let h=new ResponseHistory();const first={type:'response.create',input:[user('任务')]};
 h.request(first);h.event({type:'response.output_item.done',output_index:0,item:{type:'function_call',call_id:'a',name:'tool',arguments:'{}'}});
 h.event({type:'response.completed',response:{id:'r1',output:[]}});
 const delta={type:'response.create',previous_response_id:'r1',input:[output('a','返回结果'),{type:'compaction_trigger'}]};
 const full=h.resolve(delta);assert.equal(full.length,4);assert.equal(full[1].call_id,'a');assert.equal(full[2].call_id,'a');
 assert.equal(h.resolve({...delta,previous_response_id:'unknown'}),undefined);
 h.request(delta);h.event({type:'error'});assert.equal(h.resolve({...delta,previous_response_id:'r2'}),undefined);
 assert.equal(h.resolve(delta),undefined);h=new ResponseHistory();
 h.request(first);h.event({type:'response.completed',response:{id:'unknown-output'}});
 assert.equal(h.resolve({...delta,previous_response_id:'unknown-output'}),undefined);
 h.request(first);h.event({type:'response.output_item.done',output_index:0,item:{type:'message',role:'assistant',content:[]}});
 h.event({type:'response.completed',response:{id:'final-list',output:[{type:'message',role:'assistant',content:[]},{type:'function_call',call_id:'final-call'}]}});
 assert.equal(h.resolve({...delta,previous_response_id:'final-list'})[2].call_id,'final-call');
 h.clear();assert.equal(h.resolve(delta),undefined);
});

test('流式输出按序号还原；缺项、重复序号和未知序号均不猜测历史',()=>{
 for(const indices of [[1,0],[1],[0,0],[undefined]]){
  const h=new ResponseHistory();h.request({type:'response.create',input:[user('任务')]});
  for(const index of indices)h.event({type:'response.output_item.done',output_index:index,item:{type:'function_call',call_id:String(index)}});
  h.event({type:'response.completed',response:{id:'r',output:[]}});
  const resolved=h.resolve({previous_response_id:'r',input:[]});
  if(indices[0]===1&&indices[1]===0)assert.deepEqual(resolved.slice(1).map(x=>x.call_id),['0','1']);
  else assert.equal(resolved,undefined);
 }
});

test('服务端压缩、conversation、交错响应及 steering 不产生伪造的完整前缀',()=>{
 const first={type:'response.create',input:[user('任务')]} , delta={previous_response_id:'r',input:[output('new','结果')]};
 for(const mode of ['compaction','stream','overlap','steering','wrong-id','conversation','context-management','reference']){
  const h=new ResponseHistory();let body=first;
  if(mode==='stream')body={...first,stream_id:'lane-a'};
  if(mode==='conversation')body={...first,conversation:'remote-history'};
  if(mode==='context-management')body={...first,context_management:[]};
  if(mode==='reference')body={...first,input:[{type:'item_reference',id:'hidden-history'}]};
  h.request(body);
  if(mode==='overlap')h.request({...first,stream_id:'lane-b'});
  if(mode==='steering')h.request({type:'response.append',input:[]});
  if(mode==='wrong-id'){h.event({type:'response.created',response:{id:'expected'}});h.event({type:'response.output_item.done',response_id:'other',output_index:0,item:user('不应混入')});}
  h.event({type:'response.completed',response:{id:'r',output:mode==='compaction'?[{type:'compaction',encrypted_content:'TEST'}]:[]}});
  assert.equal(h.resolve(delta),undefined,mode);
  // 完整无状态请求仍可直接处理，关闭的是无法证明正确的增量重建。
  assert.equal(h.resolve(first),first.input);
 }
});

test('取消后不继续归档，时间预算耗尽立即保留原输入',async()=>{
 const input=history(),controller=new AbortController();let writes=0;
 const cancelled=await optimizeCompactionInput(input,{save:async()=>{writes++;controller.abort();return '/tmp/fixture';}},{signal:controller.signal});
 assert.equal(writes,1);assert.equal(cancelled.input,input);assert.equal(cancelled.savings.archivedOutputs,0);
 const alreadyAborted=await optimizeCompactionInput(input,{save:async()=>{throw Error('不能开始');}},{signal:controller.signal});assert.equal(alreadyAborted.input,input);
 let finish;const delayed=new Promise(r=>{finish=r;});
 const keepAlive=setTimeout(()=>{},1000);let slowWrites=0;
 try{
  const timedOut=await optimizeCompactionInput(input,{save:async()=>{slowWrites++;await delayed;return '/tmp/fixture';}},{maxDurationMs:30});
  assert.equal(timedOut.input,input);assert.equal(slowWrites,1);
  finish();await new Promise(r=>setImmediate(r));assert.equal(slowWrites,1);
 }finally{clearTimeout(keepAlive);finish();}
});

test('同一内容只归档一次；收益不足时不读写归档，也不改变输入',async()=>{
 const input=history(),text='完全重复的长日志\n'.repeat(2200);let writes=0;
 for(const item of input)if(item.type==='function_call_output')item.output=text;
 const result=await optimizeCompactionInput(input,{save:async()=>{writes++;return '/tmp/fixture';}});
 assert.equal(writes,1);assert.ok(result.savings.duplicateOutputs>1);
 const tiny=history();for(let i=1;i<=14;i++)tiny[i].output=i===1?'x'.repeat(12000):'短输出';
 let tinyWrites=0;const skipped=await optimizeCompactionInput(tiny,{save:async()=>{tinyWrites++;return '/tmp/fixture';}});
 assert.equal(tinyWrites,0);assert.equal(skipped.input,tiny);assert.equal(skipped.savings.optimizedBytes,skipped.savings.originalBytes);
});

test('归档取消不会发布半文件，成功归档不留下临时文件',async t=>{
 const {dir,store}=await archive(t),controller=new AbortController();controller.abort();
 await assert.rejects(store.save('待保存原文',controller.signal));assert.deepEqual(await fs.readdir(dir),[]);
 const originalWrite=fs.writeFile,midWrite=new AbortController();
 try{
  fs.writeFile=async(file,text,options)=>{
   if(String(file).startsWith(dir)&&String(file).endsWith('.tmp')){
    await originalWrite(file,text.slice(0,2),options);midWrite.abort();throw Object.assign(Error('中途取消'),{code:'ABORT_ERR'});
   }
   return originalWrite(file,text,options);
  };
  await assert.rejects(store.save('不能发布半份原文',midWrite.signal));assert.deepEqual(await fs.readdir(dir),[]);
 }finally{fs.writeFile=originalWrite;}
 await store.save('完整原文');const files=await fs.readdir(dir);assert.equal(files.length,1);assert.match(files[0],/^[a-f0-9]{64}\.txt$/);
 assert.equal(await fs.readFile(path.join(dir,files[0]),'utf8'),'完整原文');
});
