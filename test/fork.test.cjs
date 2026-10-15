const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const originalLoad=Module._load;
let confirmation='派生';
Module._load=function(id,...args){if(id==='vscode')return {window:{showWarningMessage:async()=> confirmation,showInformationMessage:()=>{}}};return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
const {SessionStore}=require('../dist/test/codex/session.js');
const {CheckpointManager}=require('../dist/test/checkpoints.js');
const turn=(id,text)=>({id,status:'completed',items:[{type:'userMessage',content:[{type:'text',text}]}]});
async function fixture(t,cut=1){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-fork-refresh-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new SessionStore(dir,()=>'/unused');
 const first=turn('first','第一轮'),current=turn('current','第二轮');
 store.threads.set('source',{id:'source',turns:[first]});
 const checkpoints=new CheckpointManager(dir);checkpoints.setSession('source');
 checkpoints.beginTurn('第一轮',0);
 const id=checkpoints.beginTurn('第二轮',cut);
 const ctx={sessionId:'source',checkpoints,proc:{isBusy:true}};
 const provider=Object.create(ChatViewProvider.prototype);
 const messages=[],forks=[],opened=[],state=new Map();let reads=0;
 Object.assign(provider,{context:{workspaceState:{get:key=>state.get(key),update:async(key,value)=>state.set(key,value)}},
  config:()=>({get:(_key,fallback)=>fallback}),modelCatalog:[]});
 Object.assign(provider,{store,forking:new Set(),restoring:new Set(),sessions:new Set([ctx]),detached:new Map(),storageDir:()=>dir,output:{appendLine:()=>{}},post:(_,m)=>messages.push(m),speedMode:()=> 'default',saveSessionSpeed:async()=>{},sessionEffort:()=> 'medium',saveSessionEffort:async()=>{},openSession:async id=>opened.push(id)});
 store.hydrate=async id=>{assert.equal(id,'source');reads++;store.threads.set(id,{id,turns:[first,current]});};
 store.prepareFork=()=>({ready:Promise.resolve(),dispose:async()=>{}});
 store.fork=async(source,leaf)=>{forks.push({source,leaf});store.threads.set('branch',{id:'branch',turns:[first]});return 'branch';};
 return {provider,store,ctx,checkpoints,id,first,current,messages,forks,opened,dir,state,reads:()=>reads};
}
test('派生新标签继承原会话模型，之后修改不影响原会话',async t=>{
 const f=await fixture(t);f.state.set('codexChat.sessionModel.source','source-model');
 await f.provider.forkCheckpoint(f.ctx,f.id);
 assert.equal(f.state.get('codexChat.sessionModel.branch'),'source-model');
 const branch={sessionId:'branch'};
 await f.provider.setModel(branch,'branch-model');
 assert.equal(f.provider.sessionModel(f.ctx),'source-model');
 assert.equal(f.provider.sessionModel(branch),'branch-model');
 assert.equal(f.state.get('codexChat.sessionModel.source'),'source-model');
});
test('派生新标签继承速度和推理强度，之后调节只保存新分支设置',async t=>{
 const f=await fixture(t);
 for(const method of ['speedMode','saveSessionSpeed','sessionEffort','saveSessionEffort'])delete f.provider[method];
 f.state.set('codexChat.sessionSpeed.source','fast');f.state.set('codexChat.sessionEffort.source','high');
 await f.provider.forkCheckpoint(f.ctx,f.id);
 const branch={sessionId:'branch'};
 assert.equal(f.provider.speedMode(branch),'fast');assert.equal(f.provider.sessionEffort(branch),'high');
 await f.provider.setSpeedMode(branch,'default');await f.provider.setEffort(branch,'low');
 assert.equal(f.state.get('codexChat.sessionSpeed.branch'),'default');assert.equal(f.state.get('codexChat.sessionEffort.branch'),'low');
 assert.equal(f.state.get('codexChat.sessionSpeed.source'),'fast');assert.equal(f.state.get('codexChat.sessionEffort.source'),'high');
 assert.equal(f.provider.speedMode(f.ctx),'fast');assert.equal(f.provider.sessionEffort(f.ctx),'high');
});
test('派生即时反馈、分阶段更新、重复点击不重复创建，收尾恢复界面',async t=>{
 const f=await fixture(t);let release;
 f.ctx.finalizing=new Promise(resolve=>{release=resolve;});
 const task=f.provider.forkCheckpoint(f.ctx,f.id);
 assert.equal(f.messages[0].kind,'forking');assert.equal(f.messages[0].busy,true);
 await f.provider.forkCheckpoint(f.ctx,f.id);
 release();await task;
 assert.equal(f.forks.length,1);
 assert.equal(f.ctx.sessionId,'source');assert.equal(f.ctx.proc.isBusy,true);
 const progress=f.messages.filter(m=>m.kind==='forking');
 assert.ok(progress.some(m=>m.label==='正在创建独立会话…'));
 assert.ok(progress.some(m=>m.label==='正在打开新会话…'));
 assert.equal(progress.at(-1).busy,false);assert.equal(f.provider.forking.size,0);
});
test('派生连接在读取原会话前启动，校验失败也释放连接',async t=>{
 for(const fail of [false,true]){
  const f=await fixture(t),steps=[];
  const hydrate=f.store.hydrate;
  f.store.prepareFork=()=>{steps.push('prepare');return {ready:Promise.resolve(),dispose:async()=>steps.push('dispose')};};
  f.store.hydrate=async id=>{steps.push('hydrate');if(fail)throw Error('读取失败');await hydrate(id);};
  f.provider.openSession=async(id,cached)=>{steps.push('open');assert.equal(id,'branch');assert.equal(cached,true);};
  await f.provider.forkCheckpoint(f.ctx,f.id);
  assert.deepEqual(steps.slice(0,2),['prepare','hydrate']);
  assert.equal(steps.at(-1),'dispose');
 }
});
test('派生与还原互斥，不允许同时改写同一标签的分支归属',async t=>{
 const f=await fixture(t);f.provider.restoring.add(f.ctx);
 await f.provider.forkCheckpoint(f.ctx,f.id);
 assert.equal(f.forks.length,0);assert.equal(f.messages.at(-1).busy,false);
 f.provider.restoring.clear();f.provider.forking.add(f.ctx);
 await f.provider.restoreCheckpoint(f.ctx,f.id);
 assert.match(f.messages.at(-1).message,/正在派生/);
});
test('新派生首次显示直接用完整缓存，后续打开仍读取最新历史',async t=>{
 const f=await fixture(t),rendered=[];
 f.provider.rememberSessionSpeed=()=>{};f.provider.renderSessionInto=(_ctx,id)=>rendered.push(id);
 f.ctx.initialHistoryCached=true;
 f.provider.loadSessionInto(f.ctx,'source');
 assert.equal(f.reads(),0);assert.deepEqual(rendered,['source']);
 f.provider.loadSessionInto(f.ctx,'source');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.reads(),1);assert.deepEqual(rendered,['source','source']);
});
test('服务端派生 ID 与本地还原点冲突时不覆盖、不删除既有分支',async t=>{
 const f=await fixture(t),file=path.join(f.dir,'checkpoints-branch.json');
 await fs.writeFile(file,'已有分支快照');let deletes=0;f.store.delete=async()=>{deletes++;};
 await f.provider.forkCheckpoint(f.ctx,f.id);
 assert.match(f.messages.find(m=>m.kind==='error').message,/ID.*冲突/);
 assert.equal(await fs.readFile(file,'utf8'),'已有分支快照');assert.equal(deletes,0);
 assert.equal(f.opened.length,0);assert.equal(f.ctx.sessionId,'source');
});
test('取消确认和派生异常均结束加载，异常不终止原会话',async t=>{
 for(const scenario of ['cancel','error']){
  const f=await fixture(t);
  if(scenario==='cancel')confirmation=undefined;
  else f.store.hydrate=async()=>{throw Error('读取失败');};
  try{await f.provider.forkCheckpoint(f.ctx,f.id);}finally{confirmation='派生';}
  assert.equal(f.messages.at(-1).kind,'forking');assert.equal(f.messages.at(-1).busy,false);
  assert.equal(f.provider.forking.size,0);assert.equal(f.forks.length,0);
  if(scenario==='error')assert.equal(f.messages.find(m=>m.kind==='error').keepBusy,true);
 }
});
test('回复中派生刷新缺失当前轮次的缓存，并保留原会话及还原点',async t=>{
 const f=await fixture(t);
 const before=await fs.readFile(path.join(f.dir,'checkpoints-source.json'),'utf8');
 await f.provider.forkCheckpointInner(f.ctx,f.id);
 assert.equal(f.reads(),1);
 assert.deepEqual(f.forks,[{source:'source',leaf:'first'}]);
 assert.deepEqual(f.opened,['branch']);
 assert.equal(f.messages.some(m=>m.kind==='error'),false);
 assert.equal(f.ctx.sessionId,'source');assert.equal(f.ctx.proc.isBusy,true);
 assert.equal(await fs.readFile(path.join(f.dir,'checkpoints-source.json'),'utf8'),before);
 const branch=new CheckpointManager(f.dir);branch.setSession('branch');
 assert.deepEqual(branch.list().map(c=>c.userText),['第一轮']);
});
test('派生使用刷新后校正的位置，不提前以旧位置零判定没有前序对话',async t=>{
 const f=await fixture(t,0);
 await f.provider.forkCheckpointInner(f.ctx,f.id);
 assert.equal(f.checkpoints.cutLineOf(f.id),1);
 assert.deepEqual(f.forks,[{source:'source',leaf:'first'}]);
});
test('等待收尾期间更新的位置也必须重新读取',async t=>{
 const f=await fixture(t,9);
 f.ctx.finalizing=Promise.resolve().then(()=>f.checkpoints.alignTurn(f.id,1));
 await f.provider.forkCheckpointInner(f.ctx,f.id);
 assert.deepEqual(f.forks,[{source:'source',leaf:'first'}]);
});
test('真实不匹配、缺失消息、切换会话和读取失败仍禁止派生',async t=>{
 for(const scenario of ['mismatch','missing','switched','read-error','removed']){
  const f=await fixture(t);
  f.store.hydrate=async()=>{
   if(scenario==='read-error')throw Error('历史读取失败');
   if(scenario==='switched')f.ctx.sessionId='other';
   if(scenario==='removed')f.checkpoints.clear();
   f.store.threads.set('source',{id:'source',turns:scenario==='missing'?[f.first]:[f.first,turn('wrong','别的消息')]});
  };
  if(scenario==='read-error')await assert.rejects(f.provider.forkCheckpointInner(f.ctx,f.id),/历史读取失败/);
  else {await f.provider.forkCheckpointInner(f.ctx,f.id);assert.ok(f.messages.some(m=>m.kind==='error'),scenario);}
  assert.deepEqual(f.forks,[],scenario);assert.deepEqual(f.opened,[],scenario);
 }
});
test('最新历史中的首条消息仍不能派生，合成还原点可以派生',async t=>{
 const f=await fixture(t);
 await f.provider.forkCheckpointInner(f.ctx,f.checkpoints.list()[0].id);
 assert.equal(f.forks.length,0);assert.ok(f.messages.some(m=>m.kind==='notice'));
 f.checkpoints.clear();
 await f.provider.forkCheckpointInner(f.ctx,'turn:2');
 assert.deepEqual(f.forks,[{source:'source',leaf:'first'}]);
});

