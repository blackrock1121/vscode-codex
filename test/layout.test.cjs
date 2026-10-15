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
 window:{tabGroups:{all:[]},createWebviewPanel:(...args)=>createPanel(...args)},
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
 vscode.window.tabGroups.all=[{viewColumn:1,tabs:['文件']}];
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-layout-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const provider=Object.create(ChatViewProvider.prototype);
 Object.assign(provider,{
  sessions:new Set(),detached:new Map(),
  context:{extensionUri:dir,workspaceState:{get:()=>undefined}},output:{appendLine:()=>{}},
  config:()=>({get:(_key,fallback)=>fallback}),
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

// 模拟 VS Code：Beside 在活动组后插入；数值列已存在则复用，不存在则在末尾建组。
function editorGroups(names,activeColumn,{sync=true}={}){
 const groups=names.map((name,index)=>({viewColumn:index+1,tabs:name===null?[]:[name]}));
 const opened=[];
 const publish=()=>{vscode.window.tabGroups.all=groups.map(group=>({...group}));};
 publish();
 createPanel=(_type,_title,options)=>{
  let group;
  if(groups.length===1&&!groups[0].tabs.length){
   group=groups[0];
  }else if(options.viewColumn===vscode.ViewColumn.Beside){
   group={tabs:[]};
   groups.splice(activeColumn,0,group);
  }else{
   group=groups[options.viewColumn-1];
   if(!group){group={tabs:[]};groups.push(group);}
  }
  groups.forEach((entry,index)=>{entry.viewColumn=index+1;});
  opened.forEach(entry=>{entry.panel.active=false;entry.panel.viewColumn=entry.group.viewColumn;});
  const fresh=panel(options.viewColumn===vscode.ViewColumn.Beside?undefined:options.viewColumn,!options.preserveFocus);
  group.tabs.push(`新会话${opened.length+1}`);
  opened.push({panel:fresh,group});
  activeColumn=group.viewColumn;
  if(sync)publish();
  return fresh;
 };
 return {opened,contents:()=>groups.map(group=>group.tabs)};
}

test('从左右任一会话新建都追加到最右侧并锁定新组',async t=>{
 for(const activeColumn of [1,2]){
  const provider=await fixture(t);
  const layout=editorGroups(['会话A','会话B'],activeColumn);
  await provider.newSession();
  assert.deepEqual(layout.contents(),[['会话A'],['会话B'],['新会话1']]);
  assert.deepEqual(commands,['workbench.action.lockEditorGroup']);
  assert.equal(provider.activeCtx.panel,layout.opened[0].panel);
  assert.equal(provider.activeCtx.panel.active,true);
  assert.equal(provider.sessions.size,1);
 }
});

test('空窗口首个会话复用空组，连续新建时再追加右侧独立分组',async t=>{
 const provider=await fixture(t);
 const layout=editorGroups([null],1,{sync:false});
 await Promise.all([provider.newSession(),provider.newSession()]);
 assert.deepEqual(layout.contents(),[['新会话1'],['新会话2']]);
 assert.deepEqual(layout.opened.map(entry=>entry.panel.viewColumn),[1,2]);
 assert.deepEqual(layout.opened[0].panel.reveals,[{column:1,preserveFocus:false}]);
 assert.equal(provider.sessions.size,2);
});

test('右侧有文件组和空组时，新会话追加在所有组之后',async t=>{
 const provider=await fixture(t);
 const layout=editorGroups(['文件A','会话A','文件B',null],2);
 await provider.newSession();
 assert.deepEqual(layout.contents(),[['文件A'],['会话A'],['文件B'],[],['新会话1']]);
 assert.equal(layout.opened[0].panel.viewColumn,5);
});

test('分组信息尚未同步时连续新建，仍各自追加独立分组',async t=>{
 const provider=await fixture(t);
 const layout=editorGroups(['会话A','会话B'],1,{sync:false});
 await Promise.all([provider.newSession(),provider.newSession()]);
 assert.deepEqual(layout.contents(),[['会话A'],['会话B'],['新会话1'],['新会话2']]);
 assert.equal(provider.sessions.size,2);
 assert.equal(provider.activeCtx.panel,layout.opened[1].panel);
});

test('重开后台会话也追加在最右侧并沿用原进程',async t=>{
 const provider=await fixture(t);
 const proc={isExited:false};
 const detached={sessionId:'background',panel:panel(undefined,false,false),proc,ready:true};
 provider.detached.set('background',detached);
 const layout=editorGroups(['会话A','会话B'],1);
 await provider.openSession('background');
 assert.deepEqual(layout.contents(),[['会话A'],['会话B'],['新会话1']]);
 assert.equal(provider.activeCtx,detached);
 assert.equal(detached.proc,proc);
 assert.equal(provider.detached.size,0);
 assert.deepEqual(commands,['workbench.action.lockEditorGroup']);
});

test('再次打开已存在会话只聚焦原位置，不在最右侧重复新建',async t=>{
 const provider=await fixture(t);
 const existing={sessionId:'existing',panel:panel(1,false)};
 provider.sessions.add(existing);
 createPanel=()=>assert.fail('已打开的会话不能重复创建面板');
 await provider.openSession('existing');
 assert.deepEqual(existing.panel.reveals,[{column:1,preserveFocus:false},{column:1,preserveFocus:false}]);
 assert.equal(provider.activeCtx,existing);
});

test('已有九个分组时，新会话仍在末尾创建独立分组',async t=>{
 const provider=await fixture(t);
 const names=Array.from({length:9},(_,index)=>`会话${index+1}`);
 const layout=editorGroups(names,1);
 await provider.newSession();
 assert.deepEqual(layout.contents(),[...names.map(name=>[name]),['新会话1']]);
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

test('聊天面板诊断消息执行报告命令并回执原面板，不结束运行中的任务',async t=>{
 const received=[],provider=Object.create(ChatViewProvider.prototype);
 const ctx={sessionId:'running',draft:'草稿',proc:{isBusy:true},webview:{postMessage:m=>received.push(m)}};
 Object.assign(provider,{sessions:new Set([ctx]),output:{appendLine:()=>{}}});
 const original=vscode.commands.executeCommand;let called;
 vscode.commands.executeCommand=async command=>{called=command;};t.after(()=>vscode.commands.executeCommand=original);
 await provider.onPanelMessage(ctx,{type:'performanceReport',requestId:'diagnostic-1'});
 assert.equal(called,'codex-chat.performanceReport');
 assert.deepEqual(received,[{kind:'performance_report_result',requestId:'diagnostic-1',ok:true,message:'诊断报告已在编辑器中打开'}]);
 assert.equal(ctx.proc.isBusy,true);assert.equal(ctx.draft,'草稿');
});

test('聊天面板报告打开失败返回可见失败回执，兼容不带请求 ID 的旧面板',async t=>{
 const received=[],logs=[],provider=Object.create(ChatViewProvider.prototype);
 const ctx={webview:{postMessage:m=>received.push(m)},proc:{isBusy:true}};
 Object.assign(provider,{sessions:new Set([ctx]),output:{appendLine:line=>logs.push(line)}});
 const original=vscode.commands.executeCommand;
 vscode.commands.executeCommand=async()=>{throw new Error('模拟报告失败');};t.after(()=>vscode.commands.executeCommand=original);
 await provider.onPanelMessage(ctx,{type:'performanceReport'});
 assert.equal(received.length,1);assert.equal(received[0].kind,'performance_report_result');assert.equal(received[0].ok,false);
 assert.match(received[0].message,/打开失败/);assert.equal(ctx.proc.isBusy,true);assert.match(logs[0],/performanceReport/);
});
