const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const vscode={workspace:{textDocuments:[],asRelativePath:p=>p},Uri:{from:x=>x},window:{showInformationMessage:()=>{}}};
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return vscode;return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
const {CheckpointManager}=require('../dist/test/checkpoints.js');
const {quotaEvents}=require('../dist/test/codex/events.js');
const {WorkspaceSnapshot}=require('../dist/test/snapshot.js');

test('快照只覆盖已打开的工作区目录，默认工作目录不自动加入；多根目录仍可回滚',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-workspace-scope-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const roots=[path.join(dir,'first'),path.join(dir,'second')],outside=path.join(dir,'outside.txt');
 for(const root of roots){await fs.mkdir(root);await fs.writeFile(path.join(root,'source.txt'),'原文');}
 await fs.writeFile(outside,'工作区外原文');
 const previous=vscode.workspace.workspaceFolders;
 vscode.workspace.workspaceFolders=roots.map(fsPath=>({uri:{fsPath}}));
 t.after(()=>{vscode.workspace.workspaceFolders=previous;});
 const provider=Object.create(ChatViewProvider.prototype);
 provider.cwd=()=>dir;
 const snapshot=new WorkspaceSnapshot(provider.workspaceDirs());
 await snapshot.capture();
 assert.deepEqual([...snapshot.files.keys()].sort(),roots.map(root=>path.join(root,'source.txt')).sort());
 for(const root of roots)await fs.writeFile(path.join(root,'source.txt'),'修改');
 await fs.writeFile(outside,'工作区外修改');
 const cp=new CheckpointManager(path.join(dir,'state'));cp.setSession('scope');
 const id=cp.beginTurn('修改',0,true);
 for(const [file,original]of await snapshot.changed())cp.recordSnapshot(file,original);
 cp.completeSnapshot();
 assert.equal(cp.restore(id).restoredFiles,2);
 for(const root of roots)assert.equal(await fs.readFile(path.join(root,'source.txt'),'utf8'),'原文');
 assert.equal(await fs.readFile(outside,'utf8'),'工作区外修改');
 cp.flush();
});

test('手动压缩准备日志覆盖连接复用和失败，准备期间关闭或忙碌不会触发压缩',async()=>{
 for(const mode of ['reuse','cold','failed','closed','busy']){
  const provider=Object.create(ChatViewProvider.prototype),logs=[];
  let alive=true,calls=0;
  const proc={isExited:false,isBusy:false,compact:()=>{calls++;}};
  const ctx={sessionId:'test-session',proc:mode==='reuse'?proc:undefined};
  Object.assign(provider,{
   forking:new Set(),restoring:new Set(),output:{appendLine:x=>logs.push(x)},alive:()=>alive,post:()=>{},
   ensureProcess:async()=>{
    if(mode==='closed')alive=false;
    if(mode==='busy')proc.isBusy=true;
    ctx.proc=mode==='failed'?undefined:proc;
    return ctx.proc;
   },
  });
  const previous=vscode.window.showErrorMessage;
  vscode.window.showErrorMessage=()=>{};
  try{await provider.compactSession(ctx);}finally{vscode.window.showErrorMessage=previous;}
  const data=logs.map(x=>JSON.parse(x.split('[compaction_prepare] ')[1]));
  assert.deepEqual(data.map(x=>x.stage),['start','end']);
  assert.equal(data[0].reusedProcess,mode==='reuse');
  assert.equal(data[1].outcome,mode==='failed'?'failed':'ready');
  assert.ok(data[1].elapsedMs>=0);
  assert.equal(calls,['reuse','cold'].includes(mode)?1:0);
 }
});

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

