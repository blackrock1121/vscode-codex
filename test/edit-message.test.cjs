const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return {workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback})},Uri:{file:p=>p}};return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
const {SessionStore}=require('../dist/test/codex/session.js');
const {CheckpointManager}=require('../dist/test/checkpoints.js');
const user=text=>({type:'userMessage',content:[{type:'text',text}]});
async function fixture(t, withAdded=false){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-edit-message-'));
 const workspace=path.join(dir,'project');await fs.mkdir(workspace);
 const file=path.join(workspace,'source.txt');await fs.writeFile(file,'c结束时');
 const turns=['a','b','c'].map(text=>({id:`turn-${text}`,status:'completed',items:[user(text),{type:'agentMessage',text:`${text}结束`}]}));
 const store=new SessionStore(workspace,()=>'/unused');store.threads.set('source',{id:'source',turns});store.hydrate=async()=>{};
 const events=[],forks=[],sent=[],steps=[];
 store.prepareFork=()=>({ready:Promise.resolve(),dispose:async()=>steps.push('释放连接')});
 const checkpoints=new CheckpointManager(dir);checkpoints.setSession('source');const ids=[];
 for(const [i,text] of ['a','b','c'].entries()){
  ids.push(checkpoints.beginTurn(text,i,true));checkpoints.recordSnapshot(file,i===0?'a开始前':`${['a','b'][i-1]}结束时`);
  await fs.writeFile(file,`${text}结束时`);
  if(withAdded&&text==='c'){const added=path.join(workspace,'c-added.txt');await fs.writeFile(added,'c创建');checkpoints.recordSnapshot(added,null);}
  checkpoints.completeSnapshot();
 }
 checkpoints.flush();const ctx={sessionId:'source',checkpoints};
 const provider=Object.create(ChatViewProvider.prototype),settings=new Map([
  ['codexChat.sessionModel.source','chosen-model'],['codexChat.sessionEffort.source','high'],['codexChat.sessionSpeed.source','fast'],
 ]);
 Object.assign(provider,{store,sessions:new Set([ctx]),detached:new Map(),restoring:new Set(),forking:new Set(),
  context:{workspaceState:{get:key=>settings.get(key),update:async(key,value)=>settings.set(key,value)}},storageDir:()=>dir,
  config:()=>({get:(_key,fallback)=>fallback}),output:{appendLine:()=>{}},post:(_ctx,m)=>events.push(m),
  refreshSessions:()=>{},renderSessions:()=>{},refreshChangedFiles:()=>{},clearSessionNotification:()=>{},
 });
 store.fork=async(source,leaf)=>{
  forks.push({source,leaf});steps.push('派生');const original=store.threads.get(source).turns;
  store.threads.set('branch',{id:'branch',turns:structuredClone(original.slice(0,original.findIndex(turn=>turn.id===leaf)+1))});return 'branch';
 };
 store.delete=async id=>store.threads.delete(id);
 provider.handleSend=async(...args)=>{steps.push('发送');sent.push(args);return true;};
 t.after(async()=>{ctx.checkpoints.flush();checkpoints.flush();await fs.rm(dir,{recursive:true,force:true});});
 const request={type:'editMessage',requestId:'edit-b',checkpointId:ids[1],text:'B',context:'原选区',files:[file],images:[{mediaType:'image/png',data:'aGVsbG8='}]};
 const submit=()=>provider.editMessage(ctx,request.checkpointId,request.text,request.images,request);
 return {dir,workspace,file,turns,store,ctx,provider,events,forks,sent,steps,ids,request,submit};
}
test('a开始→a结束→b开始→b结束→c：编辑 b 后回到 a结束的文件和完整对话，再发送 B',async t=>{
 const f=await fixture(t,true);
 const added=path.join(f.workspace,'c-added.txt');
 f.ctx.checkpoints.accept(f.file);f.ctx.checkpoints.flush();
 const original=await fs.readFile(path.join(f.dir,'checkpoints-source.json'),'utf8');
 const send=f.provider.handleSend;
 f.provider.handleSend=async(...args)=>{
  assert.equal(await fs.readFile(f.file,'utf8'),'a结束时');await assert.rejects(fs.access(added),{code:'ENOENT'});
  assert.deepEqual(f.store.threads.get('branch').turns,[f.turns[0]],'完整保留 a 的提问和回复，旧 b/c 均不进入新上下文');
  assert.equal(f.provider.restoring.has(f.ctx),false);
  assert.equal(f.events.find(m=>m.kind==='edit_message_result').ok,true);
  assert.equal(f.events.at(-1).kind,'restored');return send(...args);
 };
 await f.submit();
 assert.deepEqual(f.forks,[{source:'source',leaf:'turn-a'}]);assert.equal(f.sent.length,1);
 assert.equal(f.sent[0][1],'B');assert.equal(f.sent[0][2],'原选区');assert.deepEqual(f.sent[0][3],f.request.images);
 assert.deepEqual(f.sent[0][4],[f.file]);assert.equal(f.sent[0][7],'edit-b');
 assert.deepEqual(f.store.threads.get('source').turns,f.turns);
 assert.equal(await fs.readFile(path.join(f.dir,'checkpoints-source.json'),'utf8'),original);
 await f.ctx.settingsQueue;
 assert.equal(f.provider.sessionModel(f.ctx),'chosen-model');assert.equal(f.provider.sessionEffort(f.ctx),'high');assert.equal(f.provider.speedMode(f.ctx),'fast');
});
test('编辑 a 开始时回到空上下文和 a 之前的文件，不保留旧 a 的回复',async t=>{
 const f=await fixture(t);f.request.checkpointId=f.ids[0];f.request.text='A';await f.submit();
 assert.equal(f.ctx.sessionId,undefined);assert.deepEqual(f.forks,[]);assert.equal(await fs.readFile(f.file,'utf8'),'a开始前');
 assert.equal(f.sent.length,1);assert.equal(f.sent[0][1],'A');assert.equal(f.events.find(m=>m.kind==='edit_message_result').sessionId,undefined);
 assert.deepEqual(f.store.threads.get('source').turns,f.turns);
});

