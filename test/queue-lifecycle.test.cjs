const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const {JSDOM}=require('jsdom');
const {CodexProcess}=require('../dist/test/codex/process.js');
const {CheckpointManager}=require('../dist/test/checkpoints.js');
const originalLoad=Module._load;
Module._load=function(id,...args){return id==='vscode'?{workspace:{textDocuments:[]}}:originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;

async function until(check){
 const deadline=Date.now()+4000;
 while(!check()){
  if(Date.now()>deadline)assert.fail('等待会话事件超时');
  await new Promise(resolve=>setTimeout(resolve,5));
 }
}

// 连接实际界面、宿主与 CodexProcess，仅后台 RPC 使用本地测试进程。
async function fixture(t,env={}){
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'codex-queue-lifecycle-'));
 const source=fs.readFileSync('src/panel/chatViewProvider.ts','utf8');
 const raw=source.slice(source.indexOf('  private html(')).match(/return (?:\/\* html \*\/ )?`([\s\S]*?)`;\s*\n\s+}/)[1];
 const html=raw.replace(/\$\{[^}]+\}/g,'').replace(/<script[^>]*><\/script>/g,'');
 const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://webview.test/'});
 const w=dom.window,events=[],sent=[],errors=[],tasks=new Set();
 const provider=Object.create(ChatViewProvider.prototype);
 const checkpoints=new CheckpointManager(dir);checkpoints.setSession('thread-1');
 const ctx={sessionId:'thread-1',checkpoints,model:'',speedMode:'default',effort:'medium',ready:true};
 let lastQuestionTurn;
 Object.assign(provider,{
  sessions:new Set([ctx]),detached:new Map(),restoring:new Set(),forking:new Set(),
  output:{appendLine:()=>{}},context:{globalState:{get:()=>undefined}},
  config:()=>({get:(key,fallback)=>['autosave','snapshotFilesForRestore'].includes(key)?false:fallback}),
  store:{hydrate:async()=>{},countLines:()=>1,rewindLeafFor:()=>lastQuestionTurn},
  notificationVersion:()=>0,clearSessionNotification:()=>{},maybeNotifyWaiting:()=>{},maybeNotifyTurnDone:()=>{},
  refreshSessions:()=>{},refreshChangedFiles:()=>{},fetchUsage:()=>{},
 });
 ctx.webview={postMessage:event=>{
  events.push(event);
  w.dispatchEvent(new w.MessageEvent('message',{data:event}));
 }};
 w.acquireVsCodeApi=()=>({getState:()=>({}),setState:()=>{},postMessage:message=>{
  sent.push(message);
  if(!['send','interrupt','answerQuestion','draft'].includes(message.type))return;
  const task=Promise.resolve().then(()=>provider.onPanelMessage(ctx,message));
  tasks.add(task);task.finally(()=>tasks.delete(task));
 }});
 w.ResizeObserver=class{observe(){}disconnect(){}};
 w.IntersectionObserver=class{observe(){}disconnect(){}};
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.HTMLElement.prototype.scrollTo=function(){};
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 w.document.queryCommandSupported=()=>false;
 w.addEventListener('error',event=>errors.push(event.message));
 w.eval(fs.readFileSync('media/webview.js','utf8'));
 const proc=new CodexProcess({codexPath:path.resolve('test/fake-codex.cjs'),cwd:dir,permissionMode:'default',transportDiagnostics:false,env}, {
  emit:event=>provider.handleEmit(ctx,event),
  onPermission:request=>{lastQuestionTurn=proc.pausedQuestion?.turnId;provider.onPermission(ctx,request);},
  onSessionId:()=>{},onClose:code=>provider.onProcessClose(ctx,code,proc),
 });
 ctx.proc=proc;
 t.after(async()=>{await proc.disposeAndWait();await Promise.allSettled([...tasks]);dom.window.close();checkpoints.flush();await fsp.rm(dir,{recursive:true,force:true});});
 await proc.start();
 const input=w.document.getElementById('input');
 const send=text=>{input.value=text;w.document.getElementById('btn-send').click();};
 const stop=()=>w.document.getElementById('btn-stop').click();
 const idle=()=>!proc.isBusy&&w.document.getElementById('btn-stop').classList.contains('hidden');
 const answer=()=>{w.document.querySelector('.askp-opt').click();w.document.querySelector('.askp-submit').click();};
 return {w,provider,ctx,proc,events,sent,errors,tasks,send,stop,idle,answer};
}

