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
 const id=checkpoints.beginTurn(reply('A'),1);checkpoints.recordSnapshot(file,'提问前已完成的修改');checkpoints.flush();
 const ctx={sessionId:'source',checkpoints};const messages=[],forks=[];
 const provider=Object.create(ChatViewProvider.prototype);
 Object.assign(provider,{store,sessions:new Set([ctx]),detached:new Map(),restoring:new Set(),
  context:{workspaceState:{get:()=>undefined,update:async()=>{}}},storageDir:()=>dir,workspaceDirs:()=>[workspace],
  localSnapshotExcludedPaths:()=>new Set(),reportSnapshotSkips:()=>{},config:()=>({get:(_key,fallback)=>fallback}),
  output:{appendLine:()=>{}},post:(_ctx,m)=>messages.push(m),speedMode:()=> 'default',rememberSessionSpeed:()=>{},
  refreshSessions:()=>{},renderSessions:()=>{},refreshChangedFiles:()=>{},maybeNotifyWaiting:()=>{},
 });
 store.fork=async(source,leaf)=>{
  forks.push({source,leaf});const original=store.threads.get(source).turns;
  const kept=original.slice(0,original.findIndex(turn=>turn.id===leaf)+1);
  store.threads.set('branch',{id:'branch',turns:structuredClone(kept)});return 'branch';
 };
 t.after(async()=>{ctx.checkpoints.flush();checkpoints.flush();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,workspace,file,first,turns,store,checkpoints,ctx,provider,messages,forks,id};
}
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
test('旧会话无文件快照时明确说明只回退对话，取消或不匹配不产生分支',async t=>{
 const f=await fixture(t);f.checkpoints.clear();
 choice=undefined;await f.provider.restoreCheckpoint(f.ctx,'turn:2',true);
 assert.deepEqual(f.forks,[]);assert.equal(await fs.readFile(f.file,'utf8'),'按旧答案修改后');
 choice='还原';await f.provider.restoreCheckpoint(f.ctx,'turn:2',true);
 assert.match(dialogs.at(-1)[1].detail,/没有可用的文件快照.*只回退对话/);
 assert.equal(await fs.readFile(f.file,'utf8'),'按旧答案修改后');
 assert.equal(f.messages.some(m=>m.kind==='permission_request'),true);
 const g=await fixture(t);g.turns[1].items=[user('普通消息')];
 await g.provider.restoreCheckpoint(g.ctx,g.id,true);
 assert.deepEqual(g.forks,[]);assert.match(g.messages.at(-1).message,/无法准确还原/);
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