function exclusionFixture(roots){
 const {provider,messages}=providerFixture(),state=new Map();
 provider.context.workspaceState={get:(key,fallback)=>state.get(key)??fallback,update:async(key,value)=>{
  await Promise.resolve();
  if(value===undefined)state.delete(key);else state.set(key,JSON.parse(JSON.stringify(value)));
 }};
 provider.snapshotWarningPaths=new Map([[roots.join('\0'),new Set()]]);
 provider.snapshotWarningSignatures=new Map();
 provider.snapshotExclusionUpdate=Promise.resolve();
 provider.workspaceDirs=()=>roots;
 return {provider,messages,state,warned:provider.snapshotWarningPaths.get(roots.join('\0'))};
}
test('常规快照跳过只记录原因，换项目不再要求点击排除，也不自动保存排除规则',()=>{
 for(const root of ['/project-a','/project-b']){
  const {provider,messages,state}=exclusionFixture([root]),logs=[];
  provider.output.appendLine=line=>logs.push(line);
  const snapshot={skipReasons:new Map([[root+'/icon.png','binary'],[root+'/big.json','large'],[root+'/linked','symlink']])};
  provider.reportSnapshotSkips({},snapshot);provider.reportSnapshotSkips({},snapshot);
  assert.deepEqual(messages,[]);assert.equal(state.size,0);assert.equal(logs.length,1);
  assert.match(logs[0],/二进制/);assert.match(logs[0],/超过 2 MB/);assert.match(logs[0],/符号链接/);
 }
});
test('读取失败或扫描上限简短提醒，常规跳过清单变化不重复提醒同一个问题',()=>{
 const {provider,messages}=exclusionFixture(['/project']);
 const snapshot={skipReasons:new Map([['/project/unreadable','unreadable'],['/project/capped','limit']])};
 provider.reportSnapshotSkips({},snapshot);
 snapshot.skipReasons.set('/project/image.png','binary');provider.reportSnapshotSkips({},snapshot);
 assert.equal(messages.length,1);assert.equal(messages[0].kind,'notice');
 assert.match(messages[0].message,/无法读取 1 项，扫描或容量上限 1 项/);
 assert.match(messages[0].message,/聊天可继续/);
 assert.equal(messages[0].message.includes('点击排除'),false);
 assert.equal(messages.some(m=>m.kind==='snapshot_skips'),false);
 snapshot.skipReasons.clear();provider.reportSnapshotSkips({},snapshot);
 snapshot.skipReasons.set('/project/unreadable','unreadable');provider.reportSnapshotSkips({},snapshot);
 assert.equal(messages.length,2,'问题消失后再次出现仍需提醒');
});
test('大量快照跳过先汇总原因并限制示例数量，真实问题不被日志截断',()=>{
 const {provider,messages}=exclusionFixture(['/project']),logs=[];
 provider.output.appendLine=line=>logs.push(line);
 const skipReasons=new Map(Array.from({length:7000},(_,i)=>[`/project/${'x'.repeat(200)}/${i}.bin`,'binary']));
 skipReasons.set('/project/zzz-unreadable','unreadable');
 provider.reportSnapshotSkips({}, {skipReasons});
 assert.equal(messages.length,1);
 assert.ok(logs.every(line=>line.length<32768));
 assert.match(logs[0],/二进制 7000/);
 assert.match(logs[0],/无法读取 1/);
 assert.ok(logs.some(line=>line.includes('zzz-unreadable')));
});
test('系统元数据及已排除路径不占文件名额，不把恰好达到上限误报成扫描不完整',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-snapshot-cap-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'a.txt'),'源码');await fs.writeFile(path.join(root,'z.log'),'排除');
 await fs.mkdir(path.join(root,'node_modules'));
 for(const file of ['.DS_Store','Thumbs.db','desktop.ini'])await fs.writeFile(path.join(root,file),Buffer.from([0,1,2]));
 const snapshot=new WorkspaceSnapshot([root],1,['*.log']);await snapshot.capture();
 assert.deepEqual([...snapshot.files.keys()],[path.join(root,'a.txt')]);assert.equal(snapshot.skipped.size,0);
 await fs.writeFile(path.join(root,'a.txt'),'修改');const changes=await snapshot.changed();
 assert.equal(changes.get(path.join(root,'a.txt')),'源码');assert.equal(snapshot.unrestorableChanges.size,0);
 await fs.writeFile(path.join(root,'b.txt'),'第二个文件');
 const overflow=new WorkspaceSnapshot([root],1,['*.log']);await overflow.capture();
 assert.ok([...overflow.skipReasons.values()].includes('limit'));
});

