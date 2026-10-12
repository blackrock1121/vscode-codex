const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const vscode={workspace:{textDocuments:[]},Uri:{from:x=>x}};
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return vscode;return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
const {CheckpointManager}=require('../dist/test/checkpoints.js');
const {quotaEvents}=require('../dist/test/codex/events.js');

function providerFixture(){
 const provider=Object.create(ChatViewProvider.prototype),messages=[];
 Object.assign(provider,{
  output:{appendLine:()=>{}},context:{globalState:{get:()=>undefined}},
  sessions:new Set(),detached:new Map(),post:(_,event)=>messages.push(event),
  origChanged:{fire:()=>{}},broadcastRunning:()=>{},turnStallMs:()=>720000,
 });
 return {provider,messages};
}

async function checkpointFixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-audit-'));
 const checkpoints=new CheckpointManager(dir);checkpoints.setSession('test');
 t.after(()=>{checkpoints.flush();return fs.rm(dir,{recursive:true,force:true});});
 return {dir,checkpoints};
}

test('额度定时刷新不会掩盖超过十二分钟无进展的任务',()=>{
 const {provider,messages}=providerFixture();
 let disposed=false;
 const last=Date.now()-13*60000;
 const ctx={lastEventAt:last,sessionId:'stalled',proc:{isBusy:true,dispose:()=>{disposed=true;}}};
 provider.sessions.add(ctx);
 for(const event of quotaEvents({primary:{usedPercent:85,windowDurationMins:300}}))provider.handleEmitInner(ctx,event);
 assert.equal(ctx.lastEventAt,last);
 provider.checkTurnStall(ctx);
 assert.equal(disposed,true);
 assert.ok(messages.some(event=>event.kind==='error'&&event.message.includes('卡死')));
});

test('真实输出延长超时，等待用户审批不触发超时',()=>{
 const {provider}=providerFixture();
 const ctx={lastEventAt:Date.now()-13*60000,proc:{dispose:()=>assert.fail('不应超时')}};
 provider.sessions.add(ctx);
 provider.handleEmitInner(ctx,{kind:'text_delta',text:'仍在输出'});
 assert.ok(Date.now()-ctx.lastEventAt<1000);
 provider.checkTurnStall(ctx);
 ctx.lastEventAt=Date.now()-13*60000;ctx.pendingPerm={kind:'permission_request'};
 provider.checkTurnStall(ctx);
});

test('权限配置保存失败时不改变现有进程的权限',async()=>{
 const {provider,messages}=providerFixture();
 const ctx={};provider.sessions.add(ctx);
 provider.modeSeq=0;
 provider.config=()=>({get:(key,fallback)=>key==='permissionMode'?'default':fallback});
 provider.speedMode=()=> 'default';
 provider.updateConfig=async()=>false;
 const changes=[];provider.allProcs=()=>[{setPermissionMode:async mode=>changes.push(mode)}];
 await provider.setPermissionMode(ctx,'bypassPermissions');
 assert.deepEqual(changes,[]);
 assert.ok(messages.some(event=>event.kind==='config'&&event.permissionMode==='default'));
 assert.equal(messages.some(event=>event.kind==='config'&&event.permissionMode==='bypassPermissions'),false);
});

test('超过四十轮后还原最早保留点，不撤销更早轮次的文件改动',async t=>{
 const {dir,checkpoints}=await checkpointFixture(t);
 const earlier=path.join(dir,'earlier.txt'),later=path.join(dir,'later.txt');
 await fs.writeFile(earlier,'第一轮改动');
 checkpoints.beginTurn('第一轮',0);checkpoints.recordSnapshot(earlier,'最初内容');
 const second=checkpoints.beginTurn('第二轮',1);checkpoints.recordSnapshot(later,'第二轮之前');
 await fs.writeFile(later,'第二轮改动');
 for(let i=2;i<41;i++)checkpoints.beginTurn(`第 ${i+1} 轮`,i);
 assert.equal(checkpoints.list()[0].id,second);
 const result=checkpoints.restore(second);
 assert.equal(await fs.readFile(earlier,'utf8'),'第一轮改动');
 assert.equal(await fs.readFile(later,'utf8'),'第二轮之前');
 assert.equal(result.restoredFiles,1);
 assert.equal(checkpoints.originalOf(earlier),'最初内容');
});

test('还原写盘失败必须报告失败，并保留还原点供重试',async t=>{
 const {dir,checkpoints}=await checkpointFixture(t);
 const blocked=path.join(dir,'blocked.txt');await fs.mkdir(blocked);
 const id=checkpoints.beginTurn('待还原轮次',0);checkpoints.recordSnapshot(blocked,'原始内容');
 assert.throws(()=>checkpoints.restore(id),/blocked\.txt/);
 assert.equal(checkpoints.list()[0].id,id);
 const reloaded=new CheckpointManager(dir);reloaded.setSession('test');
 assert.equal(reloaded.list()[0].id,id);
 await fs.rmdir(blocked);
 assert.equal(checkpoints.restore(id).restoredFiles,1);
 assert.equal(await fs.readFile(blocked,'utf8'),'原始内容');
});

test('单文件回滚失败不会把备份当作已接受而删除',async t=>{
 const {provider,messages}=providerFixture();
 const {dir,checkpoints}=await checkpointFixture(t);
 const blocked=path.join(dir,'blocked.txt');await fs.mkdir(blocked);
 checkpoints.beginTurn('待回滚',0);checkpoints.recordSnapshot(blocked,'原始内容');
 provider.revertFile({checkpoints},blocked);
 assert.equal(checkpoints.originalOf(blocked),'原始内容');
 assert.ok(messages.some(event=>event.message?.includes('回滚失败')));
});

test('非终止错误保留进程忙碌状态，不误放行排队消息',()=>{
 const provider=Object.create(ChatViewProvider.prototype),messages=[];
 const ctx={proc:{isBusy:true},webview:{postMessage:event=>messages.push(event)}};
 provider.sessions=new Set([ctx]);
 provider.post(ctx,{kind:'error',message:'该模型不支持此速度'});
 assert.equal(messages[0].keepBusy,true);
 ctx.proc.isBusy=false;
 provider.post(ctx,{kind:'error',message:'发送准备失败'});
 assert.ok(!messages[1].keepBusy);
});

test('派生还原写盘失败时清理临时分支，原会话与备份保持可重试',async t=>{
 const {provider}=providerFixture();
 const {dir,checkpoints}=await checkpointFixture(t);
 checkpoints.beginTurn('第一轮',0);
 const id=checkpoints.beginTurn('第二轮',1);
 const blocked=path.join(dir,'blocked.txt');await fs.mkdir(blocked);
 checkpoints.recordSnapshot(blocked,'原始内容');checkpoints.flush();
 const originalFile=path.join(dir,'checkpoints-test.json');
 const before=await fs.readFile(originalFile,'utf8');
 const deleted=[];
 provider.speedMode=()=> 'default';provider.storageDir=()=>dir;
 provider.store={
  userTurnLines:()=>[{text:'第一轮',hasImages:false,line:1}],
  rewindLeafFor:()=> 'turn-1',fork:async()=> 'temporary-branch',
  delete:async id=>deleted.push(id),
 };
 const ctx={sessionId:'test',checkpoints};
 await assert.rejects(provider.forkRewind(ctx,id,1),/blocked\.txt/);
 assert.deepEqual(deleted,['temporary-branch']);
 assert.equal(ctx.sessionId,'test');
 assert.equal(await fs.readFile(originalFile,'utf8'),before);
 await assert.rejects(fs.access(path.join(dir,'checkpoints-temporary-branch.json')));
});
