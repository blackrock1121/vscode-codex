const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return {window:{showWarningMessage:async()=> '还原'}};return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
const {SessionStore}=require('../dist/test/codex/session.js');
const {CheckpointManager}=require('../dist/test/checkpoints.js');
const user=text=>({type:'userMessage',content:[{type:'text',text}]});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-empty-restore-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new SessionStore(dir,()=>'/unused');
 store.prepareFork=()=>({ready:Promise.resolve(),dispose:async()=>{}});
 const turns=[{id:'first',status:'completed',items:[user('第一轮')]},{id:'empty',status:'interrupted',items:[]}];
 store.threads.set('source',{id:'source',turns});
 store.hydrate=async()=>{};
 const checkpoints=new CheckpointManager(dir);checkpoints.setSession('source');
 checkpoints.beginTurn('第一轮',0);
 const id=checkpoints.beginTurn('再仔细检查一遍有没有问题',1);
 const ctx={sessionId:'source',checkpoints};
 const provider=Object.create(ChatViewProvider.prototype);
 const messages=[];const forks=[];
 Object.assign(provider,{store,output:{appendLine:()=>{}},post:(_,m)=>messages.push(m),refreshChangedFiles:()=>{}});
 provider.forkRewind=async(ctx,id,cut)=>{forks.push({id,cut,leaf:store.rewindLeafFor(ctx.sessionId,cut)});return {result:checkpoints.restore(id),rewoundToStart:false};};
 return {provider,ctx,id,turns,checkpoints,messages,forks,store};
}
test('末尾空中断轮次可还原：保留上一轮，恢复提问草稿',async t=>{
 const f=await fixture(t);
 await f.provider.restoreCheckpointInner(f.ctx,f.id);
 assert.deepEqual(f.forks,[{id:f.id,cut:1,leaf:'first'}]);
 assert.equal(f.messages.some(m=>m.kind==='error'),false);
 assert.equal(f.ctx.draft,'再仔细检查一遍有没有问题');
 assert.deepEqual(f.checkpoints.list().map(c=>c.userText),['第一轮']);
});
test('从未发送消息的位置回滚后续真实轮次，草稿恢复未发送消息及图片',async t=>{
 const f=await fixture(t);
 f.turns[1].items=[user('再仔细检查一遍有没有问题')];
 const draft={text:'此前终止的消息',images:[{mediaType:'image/png',data:'original-image'}],files:['/tmp/original.ts'],contexts:[{label:'原始选区',text:'const original = 1;'}]};
 await f.provider.restoreCheckpointInner(f.ctx,f.id,false,draft);
 assert.equal(f.forks.length,1);
 assert.equal(f.ctx.draft,draft.text);assert.deepEqual(f.ctx.draftImages,draft.images);
 assert.deepEqual(f.messages.find(m=>m.kind==='draft'),{kind:'draft',...draft});
});
test('空中断特例不会放行后续有对话、运行中、非空、旧还原点和文件改动',async t=>{
 const f=await fixture(t);
 for(const status of ['completed','inProgress','failed']){
  f.turns[1].status=status;assert.equal(f.provider.emptyInterruptedCheckpoint(f.ctx,f.id),false);
 }
 f.turns[1].status='interrupted';
 f.turns[1].items=[user('另一条消息')];
 await f.provider.restoreCheckpointInner(f.ctx,f.id);
 assert.equal(f.forks.length,0);assert.ok(f.messages.some(m=>m.kind==='error'));
 f.turns[1].items=[];
 f.turns.push({id:'later',items:[user('后续消息')]});
 assert.equal(f.provider.emptyInterruptedCheckpoint(f.ctx,f.id),false);f.turns.pop();
 f.ctx.proc={isBusy:true};assert.equal(f.provider.emptyInterruptedCheckpoint(f.ctx,f.id),false);f.ctx.proc=undefined;
 f.checkpoints.recordSnapshot('/unused','原文');
 assert.equal(f.provider.emptyInterruptedCheckpoint(f.ctx,f.id),false);
 const newer=f.checkpoints.beginTurn('另一次发送',1);
 assert.equal(f.provider.emptyInterruptedCheckpoint(f.ctx,f.id),false);
 assert.equal(f.provider.emptyInterruptedCheckpoint(f.ctx,newer),false);
});
test('缺失轮次及缺失 items 不能被当成已中断空轮次',async t=>{
 const f=await fixture(t);
 assert.equal(f.store.isEmptyInterruptedTail('source',1),true);
 assert.equal(f.store.isEmptyInterruptedTail('source',0),false);
 assert.equal(f.store.isEmptyInterruptedTail('source',-1),false);
 assert.equal(f.store.isEmptyInterruptedTail('missing',0),false);
 delete f.turns[1].items;assert.equal(f.store.isEmptyInterruptedTail('source',1),false);
 f.turns.pop();assert.equal(f.store.isEmptyInterruptedTail('source',1),false);
});
test('重载后保留未落盘提问及还原入口，但不改写真实历史',async t=>{
 const f=await fixture(t);
 f.provider.maybePrespawn=()=>{};f.provider.refreshSessions=()=>{};
 f.provider.renderSessionInto(f.ctx,'source');
 const history=f.messages.find(m=>m.kind==='load_history');
 assert.deepEqual(history.items.filter(i=>i.type==='user').map(i=>i.text),['第一轮','再仔细检查一遍有没有问题']);
 assert.equal(history.checkpoints.at(-1).id,f.id);
 assert.equal(f.store.firstUserTurnAfter('source',1),undefined);
});