test('排除按钮只保存本机记录，并发选择不会覆盖，重载后按工作区根目录隔离',async()=>{
 const {provider,messages,state,warned}=exclusionFixture(['/project','/project/nested']);
 warned.add('/project/a.bin');warned.add('/project/nested/b.bin');
 await Promise.all([
  provider.excludeSnapshotPaths({},['/project/a.bin']),
  provider.excludeSnapshotPaths({},['/project/nested/b.bin']),
 ]);
 assert.equal(messages.filter(e=>e.kind==='snapshot_exclude_result'&&e.ok).length,2);
 assert.deepEqual([...provider.localSnapshotExcludedPaths(['/project'])],['/project/a.bin']);
 const reloaded=exclusionFixture(['/project/nested']).provider;
 reloaded.context.workspaceState.get=(key,fallback)=>state.get(key)??fallback;
 assert.deepEqual([...reloaded.localSnapshotExcludedPaths(['/project/nested'])],['/project/nested/b.bin']);
 assert.deepEqual([...reloaded.localSnapshotExcludedPaths(['/unrelated'])],[]);
});

test('本机排除不会生成项目配置，文件名通配符按字面匹配并兼容手动规则',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-local-excludes-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'a?.txt'),'选中路径');
 await fs.writeFile(path.join(root,'ab.txt'),'应保留');
 await fs.writeFile(path.join(root,'debug.log'),'手动排除');
 const {provider,warned}=exclusionFixture([root]);warned.add(path.join(root,'a?.txt'));
 await provider.excludeSnapshotPaths({},undefined,true);
 const snapshot=new WorkspaceSnapshot([root],20000,['*.log'],provider.localSnapshotExcludedPaths([root]));
 await snapshot.capture();
 assert.deepEqual([...snapshot.files.keys()],[path.join(root,'ab.txt')]);
 await assert.rejects(fs.access(path.join(root,'.vscode/settings.json')));
 assert.equal((await snapshot.changed()).size,0);
});

test('本机排除保存失败不伪报成功，下一次可重试，过期或伪造路径不写入',async()=>{
 const {provider,messages,warned,state}=exclusionFixture(['/project']);warned.add('/project/a.bin');
 const update=provider.context.workspaceState.update;
 provider.context.workspaceState.update=async()=>{throw new Error('保存失败');};
 await provider.excludeSnapshotPaths({},['/project/a.bin']);
 assert.equal(messages.at(-1).ok,false);assert.equal(state.size,0);
 provider.context.workspaceState.update=update;
 await provider.excludeSnapshotPaths({},['/outside/b.bin']);
 assert.equal(messages.at(-1).ok,false);assert.equal(state.size,0);
 await provider.excludeSnapshotPaths({},['/project/a.bin']);
 assert.equal(messages.at(-1).ok,true);
});

test('清除本机排除后下一轮恢复扫描，不改动已有设置文件',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-reset-excludes-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.vscode'));
 const settings=path.join(root,'.vscode/settings.json'),original='{"codexChat.snapshotExclude":["*.log"],"editor.tabSize":2}';
 await fs.writeFile(settings,original);await fs.writeFile(path.join(root,'a.txt'),'正文');
 const {provider,warned}=exclusionFixture([root]);warned.add(path.join(root,'a.txt'));
 await provider.excludeSnapshotPaths({},undefined,true);
 await provider.resetLocalSnapshotExcludes();
 assert.equal(provider.localSnapshotExcludedPaths([root]).size,0);
 assert.equal(await fs.readFile(settings,'utf8'),original);
 const snapshot=new WorkspaceSnapshot([root]);await snapshot.capture();
 assert.equal(snapshot.files.get(path.join(root,'a.txt')),'正文');
});

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
 assert.ok(messages.some(event=>event.kind==='error'&&event.message.includes('达到配置的静默超时')&&event.message.includes('不一定代表任务卡死')));
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