test('编辑后重新生成与派生、还原、答案提交互斥，失败也释放锁',async t=>{
 const f=await fixture(t);let rewinds=0,sends=0;
 f.provider.editMessageRewind=async()=>{rewinds++;return true;};
 f.provider.handleSend=async()=>{assert.equal(f.provider.restoring.has(f.ctx),false);sends++;};
 f.provider.forking.add(f.ctx);await f.provider.editMessage(f.ctx,f.id,'新内容');f.provider.forking.clear();
 f.provider.restoring.add(f.ctx);await f.provider.editMessage(f.ctx,f.id,'新内容');f.provider.restoring.clear();
 f.ctx.answeringQuestion=true;await f.provider.editMessage(f.ctx,f.id,'新内容');f.ctx.answeringQuestion=false;
 assert.equal(rewinds,0);assert.equal(sends,0);
 let release;f.provider.editMessageRewind=async()=>{rewinds++;await new Promise(r=>release=r);return true;};
 const pending=f.provider.editMessage(f.ctx,f.id,'新内容');
 await f.provider.editMessage(f.ctx,f.id,'重复');await f.provider.forkCheckpoint(f.ctx,f.id);
 assert.equal(rewinds,1);assert.equal(f.forks.length,0);
 release();await pending;assert.equal(sends,1);
 f.provider.editMessageRewind=async()=>{throw new Error('读取失败');};
 await assert.rejects(f.provider.editMessage(f.ctx,f.id,'新内容'),/读取失败/);
 assert.equal(f.provider.restoring.has(f.ctx),false);assert.equal(sends,1);
});

