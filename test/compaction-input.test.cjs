const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {CompactionArchive,optimizeCompactionInput,ResponseHistory}=require('../dist/test/codex/compactionInput.js');
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
 const h=new ResponseHistory(),first={type:'response.create',input:[user('任务')]};
 h.request(first);h.event({type:'response.output_item.done',item:{type:'function_call',call_id:'a',name:'tool',arguments:'{}'}});
 h.event({type:'response.completed',response:{id:'r1',output:[]}});
 const delta={type:'response.create',previous_response_id:'r1',input:[output('a','返回结果'),{type:'compaction_trigger'}]};
 const full=h.resolve(delta);assert.equal(full.length,4);assert.equal(full[1].call_id,'a');assert.equal(full[2].call_id,'a');
 assert.equal(h.resolve({...delta,previous_response_id:'unknown'}),undefined);
 h.request(delta);h.event({type:'error'});assert.equal(h.resolve({...delta,previous_response_id:'r2'}),undefined);
 h.request(first);h.event({type:'response.completed',response:{id:'unknown-output'}});
 assert.equal(h.resolve({...delta,previous_response_id:'unknown-output'}),undefined);
 h.request(first);h.event({type:'response.output_item.done',item:{type:'message',role:'assistant',content:[]}});
 h.event({type:'response.completed',response:{id:'final-list',output:[{type:'message',role:'assistant',content:[]},{type:'function_call',call_id:'final-call'}]}});
 assert.equal(h.resolve({...delta,previous_response_id:'final-list'})[2].call_id,'final-call');
 h.clear();assert.equal(h.resolve(delta),undefined);
});