test('静默三十秒后提示等待，诊断和重试不刷新超时，真实进展清除提示',()=>{
 const {provider,messages}=providerFixture();
 const last=Date.now()-75000;
 const ctx={lastEventAt:last,proc:{dispose:()=>assert.fail('短暂等待不能中断请求')}};
 provider.sessions.add(ctx);
 provider.checkTurnStall(ctx);
 assert.ok(messages.some(e=>e.kind==='response_wait'&&e.idleMs>=75000));
 for(const event of [{kind:'diag',message:'[rpc] account/read 2ms'},
  {kind:'status',label:'Codex 正在重试请求…'},
  {kind:'usage',weekPct:20}]) provider.handleEmitInner(ctx,event);
 assert.equal(ctx.lastEventAt,last);
 provider.handleEmitInner(ctx,{kind:'compacting'});
 assert.ok(Date.now()-ctx.lastEventAt<1000);
 assert.ok(messages.some(e=>e.kind==='response_wait'&&e.idleMs===0));
 messages.length=0;
 ctx.lastEventAt=Date.now()-20000;provider.checkTurnStall(ctx);
 ctx.lastEventAt=last;ctx.pendingPerm={kind:'permission_request'};provider.checkTurnStall(ctx);
 assert.equal(messages.length,0);
});

test('压缩静默不警告或断开，完成后从新时间点恢复检测',()=>{
 for(const trigger of ['manual','auto']){
  const {provider,messages}=providerFixture();
  let disposed=false;
  const ctx={lastEventAt:Date.now()-75000,proc:{dispose:()=>{disposed=true;}}};
  provider.sessions.add(ctx);
  provider.checkTurnStall(ctx);
  provider.handleEmitInner(ctx,{kind:'compacting'});
  assert.ok(messages.some(e=>e.kind==='response_wait'&&e.idleMs===0));
  messages.length=0;
  for(const idle of [45000,13*60000]){
   ctx.lastEventAt=Date.now()-idle;
   provider.checkTurnStall(ctx);
  }
  assert.equal(disposed,false);
  assert.deepEqual(messages,[]);
  provider.handleEmitInner(ctx,{kind:'compacted',trigger,preTokens:0,postTokens:0});
  assert.ok(Date.now()-ctx.lastEventAt<1000,'不能把压缩用时计入普通静默超时');
  messages.length=0;provider.checkTurnStall(ctx);
  assert.deepEqual(messages,[]);
  ctx.lastEventAt=Date.now()-45000;provider.checkTurnStall(ctx);
  assert.ok(messages.some(e=>e.kind==='response_wait'&&e.idleMs>=45000));
  ctx.lastEventAt=Date.now()-13*60000;provider.checkTurnStall(ctx);
  assert.equal(disposed,true,'自动压缩结束后仍能检测后续响应超时');
 }
});

