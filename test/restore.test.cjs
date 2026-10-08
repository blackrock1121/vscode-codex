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
