const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
let choice='还原';const dialogs=[];
const vscode={window:{showWarningMessage:async(...args)=>{dialogs.push(args);return choice;}},
 workspace:{getConfiguration:()=>({get:(_key,fallback)=>fallback})},Uri:{file:p=>p}};
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return vscode;return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
const {SessionStore}=require('../dist/test/codex/session.js');
const {CheckpointManager}=require('../dist/test/checkpoints.js');
const {WorkspaceSnapshot}=require('../dist/test/snapshot.js');
const {CodexProcess,questionStateFile}=require('../dist/test/codex/process.js');
const {QUESTION_REPLY_PREFIX,checkpointTextKey}=require('../dist/test/codex/events.js');
const user=text=>({type:'userMessage',content:[{type:'text',text}]});
const reply=answer=>QUESTION_REPLY_PREFIX+JSON.stringify([{question:'安装来源',answers:[answer]}]);
async function fixture(t){
 choice='还原';dialogs.length=0;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-reanswer-'));
 const workspace=path.join(dir,'project');await fs.mkdir(workspace);
 const file=path.join(workspace,'source.txt');await fs.writeFile(file,'按旧答案修改后');
 const first={id:'ask-turn',status:'interrupted',items:[user('完成安装'),{id:'ask',type:'dynamicToolCall',tool:'AskUserQuestion',arguments:{questions:[{id:'source',question:'安装来源',options:[{label:'A'},{label:'B'}]}]}}]};
 const turns=[first,{id:'answer-turn',status:'completed',items:[user(reply('A')),{type:'agentMessage',text:'旧答案的后续回复'}]}];
 const store=new SessionStore(workspace,()=>'/unused');store.threads.set('source',{id:'source',turns});store.hydrate=async()=>{};
 const checkpoints=new CheckpointManager(dir);checkpoints.setSession('source');
 checkpoints.beginTurn('完成安装',0);checkpoints.recordSnapshot(file,'任务开始前');
 const id=checkpoints.beginTurn(reply('A'),1,true);checkpoints.recordSnapshot(file,'提问前已完成的修改');checkpoints.completeSnapshot();checkpoints.flush();
 const ctx={sessionId:'source',checkpoints};const messages=[],forks=[];
 const provider=Object.create(ChatViewProvider.prototype);
 Object.assign(provider,{store,sessions:new Set([ctx]),detached:new Map(),restoring:new Set(),forking:new Set(),
  context:{workspaceState:{get:()=>undefined,update:async()=>{}}},storageDir:()=>dir,workspaceDirs:()=>[workspace],cwd:()=>workspace,
  localSnapshotExcludedPaths:()=>new Set(),reportSnapshotSkips:()=>{},config:()=>({get:(_key,fallback)=>fallback}),
  output:{appendLine:()=>{}},post:(_ctx,m)=>messages.push(m),speedMode:()=> 'default',rememberSessionSpeed:()=>{},
  refreshSessions:()=>{},renderSessions:()=>{},refreshChangedFiles:()=>{},maybeNotifyWaiting:()=>{},
 });
 store.fork=async(source,leaf)=>{
  forks.push({source,leaf});const original=store.threads.get(source).turns;
  const kept=original.slice(0,original.findIndex(turn=>turn.id===leaf)+1);
  store.threads.set('branch',{id:'branch',turns:structuredClone(kept)});return 'branch';
 };
 store.delete=async id=>{store.threads.delete(id);};
 t.after(async()=>{ctx.checkpoints.flush();checkpoints.flush();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,workspace,file,first,turns,store,checkpoints,ctx,provider,messages,forks,id};
}
test('带图回答还原后按问题回填图片，落盘和宿主消息都保留附件',async t=>{
 const f=await fixture(t);const picture={mediaType:'image/png',data:'aGVsbG8='};
 const text=QUESTION_REPLY_PREFIX+JSON.stringify([{question:'安装来源',answers:['（见附图）'],imageCount:1,imageNumbers:[1]}]);
 f.turns[1].items=[{type:'userMessage',content:[{type:'text',text},{type:'image',url:'data:image/png;base64,aGVsbG8='}]}];
 f.checkpoints.clear();const id=f.checkpoints.beginTurn(text,1,true);f.checkpoints.completeSnapshot();
 await f.provider.restoreCheckpoint(f.ctx,id,true);
 const request=f.messages.find(m=>m.kind==='permission_request');
 assert.deepEqual(request.initialImages,{source:[picture]});assert.deepEqual(request.initialAnswers,{source:''});
 const saved=JSON.parse(await fs.readFile(questionStateFile(f.dir,'branch'),'utf8'));
 assert.deepEqual(saved.request.initialImages,{source:[picture]});
});
test('提交问题答案时，宿主在预检和实际发送中都转交图片',async t=>{
 const f=await fixture(t);f.store.threads.set('source',{id:'source',turns:[f.first]});const calls=[];
 const images={source:[{mediaType:'image/png',data:'aGVsbG8='}]};
 f.ctx.proc={isExited:false,prepareQuestionAnswer:(key,answers,pictures)=>{calls.push(pictures);return {text:reply('A'),turnId:'ask-turn'};},
 answerQuestion:(key,answers,pictures)=>{calls.push(pictures);return true;}};
 await f.provider.submitQuestionAnswer(f.ctx,'request',{source:'A'},images);
 assert.equal(calls.length,3);assert.ok(calls.every(value=>value===images));
});
test('成功回复只清理当前真实会话的通知，提交失败不能清理',async t=>{
 for(const accepted of [true,false]){
  const f=await fixture(t),cleared=[];
  f.store.threads.set('source',{id:'source',turns:[f.first]});
  f.provider.clearSessionNotification=id=>cleared.push(id);
  f.ctx.proc={isExited:false,prepareQuestionAnswer:()=>({text:reply('A'),turnId:'ask-turn'}),answerQuestion:()=>accepted};
  if(accepted)await f.provider.submitQuestionAnswer(f.ctx,'request',{source:'A'});
  else await assert.rejects(f.provider.submitQuestionAnswer(f.ctx,'request',{source:'A'}),/未提交/);
  assert.deepEqual(cleared,accepted?['source']:[]);
 }
});
test('还原成功切换通知归属，回到开头同样清理；取消或失败保留原通知',async t=>{
 for(const mode of ['branch','start','cancel','failed']){
  const f=await fixture(t),cleared=[];
  f.provider.clearSessionNotification=id=>cleared.push(id);
  f.ctx.lastUserText='旧任务';f.ctx.pendingPerm={kind:'permission_request',requestId:'old'};
  if(mode==='cancel')choice=undefined;
  if(mode==='failed')f.provider.cpRestore=()=>{throw Error('还原失败');};
  const id=mode==='start'?f.checkpoints.list()[0].id:f.id;
  await f.provider.restoreCheckpoint(f.ctx,id);
  if(['branch','start'].includes(mode)){
   assert.deepEqual(cleared,['source']);
   assert.equal(f.ctx.sessionId,mode==='start'?undefined:'branch');
   assert.equal(f.ctx.lastUserText,undefined);assert.equal(f.ctx.pendingPerm,undefined);
   assert.ok(f.store.findFile('source'),'原会话仍可从历史打开');
  }else{
   assert.deepEqual(cleared,[]);assert.equal(f.ctx.sessionId,'source');
   assert.equal(f.ctx.lastUserText,'旧任务');
  }
 }
});
test('重新回答准确回到答案之前，只撤销答案后的文件，保留原会话并恢复可编辑的问题',async t=>{
 const f=await fixture(t);let stopped=false;
 f.ctx.proc={isBusy:true,disposeAndWait:async()=>{stopped=true;}};
 const original=await fs.readFile(path.join(f.dir,'checkpoints-source.json'),'utf8');
 await f.provider.restoreCheckpoint(f.ctx,f.id,true);
 assert.equal(stopped,true);assert.deepEqual(f.forks,[{source:'source',leaf:'ask-turn'}]);
 assert.equal(await fs.readFile(f.file,'utf8'),'提问前已完成的修改');
 assert.equal(f.store.load('source').some(i=>i.text==='旧答案的后续回复'),true);
 assert.equal(f.store.load('branch').some(i=>i.type==='user'&&i.text===reply('A')),false);
 assert.equal(await fs.readFile(path.join(f.dir,'checkpoints-source.json'),'utf8'),original);
 const question=f.messages.find(m=>m.kind==='permission_request');
 assert.deepEqual(question.initialAnswers,{source:'A'});
 assert.deepEqual(question.input.questions[0].options,[{label:'A'},{label:'B'}]);
 assert.equal(f.messages.some(m=>m.kind==='busy'&&!m.busy),false,'还原过程中不能放行排队消息');
 assert.equal(f.messages.some(m=>m.kind==='draft'),false,'旧答案不能作为聊天草稿再次发送');
 const saved=JSON.parse(await fs.readFile(questionStateFile(f.dir,'branch'),'utf8'));
 assert.equal(saved.turnId,'ask-turn');
 assert.equal(saved.request.requestId,question.requestId);
 const requests=[];const p=new CodexProcess({codexPath:'/unused',cwd:f.workspace,permissionMode:'default',questionStateDir:f.dir,resumeSessionId:'branch'},
  {emit:()=>{},onPermission:q=>requests.push(q),onSessionId:()=>{},onClose:()=>{}});
 p.sessionId='branch';await p.restoreQuestion(f.store.threads.get('branch'));
 assert.equal(p.isBusy,true);assert.deepEqual(requests[0].initialAnswers,{source:'A'});
 let submitted;p.sendUserMessage=text=>{submitted=text;return true;};
 assert.equal(p.answerQuestion(question.requestId,{source:'B'}),true);
 assert.equal(submitted,reply('B'));
 await assert.rejects(fs.access(questionStateFile(f.dir,'branch')));
 p.dispose();
});
test('无文件快照时阻止重新回答，不提供只回退对话的降级',async t=>{
 const f=await fixture(t);f.checkpoints.clear();
 choice=undefined;await f.provider.restoreCheckpoint(f.ctx,'turn:2',true);
 assert.deepEqual(f.forks,[]);assert.equal(await fs.readFile(f.file,'utf8'),'按旧答案修改后');
 choice='还原';await f.provider.restoreCheckpoint(f.ctx,'turn:2',true);
 assert.equal(dialogs.length,0);
 assert.match(f.messages.at(-1).message,/无法完整还原并重新回答/);
 assert.deepEqual(f.forks,[]);
 assert.equal(await fs.readFile(f.file,'utf8'),'按旧答案修改后');
 assert.equal(f.messages.some(m=>m.kind==='permission_request'),false);
 const g=await fixture(t);g.turns[1].items=[user('普通消息')];
 await g.provider.restoreCheckpoint(g.ctx,g.id,true);
 assert.deepEqual(g.forks,[]);assert.match(g.messages.at(-1).message,/无法准确还原/);
});
test('重新回答回滚后续所有轮次及已保留的改动，恢复删除文件并删除新增文件',async t=>{
 const f=await fixture(t);
 const added=path.join(f.workspace,'added.bin'),deleted=path.join(f.workspace,'deleted.txt');
 f.checkpoints.recordSnapshot(added,null);await fs.writeFile(added,Buffer.from([0,1,2]));
 f.checkpoints.accept(f.file);
 assert.equal(f.checkpoints.changedPaths().includes(f.file),false);
 f.turns.push({id:'later-turn',status:'completed',items:[user('继续改'),{type:'agentMessage',text:'再下一轮的回复'}]});
 f.checkpoints.beginTurn('继续改',2,true);
 f.checkpoints.recordSnapshot(f.file,'按旧答案修改后');await fs.writeFile(f.file,'后续再次修改');
 f.checkpoints.recordSnapshot(deleted,'删除前内容');
 f.checkpoints.accept(f.file);f.checkpoints.completeSnapshot();f.checkpoints.flush();
 // 经落盘重载后，已保留改动的还原原文仍在。
 f.ctx.checkpoints=new CheckpointManager(f.dir);f.ctx.checkpoints.setSession('source');
 await f.provider.restoreCheckpoint(f.ctx,f.id,true);
 assert.equal(await fs.readFile(f.file,'utf8'),'提问前已完成的修改');
 assert.equal(await fs.readFile(deleted,'utf8'),'删除前内容');await assert.rejects(fs.access(added));
 assert.equal(f.store.threads.get('branch').turns.length,1);
 assert.equal(f.store.threads.get('source').turns.length,3);
 assert.match(dialogs[0][1].detail,/包括后续轮次和已点击保留的改动/);
});
test('缺少可验证基线、后续关闭快照或丢失还原点时不能只回退对话',async t=>{
 for(const mode of ['legacy','disabled','missing']){
  const f=await fixture(t);
  if(mode==='legacy'){
   f.checkpoints.clear();f.id=f.checkpoints.beginTurn(reply('A'),1);
   f.checkpoints.recordSnapshot(f.file,'仅有部分备份');
  }else{
   f.turns.push({id:'later',status:'completed',items:[user('后续修改')]});
   if(mode==='disabled')f.checkpoints.beginTurn('后续修改',2,false);
  }
  await f.provider.restoreCheckpoint(f.ctx,f.id,true);
  assert.equal(f.forks.length,0);assert.equal(f.ctx.sessionId,'source');
  assert.equal(await fs.readFile(f.file,'utf8'),'按旧答案修改后');
  assert.equal(f.messages.some(m=>m.kind==='permission_request'),false);
 }
});
test('停止后发现无法备份的二进制改动时，其他文件也不能先回滚',async t=>{
 const f=await fixture(t);const binary=path.join(f.workspace,'binary.dat');
 await fs.writeFile(binary,Buffer.from([0,1]));
 f.ctx.snapshot=new WorkspaceSnapshot([f.workspace]);await f.ctx.snapshot.capture();
 f.ctx.mayHaveModifiedWorkspace=true;
 f.ctx.proc={isBusy:true,disposeAndWait:async()=>{await fs.writeFile(binary,Buffer.from([0,2,3]));}};
 await f.provider.restoreCheckpoint(f.ctx,f.id,true);
 assert.equal(f.forks.length,0);assert.equal(f.ctx.sessionId,'source');
 assert.equal(await fs.readFile(f.file,'utf8'),'按旧答案修改后');
 assert.match(f.messages.at(-1).message,/无法完整回滚文件/);
 assert.equal(f.messages.some(m=>m.kind==='permission_request'),false);
});
test('取消完整还原时不停止生成、不改文件、不创建分支',async t=>{
 const f=await fixture(t);choice=undefined;let stopped=false;
 f.ctx.proc={isBusy:true,disposeAndWait:async()=>{stopped=true;}};
 await f.provider.restoreCheckpoint(f.ctx,f.id,true);
 assert.equal(stopped,false);assert.equal(f.forks.length,0);
 assert.equal(await fs.readFile(f.file,'utf8'),'按旧答案修改后');
});
test('快照未修改的二进制不阻止还原，新增二进制可删除，扫描超限明确阻止',async t=>{
 const f=await fixture(t);const old=path.join(f.workspace,'old.bin'),added=path.join(f.workspace,'new.bin');
 await fs.writeFile(old,Buffer.from([0,1]));const snapshot=new WorkspaceSnapshot([f.workspace]);await snapshot.capture();
 await fs.writeFile(added,Buffer.from([0,2]));
 const changes=await snapshot.changed();assert.equal(changes.get(added),null);assert.equal(snapshot.unrestorableChanges.size,0);
 const limited=new WorkspaceSnapshot([f.workspace],1);await limited.capture();await limited.changed();
 assert.equal(limited.unrestorableChanges.has(f.workspace),true);
});
test('活动轮次的新建文件收齐差异后可以还原，丢失内存基线的未归档轮次会阻止还原',async t=>{
 const f=await fixture(t);const added=path.join(f.workspace,'new.txt');
 f.ctx.snapshot=new WorkspaceSnapshot([f.workspace]);await f.ctx.snapshot.capture();
 f.ctx.mayHaveModifiedWorkspace=true;
 f.checkpoints.recordUnrestorable([added]);await fs.writeFile(added,'工具新建文件');
 await f.provider.restoreCheckpoint(f.ctx,f.id,true);
 assert.equal(f.forks.length,1);await assert.rejects(fs.access(added));
 assert.equal(f.messages.some(m=>m.kind==='permission_request'),true);
 const g=await fixture(t);g.checkpoints.clear();g.id=g.checkpoints.beginTurn(reply('A'),1,true);
 g.checkpoints.recordSnapshot(g.file,'提问前已完成的修改');g.checkpoints.flush();
 g.ctx.checkpoints=new CheckpointManager(g.dir);g.ctx.checkpoints.setSession('source');
 await g.provider.restoreCheckpoint(g.ctx,g.id,true);
 assert.equal(g.forks.length,0);assert.equal(await fs.readFile(g.file,'utf8'),'按旧答案修改后');
 assert.match(g.messages.at(-1).message,/未完整归档/);
});
test('提交答案前建立独立文件基线，重试失败不会遗留虚假的回答还原点',async t=>{
 const f=await fixture(t);f.checkpoints.clear();f.checkpoints.beginTurn('完成安装',0);
 f.store.threads.set('source',{id:'source',turns:[f.first]});
 await fs.writeFile(f.file,'任务开始前');f.ctx.snapshot=new WorkspaceSnapshot([f.workspace]);await f.ctx.snapshot.capture();
 await fs.writeFile(f.file,'提问前已完成的修改');f.ctx.mayHaveModifiedWorkspace=true;
 f.ctx.proc={isExited:false,prepareQuestionAnswer:()=>({text:reply('A'),turnId:'ask-turn'}),answerQuestion:()=>true};
 await f.provider.submitQuestionAnswer(f.ctx,'request',{source:'A'});
 const marker=f.messages.find(m=>m.kind==='question_checkpoint');assert.ok(marker);
 assert.equal(f.checkpoints.metaOf(marker.checkpointId).truncateLine,1);
 await fs.writeFile(f.file,'答案后的改动');await f.provider.captureFinalSnapshot(f.ctx);
 f.checkpoints.restore(marker.checkpointId);
 assert.equal(await fs.readFile(f.file,'utf8'),'提问前已完成的修改');
 const firstId=f.checkpoints.list()[0].id;f.checkpoints.restore(firstId);
 assert.equal(await fs.readFile(f.file,'utf8'),'任务开始前');
 f.ctx.proc.answerQuestion=()=>false;
 await assert.rejects(f.provider.submitQuestionAnswer(f.ctx,'request',{source:'A'}),/答案未提交/);
 assert.equal(f.checkpoints.list().length,0);
});
test('重复问题的不同答案不混淆还原点，秘密答案不回填或写入新的等待记录',async t=>{
 const f=await fixture(t);
 const long='相同问题'.repeat(30);
 const a=QUESTION_REPLY_PREFIX+JSON.stringify([{question:long,answers:['A']}]);
 const b=QUESTION_REPLY_PREFIX+JSON.stringify([{question:long,answers:['B']}]);
 assert.notEqual(checkpointTextKey(a),checkpointTextKey(b));
 f.checkpoints.clear();const id=f.checkpoints.beginTurn(b,2);
 f.turns[1].items=[user(a)];f.turns.push({id:'next',status:'completed',items:[user(b)]});
 f.provider.checkpointsForView(f.ctx,'source');assert.equal(f.checkpoints.cutLineOf(id),2);
 assert.equal(f.provider.checkpointAligned('source',{truncateLine:1,userText:b}),false);
 f.turns[1].items=[user(b)];
 f.provider.checkpointsForView(f.ctx,'source');assert.equal(f.checkpoints.cutLineOf(id),2,'两个相同答案也不能把后一个还原点挪到前一个');
 f.turns[1].items=[user(QUESTION_REPLY_PREFIX+JSON.stringify([{question:'安装来源',isSecret:true,answers:['PRIVATE']}]))];
 const question=f.store.questionBeforeAnswer('source',1);
 assert.equal(question.input.questions[0].isSecret,true);assert.deepEqual(question.initialAnswers,{});
 assert.doesNotMatch(JSON.stringify(question),/PRIVATE/);
});
test('答案准备期间停止会取消提交，连续点击不会重复续轮',async t=>{
 const f=await fixture(t);f.store.threads.set('source',{id:'source',turns:[f.first]});
 let finishRead,submitted=0;
 f.store.hydrate=()=>new Promise(resolve=>{finishRead=resolve;});
 f.ctx.proc={isExited:false,isBusy:true,interrupt:async()=>{},prepareQuestionAnswer:()=>({text:reply('B'),turnId:'ask-turn'}),answerQuestion:()=>{submitted++;return true;}};
 const message={type:'answerQuestion',requestId:'current',answers:{source:'B'}};
 const pending=f.provider.onPanelMessage(f.ctx,message);
 await f.provider.onPanelMessage(f.ctx,message);
 await f.provider.stopContext(f.ctx);finishRead();await pending;
 assert.equal(submitted,0);assert.equal(f.messages.some(m=>m.kind==='question_checkpoint'),false);
 assert.match(f.messages.find(m=>m.kind==='question_answer_rejected').message,/取消/);
});
test('工具返回相对路径时使用工作目录匹配快照，不误判缺少原文',async t=>{
 const f=await fixture(t);
 f.ctx.snapshot=new WorkspaceSnapshot([f.workspace]);await f.ctx.snapshot.capture();
 f.provider.handleEmitInner(f.ctx,{kind:'tool_input',toolId:'edit',name:'Edit',input:{file_path:'./source.txt'}});
 await fs.writeFile(f.file,'又一次修改');await f.provider.captureFinalSnapshot(f.ctx);
 assert.equal(f.checkpoints.restoreBlockReason(f.id),undefined);
 await f.provider.restoreCheckpoint(f.ctx,f.id,true);
 assert.equal(await fs.readFile(f.file,'utf8'),'提问前已完成的修改');
});
test('只读取的文件不登记为待回滚改动，不覆盖用户随后自行修改的内容',async t=>{
 const f=await fixture(t);f.checkpoints.clear();const id=f.checkpoints.beginTurn(reply('A'),1,true);
 f.ctx.snapshot=new WorkspaceSnapshot([f.workspace]);await f.ctx.snapshot.capture();
 f.provider.handleEmitInner(f.ctx,{kind:'tool_input',toolId:'read',name:'Read',input:{file_path:'source.txt'}});
 await fs.writeFile(f.file,'用户自行修改');await f.provider.captureFinalSnapshot(f.ctx);
 assert.deepEqual(f.checkpoints.changedPaths(),[]);
 assert.equal(f.checkpoints.restore(id).restoredFiles,0);
 assert.equal(await fs.readFile(f.file,'utf8'),'用户自行修改');
});
test('问题卡落盘失败时不回滚文件、不切换会话，并清理未完成的新分支',async t=>{
 const f=await fixture(t);const syncFs=require('node:fs');const rename=syncFs.renameSync;
 t.mock.method(syncFs,'renameSync',function(from,to){
  if(to===questionStateFile(f.dir,'branch'))throw Error('模拟问题卡落盘失败');
  return rename.apply(this,arguments);
 });
 await f.provider.restoreCheckpoint(f.ctx,f.id,true);
 assert.equal(f.ctx.sessionId,'source');assert.equal(f.store.threads.has('branch'),false);
 assert.equal(await fs.readFile(f.file,'utf8'),'按旧答案修改后');
 assert.equal(f.checkpoints.list().some(cp=>cp.id===f.id),true);
 assert.equal(f.messages.some(m=>m.kind==='permission_request'),false);
 assert.match(f.messages.at(-1).message,/模拟问题卡落盘失败/);
 await assert.rejects(fs.access(questionStateFile(f.dir,'branch')+'.tmp'));
});
test('文件回滚失败时清理已保存的问题卡，保留原会话可重试',async t=>{
 const f=await fixture(t);const blocked=path.join(f.workspace,'blocked.txt');await fs.mkdir(blocked);
 f.checkpoints.recordSnapshot(blocked,'原文');
 await f.provider.restoreCheckpoint(f.ctx,f.id,true);
 assert.equal(f.ctx.sessionId,'source');assert.equal(f.store.threads.has('branch'),false);
 assert.equal(await fs.readFile(f.file,'utf8'),'按旧答案修改后');
 await assert.rejects(fs.access(questionStateFile(f.dir,'branch')));
});