test('压缩失败、停止或重连后不残留免超时状态，非致命错误保持压缩状态',()=>{
 for(const event of [{kind:'error',message:'压缩失败'},{kind:'busy',busy:false},{kind:'busy',busy:true}]){
  const {provider,messages}=providerFixture();
  const ctx={lastEventAt:Date.now(),proc:{dispose:()=>assert.fail('短暂静默不能断开')}};
  provider.sessions.add(ctx);
  provider.handleEmitInner(ctx,{kind:'compacting'});
  provider.handleEmitInner(ctx,{kind:'error',message:'设置失败',keepBusy:true});
  ctx.lastEventAt=Date.now()-13*60000;provider.checkTurnStall(ctx);
  provider.handleEmitInner(ctx,event);
  messages.length=0;
  ctx.lastEventAt=Date.now()-45000;provider.checkTurnStall(ctx);
  assert.ok(messages.some(e=>e.kind==='response_wait'));
 }
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
 checkpoints.completeSnapshot();
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
 const blocked=path.join(dir,'blocked.txt');
 const id=checkpoints.beginTurn('待还原轮次',0);checkpoints.recordSnapshot(blocked,'原始内容');
 checkpoints.completeSnapshot();checkpoints.flush();await fs.mkdir(blocked);
 assert.throws(()=>checkpoints.restore(id),/blocked\.txt/);
 assert.equal(checkpoints.list()[0].id,id);
 const reloaded=new CheckpointManager(dir);reloaded.setSession('test');
 assert.equal(reloaded.list()[0].id,id);
 await fs.rmdir(blocked);
 assert.equal(checkpoints.restore(id).restoredFiles,1);
 assert.equal(await fs.readFile(blocked,'utf8'),'原始内容');
});
test('还原预检发现目录或链接冲突时，不先覆盖其他文件',async t=>{
 const {dir,checkpoints}=await checkpointFixture(t);
 const good=path.join(dir,'good.txt'),link=path.join(dir,'link.txt'),outside=path.join(dir,'outside.txt');
 await fs.writeFile(good,'当前内容');await fs.writeFile(outside,'链接目标不能被改');await fs.symlink(outside,link);
 const id=checkpoints.beginTurn('还原',0);checkpoints.recordSnapshot(good,'旧内容');checkpoints.recordSnapshot(link,'旧文件');
 assert.throws(()=>checkpoints.restore(id),/尚未修改文件/);
 assert.equal(await fs.readFile(good,'utf8'),'当前内容');assert.equal(await fs.readFile(outside,'utf8'),'链接目标不能被改');
});
test('中途写盘失败会恢复已修改和已删除文件，并保留还原点',async t=>{
 const {dir,checkpoints}=await checkpointFixture(t);const syncFs=require('node:fs');const write=syncFs.writeFileSync;
 const good=path.join(dir,'good.txt'),added=path.join(dir,'added.bin'),bad=path.join(dir,'bad.txt');
 await fs.writeFile(good,'当前内容');await fs.writeFile(added,Buffer.from([0,1,2]));await fs.writeFile(bad,'当前末尾');
 const id=checkpoints.beginTurn('还原',0);checkpoints.recordSnapshot(good,'旧内容');checkpoints.recordSnapshot(added,null);checkpoints.recordSnapshot(bad,'旧末尾');
 checkpoints.completeSnapshot();
 let failed=false;t.mock.method(syncFs,'writeFileSync',function(file,data,...args){
  if(file===bad&&!failed){failed=true;throw Error('模拟写盘失败');}return write.call(this,file,data,...args);
 });
 assert.throws(()=>checkpoints.restore(id),/已恢复到本次操作前的文件内容/);
 assert.equal(await fs.readFile(good,'utf8'),'当前内容');assert.equal(await fs.readFile(bad,'utf8'),'当前末尾');
 assert.deepEqual(await fs.readFile(added),Buffer.from([0,1,2]));assert.equal(checkpoints.list()[0].id,id);
 assert.equal(checkpoints.restore(id).restoredFiles,3);
});

test('单文件回滚失败不会把备份当作已接受而删除',async t=>{
 const {provider,messages}=providerFixture();
 const {dir,checkpoints}=await checkpointFixture(t);
 const blocked=path.join(dir,'blocked.txt');await fs.writeFile(blocked,'当前内容');
 checkpoints.beginTurn('待回滚',0);checkpoints.recordSnapshot(blocked,'原始内容');
 checkpoints.completeSnapshot();
 const syncFs=require('node:fs'),write=syncFs.writeFileSync;
 t.mock.method(syncFs,'writeFileSync',function(file,...args){if(file===blocked)throw Error('模拟写盘失败');return write.call(this,file,...args);});
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
 const blocked=path.join(dir,'blocked.txt');await fs.writeFile(blocked,'当前内容');
 checkpoints.recordSnapshot(blocked,'原始内容');checkpoints.completeSnapshot();checkpoints.flush();
 const syncFs=require('node:fs'),write=syncFs.writeFileSync;
 t.mock.method(syncFs,'writeFileSync',function(file,...args){if(file===blocked)throw Error('模拟写盘失败');return write.call(this,file,...args);});
 const originalFile=path.join(dir,'checkpoints-test.json');
 const before=await fs.readFile(originalFile,'utf8');
 const deleted=[];
 provider.speedMode=()=> 'default';provider.storageDir=()=>dir;
 provider.store={
  userTurnLines:()=>[{text:'第一轮',hasImages:false,line:1}],
  rewindLeafFor:()=> 'turn-1',fork:async()=> 'temporary-branch',
  delete:async id=>deleted.push(id),
 };
 const ctx={sessionId:'test',model:'',effort:'medium',checkpoints};
 await assert.rejects(provider.forkRewind(ctx,id,1),/blocked\.txt/);
 assert.deepEqual(deleted,['temporary-branch']);
 assert.equal(ctx.sessionId,'test');
 assert.equal(await fs.readFile(originalFile,'utf8'),before);
 await assert.rejects(fs.access(path.join(dir,'checkpoints-temporary-branch.json')));
});