for(const scenario of ['普通回复','AskUserQuestion 回答后','原生异步问题回答后','等待问题答案']){
 test(`${scenario}停止：确认前不执行队列，确认后继续排队与新发消息`,async t=>{
  const f=await fixture(t,{TEST_HOLD_REPLY:'1',TEST_INTERRUPT_DELAY:'80'});
  f.send(scenario==='普通回复'?'wait':scenario==='原生异步问题回答后'?'async-question':'dynamic-question');
  if(scenario==='普通回复')await until(()=>!!f.proc.turnId);
  else{
   await until(()=>!!f.w.document.querySelector('.askp-submit'));
   if(scenario!=='等待问题答案'){
    f.answer();await until(()=>!f.proc.pausedQuestion&&!!f.proc.turnId);
   }
  }
  f.send('wait');f.stop();f.send('排队第二条');
  assert.equal(f.sent.filter(m=>m.type==='send').length,1);
  await until(()=>f.sent.filter(m=>m.type==='send').length===2&&f.proc.isBusy&&!!f.proc.turnId);
  assert.equal(f.w.document.querySelectorAll('.tq-row').length,1);
  f.stop();
  await until(()=>f.events.filter(e=>e.kind==='result').length===3&&f.idle());
  assert.deepEqual(f.sent.filter(m=>m.type==='send').map(m=>m.text),[
   scenario==='普通回复'?'wait':scenario==='原生异步问题回答后'?'async-question':'dynamic-question','wait','排队第二条',
  ]);
  f.send('停止后的新消息');await until(()=>f.events.filter(e=>e.kind==='result').length===4&&f.idle());
  assert.equal(f.w.document.querySelectorAll('.tq-row').length,0);
  assert.equal(f.ctx.pendingPerm,undefined);
  assert.deepEqual(f.errors,[]);
  assert.equal(f.events.some(e=>e.kind==='error'),false);
 });
}

for(const question of ['', 'dynamic-question', 'async-question']){
 test(`${question||'普通回复'}正常结束：已有队列继续执行，新消息也可直接发送`,async t=>{
  const f=await fixture(t);
  f.send(question||'第一条消息');
  if(question)await until(()=>!!f.w.document.querySelector('.askp-submit'));
  f.send('排队消息');
  assert.equal(f.sent.filter(m=>m.type==='send').length,1);
  if(question)f.answer();
  await until(()=>f.events.filter(e=>e.kind==='result').length===2&&f.idle());
  f.send('完成后的新消息');await until(()=>f.events.filter(e=>e.kind==='result').length===3&&f.idle());
  assert.deepEqual(f.sent.filter(m=>m.type==='send').map(m=>m.text),[question||'第一条消息','排队消息','完成后的新消息']);
  assert.equal(f.w.document.querySelectorAll('.tq-row').length,0);
  assert.equal(f.ctx.pendingPerm,undefined);
  assert.deepEqual(f.errors,[]);
  assert.equal(f.events.some(e=>e.kind==='error'),false);
 });
}

test('答案提交准备时停止：取消答案，下一条消息不被待答状态拦住',async t=>{
 const f=await fixture(t,{TEST_HOLD_REPLY:'1'});
 f.send('dynamic-question');await until(()=>!!f.w.document.querySelector('.askp-submit'));
 let release;
 f.provider.store.hydrate=()=>release?Promise.resolve():new Promise(resolve=>{release=resolve;});
 f.answer();await until(()=>!!release);
 f.stop();await until(f.idle);
 release();await until(()=>!f.ctx.answeringQuestion);
 f.provider.store.hydrate=async()=>{};
 f.send('停止提交后继续');await until(()=>f.events.filter(e=>e.kind==='result').length===2&&f.idle());
 assert.equal(f.ctx.pendingPerm,undefined);
 assert.equal(f.w.document.querySelectorAll('.tq-row').length,0);
 assert.deepEqual(f.errors,[]);
});

for(const question of [false,true]){
 test(`${question?'回答问题后':'普通回复'}停止：宿主空闲时清除界面遗留的还原锁`,async t=>{
  const f=await fixture(t,{TEST_HOLD_REPLY:'1'});
  f.send(question?'dynamic-question':'wait');
  if(question){
   await until(()=>!!f.w.document.querySelector('.askp-submit'));
   f.answer();await until(()=>!f.proc.pausedQuestion&&!!f.proc.turnId);
  }else await until(()=>!!f.proc.turnId);
  // 模拟此前流程遗留的界面状态；本次回复和宿主均未执行还原。
  f.ctx.webview.postMessage({kind:'restoring'});
  f.stop();await until(f.idle);
  f.send('停止后继续');
  await until(()=>f.events.filter(e=>e.kind==='result').length===2&&f.idle());
  assert.equal(f.w.document.querySelectorAll('.tq-row').length,0);
  assert.equal(f.w.document.querySelector('.restore-overlay'),null);
  assert.deepEqual(f.errors,[]);
 });
}

test('真正还原期间停止不能误清还原锁，完成后才继续队列',async t=>{
 const f=await fixture(t);
 f.send('wait');await until(()=>!!f.proc.turnId);
 f.provider.restoring.add(f.ctx);f.ctx.webview.postMessage({kind:'restoring'});
 f.stop();await until(f.idle);f.send('还原完成后继续');
 await new Promise(resolve=>setTimeout(resolve,180));
 assert.equal(f.sent.filter(m=>m.type==='send').length,1);
 assert.ok(f.w.document.querySelector('.restore-overlay'));
 f.provider.restoring.delete(f.ctx);
 f.ctx.webview.postMessage({kind:'load_history',items:[],checkpoints:[]});
 await until(()=>f.events.filter(e=>e.kind==='result').length===2&&f.idle());
 assert.equal(f.w.document.querySelectorAll('.tq-row').length,0);
 assert.deepEqual(f.errors,[]);
});