test('编辑重发发现文件有其他来源的新修改时不创建分支、不截断对话、不发送',async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,'另一个会话刚完成的成果');
 await f.submit();
 assert.equal(f.ctx.sessionId,'source');assert.equal(f.forks.length,0);assert.equal(f.sent.length,0);
 assert.equal(await fs.readFile(f.file,'utf8'),'另一个会话刚完成的成果');
 assert.equal(f.store.threads.get('source').turns.length,3);
 assert.equal(f.events.some(event=>event.kind==='edit_message_result'&&event.ok),false);
 assert.ok(f.events.some(event=>JSON.stringify(event).includes('文件又被修改')));
});
test('正在运行 c 时编辑 b，必须等 c 停止和最终快照收齐后才回退、发送 B',async t=>{
 const f=await fixture(t);let release;
 f.ctx.proc={isBusy:true,disposeAndWait:()=>new Promise(resolve=>{f.steps.push('正在停止');release=()=>{f.steps.push('已停止');resolve();};})};
 f.provider.captureFinalSnapshot=async()=>{f.steps.push('快照');};
 const task=f.submit();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.steps,['正在停止']);assert.equal(f.forks.length,0);assert.equal(f.sent.length,0);
 release();await task;
 assert.deepEqual(f.steps,['正在停止','已停止','快照','派生','释放连接','发送']);assert.equal(f.sent.length,1);
});
test('历史读取或派生失败保留原会话、不发送 B，回传失败且不重载界面丢掉草稿',async t=>{
 for(const stage of ['history','fork','missing']){
  const f=await fixture(t);f.provider.loadCtxSession=()=>assert.fail('编辑失败不能销毁界面草稿');
  if(stage==='history')f.store.hydrate=async()=>{throw Error('读取失败');};
  if(stage==='fork')f.store.fork=async()=>{throw Error('派生失败');};
  if(stage==='missing')f.request.checkpointId='missing';
  await f.submit();
  assert.equal(f.ctx.sessionId,'source');assert.equal(await fs.readFile(f.file,'utf8'),'c结束时');assert.equal(f.sent.length,0);
  const result=f.events.find(m=>m.kind==='edit_message_result');assert.equal(result.ok,false);assert.equal(result.busy,false);
  assert.equal(f.events.some(m=>m.kind==='restored'),false);assert.equal(f.provider.restoring.has(f.ctx),false);
 }
});
test('并发发送或重复编辑被拒绝，空白无图消息不会触发回退',async t=>{
 const f=await fixture(t);f.ctx.sending=true;await f.submit();assert.equal(f.forks.length,0);f.ctx.sending=false;
 f.request.text=' ';f.request.images=[];await f.submit();assert.equal(f.forks.length,0);
 f.request.text='B';let release;f.store.hydrate=()=>new Promise(resolve=>{release=resolve;});
 const task=f.submit();await new Promise(resolve=>setImmediate(resolve));await f.submit();assert.equal(f.forks.length,0);
 release();await task;assert.equal(f.forks.length,1);assert.equal(f.sent.length,1);
});
test('回退成功但新消息发送失败时通知界面保留可取回的 B 和附件',async t=>{
 const f=await fixture(t);f.provider.handleSend=async()=>false;await f.submit();
 assert.equal(f.ctx.sessionId,'branch');assert.equal(f.events.find(m=>m.kind==='edit_message_result').ok,true);
 assert.deepEqual(f.events.find(m=>m.kind==='send_cancelled'),{kind:'send_cancelled',sendId:'edit-b'});
 assert.equal(f.events.at(-1).kind,'busy');assert.equal(f.events.at(-1).busy,false);
});
test('无法还原的文件提示在界面替换旧消息之后发送，避免随 b/c 一起被删掉',async t=>{
 const f=await fixture(t);f.ctx.checkpoints.recordUnrestorable([path.join(f.workspace,'large.bin')]);await f.submit();
 const accepted=f.events.findIndex(m=>m.kind==='edit_message_result'&&m.ok);
 const warning=f.events.findIndex(m=>m.kind==='notice'&&m.message.includes('large.bin'));
 assert.ok(accepted>=0);assert.ok(warning>accepted);assert.equal(f.sent.length,1);
});