test('压缩准备合并重复点击，切换会话或进程后取消旧请求',async()=>{
 for(const mode of ['same','switch','replace','restore','reject']){
  const provider=Object.create(ChatViewProvider.prototype);let calls=0,connections=0,release;
  const proc={isBusy:false,isExited:false,compact:()=>calls++};
  const ctx={sessionId:'source',proc};
  Object.assign(provider,{forking:new Set(),restoring:new Set(),alive:()=>true,
   output:{appendLine:()=>{}},post:()=>{},
   ensureProcess:()=>{connections++;return new Promise((resolve,reject)=>{
    release=()=>mode==='reject'?reject(Error('连接失败')):resolve(proc);
   });}});
  const work=provider.compactSession(ctx);
  await provider.compactSession(ctx);
  assert.equal(connections,1);
  if(mode==='switch')ctx.sessionId='other';
  if(mode==='replace')ctx.proc={...proc};
  if(mode==='restore')provider.restoring.add(ctx);
  release();
  if(mode==='reject')await assert.rejects(work,/连接失败/);else await work;
  assert.equal(calls,mode==='same'?1:0);
  assert.equal(ctx.compactionPreparing,false);
 }
});
test('空白会话和正在派生的会话不创建压缩连接',async()=>{
 for(const mode of ['empty','fork']){
  const provider=Object.create(ChatViewProvider.prototype);
  const ctx=mode==='empty'?{}:{sessionId:'source'};
  Object.assign(provider,{forking:new Set(mode==='fork'?[ctx]:[]),restoring:new Set(),
   post:()=>{},ensureProcess:()=>{throw Error('不应连接');}});
  await provider.compactSession(ctx);
 }
});
test('刚切换速度立即压缩会等待设置保存，等待期间切换会话不会压缩旧会话',async()=>{
 for(const switched of [false,true]){
  const provider=Object.create(ChatViewProvider.prototype),calls=[];
  let release,speed='fast';
  const proc={isBusy:false,isExited:false,compact:()=>calls.push(speed)};
  const ctx={sessionId:'source',proc};
  Object.assign(provider,{forking:new Set(),restoring:new Set(),alive:()=>true,
   output:{appendLine:()=>{}},post:()=>{},ensureProcess:async()=>proc});
  ctx.settingsQueue=new Promise(resolve=>{release=()=>{speed='default';resolve();};});
  const pending=provider.compactSession(ctx);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[]);
  if(switched)ctx.sessionId='other';
  release();await pending;
  assert.deepEqual(calls,switched?[]:['default']);
 }
});
test('并发列表刷新只渲染一次，失败后可以重试',async()=>{
 const provider=Object.create(ChatViewProvider.prototype);
 let reads=0,renders=0,release;
 Object.assign(provider,{sessions:new Set(),detached:new Map(),
  context:{workspaceState:{get:()=>undefined}},
  output:{appendLine:()=>{}},renderSessions:()=>renders++,
  store:{refresh:()=>{reads++;return new Promise((resolve,reject)=>{release={resolve,reject};});}}});
 for(let i=0;i<6;i++)provider.refreshSessions();
 assert.equal(reads,1);release.resolve();await provider.sessionsRefreshing;
 assert.equal(renders,1);
 provider.refreshSessions();release.reject(Error('断线'));await provider.sessionsRefreshing;
 provider.refreshSessions();release.resolve();await provider.sessionsRefreshing;
 assert.equal(reads,3);assert.equal(renders,2);
});
