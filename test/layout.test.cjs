const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');

const commands=[];
let createPanel;
const vscode={
 Uri:{joinPath:(base,...parts)=>path.join(base,...parts)},
 ViewColumn:{One:1,Two:2,Beside:-2},
 window:{createWebviewPanel:(...args)=>createPanel(...args)},
 commands:{executeCommand:async command=>commands.push(command)},
};
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return vscode;return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
const {sessionTabTitle}=require('../dist/test/codex/session.js');

test('长标签限制显示宽度，保留完整会话名和完整表情',()=>{
 const title='现在是的飞书通知点击是跳转到了飞书的页面';
 const list=[{id:'long',title}];
 const provider=Object.create(ChatViewProvider.prototype);
 const ctx={sessionId:'long',panel:{}};
 provider.setPanelTitle(ctx,list);
 assert.equal(ctx.panel.title,'现在是的飞书通知点击是…');
 assert.equal(list[0].title,title);
 assert.equal(sessionTabTitle('  短标题  '),'短标题');
 assert.equal(sessionTabTitle(''),'Codex Copilot');
 assert.equal(sessionTabTitle('a'.repeat(25)),'a'.repeat(22)+'…');
 assert.equal(sessionTabTitle('👨‍👩‍👧‍👦'.repeat(13)),'👨‍👩‍👧‍👦'.repeat(11)+'…');
});

test('固定关闭入口只关闭当前聚焦会话，不误关后台会话或删除历史',async t=>{
 const provider=await fixture(t),closed=[];
 const background={sessionId:'background',panel:{active:false,dispose:()=>closed.push('background')}};
 const current={sessionId:'current',panel:{active:true,dispose:()=>closed.push('current')}};
 provider.sessions=new Set([background,current]);
 provider.activeCtx=background;
 provider.store.delete=()=>assert.fail('关闭标签不能删除会话历史');
 provider.closeActiveSession();
 assert.deepEqual(closed,['current']);
 current.panel.active=false;
 provider.closeActiveSession();
 assert.deepEqual(closed,['current']);
});

async function fixture(t){
 commands.length=0;
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-layout-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const provider=Object.create(ChatViewProvider.prototype);
 Object.assign(provider,{
  sessions:new Set(),detached:new Map(),
  context:{extensionUri:dir},output:{appendLine:()=>{}},
  store:{hydrate:async()=>{},findFile:id=>id},
  storageDir:()=>dir,speedMode:()=> 'default',html:()=> '<html>会话</html>',postActiveFile:()=>{},
 });
 return provider;
}

function panel(column,active,visible=true){
 return {
  viewColumn:column,active,visible,reveals:[],
  webview:{onDidReceiveMessage(listener){this.receive=listener;}},onDidDispose:()=>{},
  onDidChangeViewState(listener){this.changeState=listener;},
  reveal(column,preserveFocus){
   this.reveals.push({column,preserveFocus});
   this.active=!preserveFocus;
  },
 };
}

test('并发恢复分屏会话时不移动标签、不重设分组、不抢焦点',async t=>{
 const provider=await fixture(t);
 // VS Code 反序列化初始列可能仍是内部的 0 起始编号；恢复后才正常化。
 const left=panel(0,true),right=panel(1,false);
 let finishRight;
 provider.store.hydrate=id=>id==='right'?new Promise(resolve=>{finishRight=resolve;}):Promise.resolve();
 const restoringRight=provider.revivePanel(right,'right');
 await provider.revivePanel(left,'left');
 finishRight();
 await restoringRight;
 assert.deepEqual(left.reveals,[]);
 assert.deepEqual(right.reveals,[]);
 assert.deepEqual(commands,[]);
 assert.equal(provider.activeCtx.panel,left);
 assert.deepEqual([...provider.sessions].map(ctx=>ctx.sessionId).sort(),['left','right']);
 assert.equal(left.webview.html,'<html>会话</html>');
 assert.equal(right.webview.html,'<html>会话</html>');
});

test('隐藏标签和未确定列号的空白会话恢复时保持原有布局与焦点',async t=>{
 const provider=await fixture(t);
 const active=panel(2,true);
 await provider.revivePanel(active,'active');
 const hidden=panel(undefined,false,false);
 await provider.revivePanel(hidden);
 assert.deepEqual(hidden.reveals,[]);
 assert.equal(hidden.active,false);
 assert.equal(provider.activeCtx.panel,active);
 assert.equal(provider.sessions.size,2);
 assert.equal(hidden.webview.html,'<html>会话</html>');
});

test('新建会话仍在旁边打开并锁定分组',async t=>{
 const provider=await fixture(t);
 const fresh=panel(3,true);
 const opened=[];
 createPanel=(...args)=>{opened.push(args);return fresh;};
 await provider.newSession();
 assert.deepEqual(opened[0][2],{viewColumn:vscode.ViewColumn.Beside,preserveFocus:false});
 assert.deepEqual(commands,['workbench.action.lockEditorGroup']);
 assert.equal(provider.activeCtx.panel,fresh);
 assert.equal(provider.sessions.size,1);
});

test('后台心跳不改变停止命令的目标，点击会话标签即可切换目标',async t=>{
 const provider=await fixture(t);
 const left=panel(1,true),right=panel(2,false);
 await provider.revivePanel(left,'left');
 await provider.revivePanel(right,'right');
 provider.activeCtx=[...provider.sessions].find(ctx=>ctx.panel===left);
 right.webview.receive({type:'pong',id:1});
 const stopped=[];
 provider.stopContext=async ctx=>stopped.push(ctx.sessionId);
 await provider.stop();
 assert.deepEqual(stopped,['left']);
 left.active=false;right.active=true;
 right.changeState({webviewPanel:right});
 left.webview.receive({type:'pong',id:2});
 await provider.stop();
 assert.deepEqual(stopped,['left','right']);
});

test('重载空白标签不会自动绑定到上一个会话',async t=>{
 const provider=await fixture(t);
 provider.context.workspaceState={get:()=> 'old-session'};
 provider.post=()=>{};provider.refreshChangedFiles=()=>{};
 provider.loadSessionInto=()=>assert.fail('空白标签不应读取旧历史');
 const blank=panel(1,true);
 await provider.revivePanel(blank);
 provider.loadCtxSession(provider.activeCtx);
 assert.equal(provider.activeCtx.sessionId,undefined);
});