test('编辑重新生成先刷新历史和还原点位置，避免用直播中的旧缓存截断',async t=>{
 const f=await fixture(t,0);const steps=[];
 f.ctx.proc=undefined;
 f.provider.forkRewind=async(_ctx,_id,cut)=>{steps.push(cut);};
 f.provider.refreshChangedFiles=()=>{};
 assert.equal(await f.provider.editMessageRewind(f.ctx,f.id),true);
 assert.equal(f.reads(),1);assert.deepEqual(steps,[1]);
});

test('重新生成提前连接且在无进程时仍收齐快照，失败也释放连接',async t=>{
 for(const fail of [false,true]){
  const f=await fixture(t),steps=[];
  f.ctx.proc=undefined;
  const preparation={ready:Promise.resolve(),dispose:async()=>steps.push('dispose')};
  f.store.prepareFork=()=>{steps.push('prepare');return preparation;};
  const hydrate=f.store.hydrate;
  f.store.hydrate=async id=>{steps.push('history');await hydrate(id);};
  f.provider.captureFinalSnapshot=async()=>{steps.push('snapshot');if(fail)throw Error('快照失败');};
  f.provider.forkRewind=async(_ctx,_id,_cut,_branch,prepared)=>{
   assert.equal(prepared,preparation);steps.push('rewind');
  };
  f.provider.refreshChangedFiles=()=>{};
  f.provider.loadCtxSession=()=>{};
  assert.equal(await f.provider.editMessageRewind(f.ctx,f.id),!fail);
  assert.deepEqual(steps,fail?['prepare','history','snapshot','dispose']:['prepare','history','snapshot','rewind','dispose']);
 }
});