test('宿主停止时不提前发送空闲状态，避免队列撞上尚未结束的轮次',async t=>{
 const f=await fixture(t);let interrupted=false;
 f.ctx.proc={isBusy:true,interrupt:async()=>{interrupted=true;}};
 await f.provider.stopContext(f.ctx);
 assert.equal(interrupted,true);assert.equal(f.messages.some(m=>m.kind==='busy'&&!m.busy),false);
 f.ctx.proc.isBusy=false;await f.provider.stopContext(f.ctx);
 assert.ok(f.messages.some(m=>m.kind==='busy'&&!m.busy));
});

test('宿主拒绝答案时只返回可重试错误，不发送结束事件放行队列',async t=>{
 const f=await fixture(t);f.ctx.proc={isExited:false,prepareQuestionAnswer:()=>undefined,answerQuestion:()=>false};
 await f.provider.onPanelMessage(f.ctx,{type:'answerQuestion',requestId:'missing',answers:{q:'A'}});
 assert.equal(f.messages.at(-1).kind,'question_answer_rejected');
 assert.equal(f.messages.some(m=>['busy','result','error'].includes(m.kind)),false);
 f.ctx.proc.prepareQuestionAnswer=()=>{throw Error('磁盘写入失败');};
 await f.provider.onPanelMessage(f.ctx,{type:'answerQuestion',requestId:'missing',answers:{q:'A'}});
 assert.equal(f.messages.at(-1).message,'磁盘写入失败');
});

test('还原连接与历史读取并行，停止和快照完成前不执行回滚',async t=>{
 const f=await fixture(t),steps=[];let releaseHistory;
 f.turns[1].items=[user('再仔细检查一遍有没有问题')];
 const preparation={ready:Promise.resolve(),dispose:async()=>steps.push('dispose')};
 f.store.prepareFork=()=>{steps.push('prepare');return preparation;};
 f.store.hydrate=()=>new Promise(resolve=>{steps.push('hydrate');releaseHistory=resolve;});
 f.ctx.proc={isBusy:false,disposeAndWait:async()=>steps.push('stop')};
 f.provider.captureFinalSnapshot=async()=>steps.push('snapshot');
 const rewind=f.provider.forkRewind;
 f.provider.forkRewind=async(ctx,id,cut,branch,prepared)=>{
  assert.equal(prepared,preparation);steps.push('rewind');return rewind(ctx,id,cut);
 };
 const task=f.provider.restoreCheckpointInner(f.ctx,f.id);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(steps,['prepare','hydrate']);
 releaseHistory();await task;
 assert.deepEqual(steps,['prepare','hydrate','stop','snapshot','rewind','dispose']);
});
test('还原读取失败或会话切换时释放预备连接，不回滚',async t=>{
 for(const fail of [true,false]){
  const f=await fixture(t);let disposed=0;
  f.store.prepareFork=()=>({ready:Promise.resolve(),dispose:async()=>disposed++});
  f.store.hydrate=async()=>{if(fail)throw Error('读取失败');f.ctx.sessionId='other';};
  const task=f.provider.restoreCheckpointInner(f.ctx,f.id);
  if(fail)await assert.rejects(task,/读取失败/);else await task;
  assert.equal(disposed,1);assert.equal(f.forks.length,0);
 }
});
test('回到开头不提前创建不需要的派生连接',async t=>{
 const f=await fixture(t);
 f.store.prepareFork=()=>{throw Error('不应启动');};
 const id=f.checkpoints.list()[0].id;
 await f.provider.restoreCheckpointInner(f.ctx,id);
 assert.equal(f.forks.length,1);
});

test('编辑重发在实际回退完成后通知界面解除还原状态，再开始发送',async t=>{
 for(const first of [true,false]){
  const f=await fixture(t);
  f.turns[1].items=[user('再仔细检查一遍有没有问题')];
  f.provider.forking=new Set();f.provider.restoring=new Set();
  const id=first?f.checkpoints.list()[0].id:f.id;
  const rewind=f.provider.forkRewind;let release;
  f.provider.forkRewind=async(...args)=>{await new Promise(resolve=>{release=resolve;});return rewind(...args);};
  let sent=false;
  f.provider.handleSend=async(ctx,text)=>{
   assert.equal(ctx,f.ctx);assert.equal(text,'重新回答');
   assert.equal(f.provider.restoring.has(ctx),false);
   assert.deepEqual(f.messages.map(m=>m.kind),['restoring','restored']);
   sent=true;
  };
  const task=f.provider.editMessage(f.ctx,id,'重新回答');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.messages.map(m=>m.kind),['restoring']);assert.equal(sent,false);
  release();await task;
  assert.equal(sent,true);assert.equal(f.forks.length,1);
 }
});

test('编辑回退失败不发送完成通知或重发消息',async t=>{
 const f=await fixture(t);
 f.turns[1].items=[user('再仔细检查一遍有没有问题')];
 f.provider.forking=new Set();f.provider.restoring=new Set();f.provider.loadCtxSession=()=>{};
 f.provider.forkRewind=async()=>{throw Error('回退失败');};
 f.provider.handleSend=async()=>assert.fail('回退失败不能重发');
 await f.provider.editMessage(f.ctx,f.id,'重新回答');
 assert.equal(f.messages.some(m=>m.kind==='restored'),false);
 assert.ok(f.messages.some(m=>m.kind==='error'));
 assert.equal(f.provider.restoring.has(f.ctx),false);
});
