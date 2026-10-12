const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return {window:{showWarningMessage:async()=> '派生',showInformationMessage:()=>{}}};return originalLoad.call(this,id,...args);};
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
 const messages=[],forks=[],opened=[];let reads=0;
 Object.assign(provider,{store,storageDir:()=>dir,output:{appendLine:()=>{}},post:(_,m)=>messages.push(m),speedMode:()=> 'default',saveSessionSpeed:async()=>{},openSession:async id=>opened.push(id)});
 store.hydrate=async id=>{assert.equal(id,'source');reads++;store.threads.set(id,{id,turns:[first,current]});};
 store.fork=async(source,leaf)=>{forks.push({source,leaf});store.threads.set('branch',{id:'branch',turns:[first]});return 'branch';};
 return {provider,store,ctx,checkpoints,id,first,current,messages,forks,opened,dir,reads:()=>reads};
}
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
