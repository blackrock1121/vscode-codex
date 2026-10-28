const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = { env: {}, workspace: { getConfiguration: () => ({ get: key => key === 'notifyWebhook' ? 'https://example.invalid/hook' : false }) } };
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
const { ChatViewProvider } = require('../dist/test/panel/chatViewProvider.js');
Module._load = originalLoad;
const { transcriptText, transcriptPage } = require('../dist/test/remote/transcript.js');
const { parseCommand } = require('../dist/test/remote/command.js');
const { CodexProcess } = require('../dist/test/codex/process.js');
let commandSequence = 0;
const command = (operation, sid = 'session-b') => ({ version: 1, commandId: 'cmd-' + ++commandSequence, deviceId: 'phone', issuedAt: Date.now(), expiresAt: Date.now() + 60000,
  target: { windowId: 'window', workspaceId: 'project', sessionId: sid }, operation });

function fixture() {
  const provider = Object.create(ChatViewProvider.prototype), saved = new Map(), events = [], sends = [];
  const makeSession = id => ({ sessionId: id, blank: false, ready: true, checkpoints: { startWorkspaceActivity: () => {}, finishWorkspaceActivity: () => {}, beginTurn: () => 'checkpoint', clear: () => {} },
    proc: { currentSessionId: id, currentTurnId: 'turn-1', isBusy: false, isExited: false,
      setModel: async () => {}, setEffort: async () => {}, setSpeedMode: async () => {},
      sendUserMessage(text) { sends.push([id, text]); this.isBusy = true; return true; },
      interrupt: async () => {},
    },
  });
  const a = makeSession('session-a'), b = makeSession('session-b');
  Object.assign(provider, {
    modelCatalog: [], sessions: new Set([a, b]), detached: new Map(), activeCtx: a, forking: new Set(), restoring: new Set(),
    remoteRegistration: () => ({ windowId: 'window', workspaceId: 'project', label: '假项目' }),
    context: { globalState:{get:key=>saved.get(key),update:async(key,value)=>saved.set(key,value)},workspaceState: { get: key => saved.get(key), update: async (key, value) => saved.set(key, value) } },
    store: { readTurnCount: async () => 0, list: () => [{ id: a.sessionId, title: 'A' }, { id: b.sessionId, title: 'B' }], hydrate: async () => {},
      load: id => [{ type: 'user', text: id }], countLines: () => 0 },
    config: () => ({ get: (key, fallback) => ['autosave', 'snapshotFilesForRestore'].includes(key) ? false : fallback }),
    fetchUsage: () => {},
    sessionModel: () => 'model-test', speedMode: () => 'default', sessionEffort: () => 'medium',
    output: { appendLine: () => {} }, post: (ctx, e) => events.push([ctx.sessionId, e]),
    clearSessionNotification: () => {}, notificationVersion: () => 0,
  });
  return { provider, a, b, saved, events, sends };
}

test('电脑队列通过原面板同步，分页只读展示；与手机队列共存且不会被手机调度重复发送',async()=>{
 const f=fixture(),adapter=f.provider.remote(),items=Array.from({length:7},(_,i)=>({id:'local-'+i,text:'电脑任务'+i,imageCount:i===0?2:0,fileCount:1}));
 await f.provider.onPanelMessage(f.b,{type:'desktopQueue',sessionId:f.b.sessionId,paused:true,items});
 const run=op=>f.provider.executeRemote(command(op),()=>true);
 let snap=(await run({kind:'session.snapshot'})).result;assert.equal(snap.queueCount,7);assert.equal(snap.desktopQueueCount,7);
 assert.equal((await f.provider.executeRemote(command({kind:'session.snapshot'},'session-a'),()=>true)).result.queueCount,0);
 await run({kind:'message.enqueue',text:'手机队列',attachmentIds:[]});await adapter.drainTasks(f.b);assert.equal(f.sends.length,0);
 const page=(await run({kind:'session.controls',section:'queue',page:1})).result;
 assert.equal(page.total,8);assert.deepEqual(page.items.map(m=>m.text),['电脑任务5','电脑任务6','手机队列']);
 assert.ok(page.items.slice(0,2).every(m=>m.readOnly&&m.paused&&m.source==='电脑'));
 assert.equal((await run({kind:'queue.remove',id:page.items[0].id})).error,'QUEUE_READ_ONLY');
 assert.equal((await run({kind:'message.send',text:'不得抢先',attachmentIds:[]})).error,'SESSION_BUSY');
 await f.provider.onPanelMessage(f.b,{type:'desktopQueue',sessionId:'session-a',paused:false,items:[]});
 assert.equal((await run({kind:'session.snapshot'})).result.desktopQueueCount,7);
 adapter.clearDesktopQueue(f.b);assert.equal((await run({kind:'session.snapshot'})).result.desktopQueueCount,0);
 await adapter.drainTasks(f.b);assert.deepEqual(f.sends,[['session-b','手机队列']]);adapter.dispose();
});

test('手机指定 B 时只调用 B 原进程，桌面焦点 A 不改变；同一发送路径显示用户消息', async () => {
  const f = fixture();
  f.b.draft = '电脑未发送草稿'; f.b.draftImages = [{ mediaType: 'image/png', data: 'test' }];
  const reply = await f.provider.executeRemote(command({ kind: 'message.send', text: '手机正文', attachmentIds: [] }), () => true);
  assert.equal(reply.accepted, true); assert.deepEqual(f.sends, [['session-b', '手机正文']]);
  assert.equal(f.provider.activeCtx, f.a);
  assert.ok(f.events.some(([id, e]) => id === 'session-b' && e.kind === 'remote_user' && e.text === '手机正文'));
  assert.equal(f.saved.get('codexChat.remotePrivate.session-b'), true);
  assert.equal(f.b.draft, '电脑未发送草稿'); assert.equal(f.b.draftImages[0].data, 'test');
  assert.ok(f.events.every(([, e]) => e.kind !== 'draft'));
  assert.equal((await f.provider.executeRemote(command({ kind: 'message.send', text: '重复点击', attachmentIds: [] }), () => true)).error, 'SESSION_BUSY');
});
test('手机列表与快照跟随桌面真实标题，重命名也使快照更新', async () => {
  const f = fixture();let title='真实会话标题';f.provider.store.list=()=>[{id:f.b.sessionId,title}];
  const list=await f.provider.executeRemote(command({kind:'session.list'},''),()=>true);
  assert.equal(list.result.sessions.find(s=>s.id===f.b.sessionId).title,title);
  const first=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result;assert.equal(first.title,title);
  title='电脑重命名后的标题';const next=(await f.provider.executeRemote(command({kind:'session.snapshot',revision:first.revision}),()=>true)).result;
  assert.equal(next.title,title);assert.equal(next.unchanged,false);
  const sent=await f.provider.executeRemote(command({kind:'message.send',text:'继续',attachmentIds:[]}),()=>true);assert.equal(sent.result.title,title);
});
test('本机空窗口和多文件夹工作区均注册；远端、不可信窗口仍拒绝', () => {
  const saved={...vscode.workspace},env=vscode.env;vscode.env={};
  try{
    vscode.workspace.isTrusted=true;vscode.workspace.workspaceFolders=[];
    const p=Object.create(ChatViewProvider.prototype);p.remoteWindowId='empty-window';
    assert.equal(p.remoteRegistration().folderCount,0);assert.equal(p.remoteRegistration().label,'未打开文件夹的窗口');
    const blankId=p.remoteRegistration().workspaceId;
    vscode.workspace.workspaceFolders=[{name:'a',uri:{scheme:'file',fsPath:'/a'}},{name:'b',uri:{scheme:'file',fsPath:'/b'}}];
    const multiple=p.remoteRegistration();assert.equal(multiple.folderCount,2);assert.equal(multiple.path,'/a');assert.equal(multiple.label,'a · b');assert.notEqual(multiple.workspaceId,blankId);
    vscode.workspace.isTrusted=false;assert.equal(p.remoteRegistration(),undefined);vscode.workspace.isTrusted=true;
    vscode.env.remoteName='ssh-remote';assert.equal(p.remoteRegistration(),undefined);
  }finally{vscode.workspace=saved;vscode.env=env;}
});
test('二十条长中文或 emoji 标题加重置卡不超帧预算，名称缩略不丢会话和额度', async () => {
  for (const title of ['长中文会话标题'.repeat(12), '🙂'.repeat(79)+'末尾', '\\"\u0001'.repeat(26)]) {
    for (const idLength of [36,128]) {
      const f=fixture(), ids=Array.from({length:20},(_,i)=>String(i).padStart(idLength,'s'));
      const rows=ids.map((id,i)=>({id,title:i===0?'短标题':title}));
      f.provider.sessions=new Set(ids.map((sessionId,i)=>({...f.b,sessionId,proc:{...f.b.proc,isBusy:i===1},pendingPerm:i===2?{kind:'permission_request'}:undefined})));
      f.provider.store.list=()=>rows;f.provider.pinnedSet=()=>new Set([ids[19]]);
      const usage={kind:'usage',weekPct:0,weekResetAt:1900000000,planType:'pro',resetCredits:{availableCount:8,cards:Array.from({length:8},()=>({title:'中文重置卡'.repeat(20),expiresAt:1900000000}))}};
      f.provider.lastUsage=usage;const before=JSON.stringify(usage);
      const reply=await f.provider.executeRemote(command({kind:'session.list'},''),()=>true);
      assert.equal(reply.accepted,true);assert.ok(Buffer.byteLength(JSON.stringify(reply))<=6500);
      assert.equal(reply.result.total,20);assert.equal(reply.result.sessions.length,20);
      assert.deepEqual(new Set(reply.result.sessions.map(s=>s.id)),new Set(ids));
      assert.equal(reply.result.sessions[0].id,ids[19]);assert.equal(reply.result.sessions[0].pinned,true);
      assert.equal(reply.result.sessions.find(s=>s.id===ids[1]).busy,true);assert.equal(reply.result.sessions.find(s=>s.id===ids[2]).waiting,true);
      assert.equal(reply.result.usage.weekPct,0);assert.equal(reply.result.usage.weekResetAt,1900000000);
      assert.equal(reply.result.usage.resetCredits.availableCount,8);assert.equal(reply.result.usage.resetCredits.cards.length,8);
      assert.ok(reply.result.usage.resetCredits.cards.every(c=>c.expiresAt===1900000000));
      assert.ok(reply.result.sessions.every(s=>s.title.length>0&&s.title.isWellFormed()));
      assert.equal(JSON.stringify(usage),before);assert.equal(rows[1].title,title);
    }
  }
});
test('手机发送失败不把手机文字写入电脑草稿，保留桌面原输入', async () => {
  const f = fixture(); f.b.draft = '电脑自己的草稿'; f.provider.ensureProcess = async () => undefined;
  assert.equal((await f.provider.executeRemote(command({ kind: 'message.send', text: '手机文字', attachmentIds: [] }), () => true)).error, 'MESSAGE_NOT_SENT');
  assert.equal(f.b.draft, '电脑自己的草稿'); assert.ok(f.events.every(([, e]) => e.kind !== 'draft'));
});
test('查询只能读本窗口打开/后台会话，复用权威历史；不允许路径或任意 Webview 操作', async () => {
  const f = fixture();
  const list = await f.provider.executeRemote(command({ kind: 'session.list' }, ''), () => true);
  assert.equal(list.result.sessions.length, 2);
  const snap = await f.provider.executeRemote(command({ kind: 'session.snapshot' }), () => true);
  assert.match(snap.result.text, /session-b/); assert.doesNotMatch(snap.result.text, /session-a/);
  assert.equal((await f.provider.executeRemote(command({ kind: 'session.snapshot' }, 'closed'), () => true)).error, 'SESSION_NOT_OPEN');
  const wrong = command({ kind: 'session.snapshot' }); wrong.target.windowId = 'other';
  assert.equal((await f.provider.executeRemote(wrong, () => true)).error, 'TARGET_OFFLINE');
  assert.throws(() => parseCommand(command({ kind: 'runInTerminal', code: 'bad' }), Date.now()));
  assert.equal(f.sends.length, 0);
});
test('准备期间桌面和手机发送互斥，断线或目标变化后不能迟到执行', async () => {
  const f = fixture(); let finish;
  f.provider.store.readTurnCount = () => new Promise(resolve => { finish = resolve; });
  let active = true;
  const sending = f.provider.handleSend(f.b, '第一条', undefined, undefined, undefined, () => active);
  assert.equal(await f.provider.handleSend(f.b, '桌面竞争'), false);
  active = false; finish();
  assert.equal(await sending, false); assert.equal(f.sends.length, 0); assert.equal(f.b.sending, false);
});
test('停止绑定真实轮次；已换轮次不打断，过期的审批与不可用图片明确拒绝', async () => {
  const f = fixture(); f.b.proc.isBusy = true; const stopped = [];
  f.provider.stopContext = async ctx => { stopped.push(ctx.sessionId); ctx.proc.isBusy = false; };
  assert.equal((await f.provider.executeRemote(command({ kind: 'turn.stop', turnId: 'old' }), () => true)).error, 'TURN_CHANGED');
  assert.equal((await f.provider.executeRemote(command({ kind: 'turn.stop', turnId: 'turn-1' }), () => true)).accepted, true);
  assert.deepEqual(stopped, ['session-b']);
  assert.equal((await f.provider.executeRemote(command({ kind: 'message.send', text: '', attachmentIds: ['file'] }), () => true)).error, 'IMAGE_NOT_AVAILABLE');
  assert.equal((await f.provider.executeRemote(command({ kind: 'permission.resolve', turnId: 'turn', requestId: 'req', requestVersion: 1, decision: 'allow' }), () => true)).error, 'REQUEST_ALREADY_RESOLVED');
});
test('尚未取得轮次 ID 或仅子任务运行时仍提供停止标识，跨新轮次失效', () => {
  const proc = Object.create(CodexProcess.prototype);
  Object.assign(proc, { busy: true, remoteInstance: 'process', dispatchSequence: 1, compactionSequence: 0 });
  const pending = proc.currentTurnId; assert.equal(pending, 'process-1-0');
  proc.dispatchSequence++; assert.notEqual(proc.currentTurnId, pending);
  proc.turnId = 'actual-turn'; assert.equal(proc.currentTurnId, 'actual-turn');
  proc.busy = false; assert.equal(proc.currentTurnId, undefined);
});
test('手机隐私标记在重载后仍禁止向非飞书 Webhook 发送，其他会话保持原行为', async () => {
  const f = fixture(), delivered = [];
  f.provider.sendWebhook = async (...args) => { delivered.push(args); return { ok: true }; };
  f.saved.set('codexChat.remotePrivate.session-b', true);
  f.provider.dispatchNotification(f.b, '不应发送', {});
  f.provider.dispatchNotification(f.a, '普通会话通知', {});
  assert.equal(delivered.length, 1); assert.equal(delivered[0][1], '普通会话通知');
});
test('长中文/emoji/转义文本完整分页、无变化只返回版本，旧游标显式重置', () => {
  const text = ('中文🙂\\\"\n'.repeat(2000)), state = { kind: 'session.snapshot', busy: false };
  let page = transcriptPage(text, state, {}), assembled = page.text;
  while (page.start) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 6000);
    page = transcriptPage(text, state, { end: page.start, revision: page.revision }); assembled = page.text + assembled;
  }
  assert.equal(assembled, text);
  assert.equal(transcriptPage(text, state, { revision: page.revision }).unchanged, true);
  assert.equal(transcriptPage('changed', state, { end: 10, revision: page.revision }).reset, true);
  assert.doesNotMatch(transcriptText([{ type: 'image', src: 'data:secret' }, { type: 'user', text: '用户', images: ['data:secret'] }]), /data:secret/);
});

test('结构化手机消息保留角色，空思考不占位，分页总帧保持在 IPC 限额内', () => {
  const {transcriptSnapshot}=require('../dist/test/remote/transcript.js');
  const items=[{type:'user',text:'正文里包含\nCodex\n但仍是用户消息'},{type:'thinking',text:''},{type:'assistant_text',text:'**结果**\n'+('中文🙂'.repeat(2000))}];
  let page=transcriptSnapshot(items,{kind:'session.snapshot'},{}),pages=[page];
  while(page.start){page=transcriptSnapshot(items,{kind:'session.snapshot'},{end:page.start,revision:page.revision});pages.push(page);}
  for(const p of pages){assert.ok(Buffer.byteLength(JSON.stringify(p))<6500);assert.ok(p.messages.every(m=>m.role!=='thinking'));}
  assert.ok(pages.at(-1).messages.some(m=>m.role==='user'&&m.text.includes('Codex')));
});

test('上传图片只能被同设备同目标读取，过期、摘要篡改、路径穿越和链接均拒绝',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
 const {remoteImages}=require('../dist/test/remote/images.js'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'remote-image-'));
 const c=command({kind:'message.send',text:'',attachmentIds:['photo']}),data=Buffer.from('89504e470d0a1a0a00000000','hex'),base=path.join(dir,'phone_photo');
 const meta={version:1,deviceId:'phone',target:c.target,mime:'image/png',size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),expiresAt:Date.now()+60000};
 const save=()=>fs.writeFileSync(base+'.json',JSON.stringify(meta),{mode:0o600});
 try{fs.writeFileSync(base+'.image',data,{mode:0o600});save();assert.equal(remoteImages(c,['photo'],dir)[0].data,data.toString('base64'));
 assert.throws(()=>remoteImages(c,['../photo'],dir));assert.throws(()=>remoteImages({...c,deviceId:'other'},['photo'],dir));
 assert.throws(()=>remoteImages({...c,target:{...c.target,sessionId:'other'}},['photo'],dir));
 meta.sha256='0'.repeat(64);save();assert.throws(()=>remoteImages(c,['photo'],dir));meta.sha256=crypto.createHash('sha256').update(data).digest('hex');meta.expiresAt=1;save();assert.throws(()=>remoteImages(c,['photo'],dir));
 meta.expiresAt=Date.now()+60000;save();fs.unlinkSync(base+'.image');fs.symlinkSync(base+'.json',base+'.image');assert.throws(()=>remoteImages(c,['photo'],dir));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('尚无会话时也能读取账号周限额，列表不创建会话且保留真实零值', async()=>{
  const f=fixture();let refreshes=0;f.provider.fetchUsage=()=>refreshes++;
  f.provider.sessions.clear();f.provider.lastUsage={kind:'usage',weekPct:0,weekResetAt:1900000000,planType:'pro',resetCredits:{availableCount:3,cards:[{title:'周限额重置卡',expiresAt:1900000000}]}};
  f.provider.lastUsageUpdatedAt=1800000000000;
  const result=(await f.provider.executeRemote(command({kind:'session.list'},''),()=>true)).result;
  assert.deepEqual(result.sessions,[]);assert.equal(result.usage.weekPct,0);assert.equal(result.usage.planType,'pro');
  assert.deepEqual(result.usage.resetCredits,f.provider.lastUsage.resetCredits);assert.equal(result.usage.updatedAt,1800000000000);assert.equal(refreshes,1);assert.deepEqual(f.sends,[]);
  f.provider.lastUsage=undefined;
  assert.equal((await f.provider.executeRemote(command({kind:'session.list'},''),()=>true)).result.usage,null);
});

test('手机快照与桌面共用当前会话模型、推理与额度，额度变化触发新版本', async()=>{
  const f=fixture();f.provider.lastUsage={kind:'usage',weekPct:83,sessionPct:21,weekResetAt:1900000000,sessionResetAt:1800000000};
  const first=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result;
  assert.equal(first.model,'model-test');assert.equal(first.effort,'medium');assert.equal(first.usage.weekPct,83);
  f.provider.lastUsage.weekPct=84;
  const next=(await f.provider.executeRemote(command({kind:'session.snapshot',revision:first.revision}),()=>true)).result;
  assert.equal(next.unchanged,false);assert.equal(next.usage.weekPct,84);
  f.provider.lastUsage.resetCredits={availableCount:0,cards:[]};
  assert.deepEqual((await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result.usage.resetCredits,{availableCount:0,cards:[]});
  f.provider.lastUsage.resetCredits={availableCount:30,cards:Array.from({length:30},()=>({title:'中文重置卡'.repeat(20),expiresAt:1900000000}))};
  const bounded=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result;
  assert.equal(bounded.usage.resetCredits.availableCount,30);assert.equal(bounded.usage.resetCredits.cards.length,8);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<6500);
  f.provider.lastUsage=undefined;
  assert.equal((await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result.usage,null);
});

test('密集工具分页仍有名称、状态和稳定标识，整帧不超过通道上限',()=>{
  const {transcriptSnapshot}=require('../dist/test/remote/transcript.js');
  const items=Array.from({length:100},(_,i)=>({type:'tool',toolId:String(i),name:i%2?'web_search':'bash',input:{},result:'',isError:i===99}));
  let page=transcriptSnapshot(items,{model:'model',effort:'high',usage:{weekPct:93}},{}),count=0;
  while(true){
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=6500);count+=page.messages.length;
    for(const m of page.messages){assert.ok(m.id);assert.ok(m.toolName);assert.ok(['completed','failed'].includes(m.status));}
    if(!page.start)break;
    page=transcriptSnapshot(items,{model:'model',effort:'high',usage:{weekPct:93}},{end:page.start,revision:page.revision});
  }
  assert.ok(count>=100);
});


test('手机审批绑定轮次与内容版本；旧审批不执行，允许仅答原请求一次',async()=>{
  const f=fixture(),calls=[];f.b.proc.isBusy=true;
  f.b.pendingPerm={kind:'permission_request',requestId:'approval',toolName:'Bash',input:{command:'pwd'},suggestions:[]};
  f.b.proc.respondPermission=(id,decision)=>{calls.push([id,decision]);return true;};
  const first=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result.request;
  const operation={kind:'permission.resolve',turnId:first.turnId,requestId:first.requestId,requestVersion:first.requestVersion,decision:'allow'};
  f.b.pendingPerm={...f.b.pendingPerm,input:{command:'new-command'}};
  assert.equal((await f.provider.executeRemote(command(operation),()=>true)).error,'REQUEST_ALREADY_RESOLVED');assert.equal(calls.length,0);
  const next=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result.request;
  assert.equal((await f.provider.executeRemote(command({...operation,requestVersion:next.requestVersion,turnId:'old-turn'}),()=>true)).error,'TURN_CHANGED');
  assert.equal((await f.provider.executeRemote(command({...operation,requestVersion:next.requestVersion}),()=>true)).accepted,true);
  assert.deepEqual(calls,[['approval',{behavior:'allow',suggestionId:undefined}]]);
  assert.equal((await f.provider.executeRemote(command({...operation,requestVersion:next.requestVersion}),()=>true)).error,'REQUEST_ALREADY_RESOLVED');
});

test('手机问题按编号映射原始 ID，完整作答走原提问准备与提交路径',async()=>{
  const f=fixture(),answers=[];f.b.proc.isBusy=true;
  f.b.pendingPerm={kind:'permission_request',requestId:'question',toolName:'AskUserQuestion',input:{questions:[{id:'原始 id',question:'选一个'},{question:'填写说明'}]},suggestions:[]};
  f.b.proc.prepareQuestionAnswer=()=>({text:'回答',turnId:'leaf'});
  f.b.proc.answerQuestion=(id,value)=>{answers.push([id,value]);f.b.pendingPerm=undefined;return true;};
  f.provider.store.rewindLeafFor=()=> 'leaf';f.provider.captureFinalSnapshot=async()=>{};
  const req=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result.request;
  const op={kind:'question.answer',requestId:req.requestId,requestVersion:req.requestVersion,turnId:req.turnId,answers:{'0':['选择 A'],'1':'文字答案'}};
  assert.equal((await f.provider.executeRemote(command({...op,answers:{'0':['选择 A']}}),()=>true)).error,'INVALID_ANSWERS');
  assert.equal((await f.provider.executeRemote(command(op),()=>true)).accepted,true);
  assert.deepEqual(answers,[['question',{'原始 id':['选择 A'],'填写说明':'文字答案'}]]);
});

test('配置复用原会话保存，运行中允许下一轮生效，保留校验与持久化失败保护',async()=>{
  const f=fixture();delete f.provider.sessionModel;delete f.provider.sessionEffort;delete f.provider.speedMode;
  f.b.model='model-a';f.b.effort='medium';f.b.speedMode='default';
  f.provider.modelCatalog=[{id:'model-a',name:'A',efforts:['medium','high'],speedModes:['default','fast']},{id:'model-b',name:'B',efforts:['low'],speedModes:['default']}];
  const configure=(key,value)=>f.provider.executeRemote(command({kind:'session.configure',key,value}),()=>true);
  assert.equal((await configure('model','missing')).error,'SETTING_NOT_SUPPORTED');
  assert.equal((await configure('effort','high')).accepted,true);assert.equal(f.saved.get('codexChat.sessionEffort.session-b'),'high');
  f.b.proc.isBusy=true;
  assert.equal((await configure('model','model-b')).result.appliesTo,'next_turn');
  assert.equal(f.b.proc.isBusy,true);assert.equal(f.b.proc.currentTurnId,'turn-1');assert.equal(f.a.model,undefined);
  assert.equal((await configure('effort','low')).accepted,true);assert.equal(f.saved.get('codexChat.sessionEffort.session-b'),'low');
  f.b.sending=true;assert.equal((await configure('model','model-a')).error,'SESSION_BUSY');f.b.sending=false;
  f.provider.restoring.add(f.b);assert.equal((await configure('model','model-a')).error,'SESSION_BUSY');f.provider.restoring.clear();
  f.b.proc.isBusy=false;await configure('effort','');
  assert.equal((await configure('model','model-b')).accepted,true);assert.equal(f.b.model,'model-b');assert.equal(f.b.effort,'');
  assert.equal((await configure('speed','fast')).error,'SETTING_NOT_SUPPORTED');
  f.provider.context.workspaceState.update=async()=>{throw new Error('disk');};
  assert.equal((await configure('effort','low')).error,'SETTING_NOT_SAVED');assert.equal(f.b.effort,'');
  let release,active=true;f.b.settingsQueue=new Promise(r=>release=r);
  const delayed=f.provider.executeRemote(command({kind:'session.configure',key:'effort',value:'low'}),()=>active);await Promise.resolve();active=false;release();await delayed;assert.equal(f.b.effort,'');
});

test('工具大输出不挤占会话正文，按需读取完整记录；任务清单直接呈现',async()=>{
  const {transcriptSnapshot}=require('../dist/test/remote/transcript.js');
  const items=[{type:'assistant_text',text:'关键结论'},{type:'tool',name:'Bash',toolId:'x',input:{command:'pwd'},result:'不重要的长输出'.repeat(5000)},
    {type:'tool',name:'TodoWrite',toolId:'plan',input:{todos:[{content:'实现界面',status:'completed'},{content:'测试',status:'in_progress'}]},result:''}];
  const snap=transcriptSnapshot(items,{},{});assert.match(snap.text,/关键结论/);assert.doesNotMatch(snap.text,/不重要的长输出/);assert.ok(snap.messages.some(m=>m.role==='plan'&&m.text.includes('✓ 实现界面')));
  const f=fixture();f.provider.store.load=()=>items;
  const details=(await f.provider.executeRemote(command({kind:'session.controls',section:'tool',item:1}),()=>true)).result;
  assert.match(details.text,/不重要的长输出/);assert.ok(details.start>0);assert.ok(Buffer.byteLength(JSON.stringify(details))<6500);
});


test('问答准备期间远程目标失效，原进程不得收到迟到答案',async()=>{
  const f=fixture();f.b.proc.isBusy=true;let release,active=true,calls=0;
  f.b.pendingPerm={kind:'permission_request',requestId:'question',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'继续？'}]},suggestions:[]};
  f.b.proc.prepareQuestionAnswer=()=>({text:'回答',turnId:'leaf'});f.b.proc.answerQuestion=()=>{calls++;return true;};
  f.provider.store.rewindLeafFor=()=> 'leaf';let captured;const captureStarted=new Promise(r=>captured=r);
  f.provider.captureFinalSnapshot=()=>{captured();return new Promise(r=>release=r);};
  const req=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result.request;
  const pending=f.provider.executeRemote(command({kind:'question.answer',turnId:req.turnId,requestId:req.requestId,requestVersion:req.requestVersion,answers:{'0':'继续'}}),()=>active);
  await captureStarted;active=false;release();await assert.rejects(pending,/提交已取消/);assert.equal(calls,0);assert.equal(f.b.answeringQuestion,false);
});


test('审批内容超长时拒绝手机操作，不能静默裁掉命令再批准',async()=>{
 const f=fixture();let calls=0;f.b.proc.isBusy=true;f.b.proc.respondPermission=()=>{calls++;return true;};
 f.b.pendingPerm={kind:'permission_request',requestId:'huge',toolName:'Bash',input:{command:'完整命令'.repeat(2000)},suggestions:[]};
 const result=(await f.provider.executeRemote(command({kind:'session.controls',section:'request'}),()=>true)).result;assert.equal(result.unsupported,true);
 const req=result.request;
 assert.equal((await f.provider.executeRemote(command({kind:'permission.resolve',turnId:req.turnId,requestId:req.requestId,requestVersion:req.requestVersion,decision:'allow'}),()=>true)).error,'REQUEST_TOO_LARGE');assert.equal(calls,0);
});

test('长中文实时输出快照不超 IPC 帧预算，完成事件强制刷新最终历史',async()=>{
  const f=fixture();
  f.provider.remote().observe(f.b,{kind:'text_delta',text:'回复'.repeat(4000)});
  f.provider.remote().observe(f.b,{kind:'thinking_delta',text:'思考'.repeat(4000)});
  const reply=await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true);
  assert.equal(reply.accepted,true);assert.ok(Buffer.byteLength(JSON.stringify(reply.result))<=6500);assert.equal(reply.result.stream.truncated,true);
  let reads=0;f.provider.store.hydrate=async()=>{reads++;};
  f.provider.remote().observe(f.b,{kind:'result',isError:false});
  const final=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result;
  assert.equal(reads,1);assert.equal(final.stream.active,false);
});
test('生成图片文件已删除时返回明确错误，不能触发 IPC 非法错误码断连',async()=>{
  const f=fixture(),{itemRevision}=require('../dist/test/remote/timeline.js');const item={type:'tool',name:'imageGeneration',input:{savedPath:'/nonexistent-codex-mobile-picture.png'},result:'{}'};
  f.provider.store.load=()=>[item];f.provider.cwd=()=>'/tmp';
  const reply=await f.provider.executeRemote(command({kind:'session.image',item:0,revision:itemRevision(item),index:0,offset:0}),()=>true);
  assert.equal(reply.accepted,false);assert.equal(reply.error,'IMAGE_NOT_AVAILABLE');
});


test('远程发布异常不影响电脑正文和完成处理；远程状态不写入电脑会话对象',async()=>{
  const f=fixture();f.provider.remotePublish=()=>{throw new Error('通知服务故障');};
  await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true);
  const seen=[];f.provider.post=(_,e)=>seen.push(e);f.provider.broadcastRunning=()=>{};
  f.provider.refreshSessions=()=>{};f.provider.maybeNotifyTurnDone=()=>{};
  assert.doesNotThrow(()=>f.provider.handleEmitInner(f.b,{kind:'text_delta',text:'电脑正常显示'}));
  assert.doesNotThrow(()=>f.provider.handleEmitInner(f.b,{kind:'result',isError:false}));
  assert.ok(seen.some(e=>e.kind==='text_delta'&&e.text==='电脑正常显示'));
  assert.ok(seen.some(e=>e.kind==='result'));
  assert.equal(f.b.remoteStream,undefined);assert.equal(f.b.taskQueue,undefined);
});
test('关闭远程接入后拒绝手机命令，电脑仍能通过原发送路径工作',async()=>{
  const f=fixture();f.provider.setRemoteEnabled(false);
  assert.equal((await f.provider.executeRemote(command({kind:'message.send',text:'手机',attachmentIds:[]}),()=>true)).error,'TARGET_OFFLINE');
  assert.equal(await f.provider.handleSend(f.b,'电脑继续'),true);assert.equal(f.sends[0][1],'电脑继续');
  f.b.proc.isBusy=false;f.provider.setRemoteEnabled(true);
  assert.equal((await f.provider.executeRemote(command({kind:'message.send',text:'手机恢复',attachmentIds:[]}),()=>true)).accepted,true);
});

test('手机排队在关闭接入后停止派发，恢复并明确继续后仅发送一次',{timeout:5000},async()=>{
  const f=fixture();f.b.proc.isBusy=true;
  await f.provider.executeRemote(command({kind:'message.enqueue',text:'手机队列',attachmentIds:[]}),()=>true);
  assert.equal(f.provider.remote().hasPending(f.b),true);assert.equal(f.sends.length,0);
  f.provider.setRemoteEnabled(false);f.b.proc.isBusy=false;
  f.provider.remote().observe(f.b,{kind:'result',isError:false});
  await f.provider.remote().drainTasks(f.b);assert.equal(f.sends.length,0);
  f.provider.setRemoteEnabled(true);
  let sent;const delivered=new Promise(resolve=>sent=resolve);const original=f.b.proc.sendUserMessage;
  f.b.proc.sendUserMessage=function(...args){const result=original.apply(this,args);sent();return result;};
  await f.provider.executeRemote(command({kind:'queue.resume'}),()=>true);
  await delivered;await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.sends,[['session-b','手机队列']]);assert.equal(f.provider.remote().hasPending(f.b),false);
  f.provider.remote().dispose();
});

test('多段流独立编号，正文修正替换而非追加，历史携带同源消息标识',async()=>{
 const f=fixture(),adapter=f.provider.remote(),events=[];f.provider.remotePublish=(_id,e)=>events.push(e);f.b.proc.isBusy=true;
 adapter.observe(f.b,{kind:'busy',busy:true});
 adapter.observe(f.b,{kind:'block_start',blockType:'text',itemId:'message-a'});
 adapter.observe(f.b,{kind:'text_delta',text:'第一段'});
 const first=adapter.state(f.b).remoteStream.id;
 adapter.observe(f.b,{kind:'block_end'});
 assert.ok(events.some(e=>e.kind==='delta'&&e.id===first&&e.active===false));
 adapter.observe(f.b,{kind:'block_start',blockType:'text',itemId:'message-b'});
 adapter.observe(f.b,{kind:'text_delta',text:'第二段草稿'});
 assert.equal(adapter.state(f.b).remoteStream.text,'第二段草稿');
 assert.notEqual(adapter.state(f.b).remoteStream.id,first);
 adapter.observe(f.b,{kind:'text_snap',text:'第二段完整正文'});
 const current=adapter.state(f.b).remoteStream;
 assert.equal(current.text,'第二段完整正文');assert.equal(current.itemId,'message-b');
 f.provider.store.load=()=>[{type:'assistant_text',text:'第一段',sourceId:'message-a'},{type:'assistant_text',text:current.text,sourceId:'message-b'}];
 const snapshot=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result;
 assert.equal(snapshot.messages[1].sourceId,snapshot.stream.itemId);
 assert.equal(snapshot.stream.text,'第二段完整正文');
 adapter.observe(f.b,{kind:'block_end'});
 assert.equal(adapter.state(f.b).remoteStream.active,false);
});

test('桌面实时额度更新也成为手机和新会话读取的账号用量',async()=>{
 const f=fixture();f.provider.lastUsage={kind:'usage',weekPct:1};f.provider.lastUsageUpdatedAt=1;f.provider.maybeNotifyUsage=()=>{};
 f.provider.handleEmitInner(f.b,{kind:'usage',weekPct:37.5,weekResetAt:1900000000});
 const result=(await f.provider.executeRemote(command({kind:'session.list'},''),()=>true)).result;
 assert.equal(result.usage.weekPct,37.5);assert.ok(result.usage.updatedAt>1);
});

test('手机在任务启动后才连接，仍读取电脑原始开始时间；轮询时钟不打破快照缓存',async()=>{
 const f=fixture(),adapter=f.provider.remote();adapter.observe(f.b,{kind:'busy',busy:true});f.b.proc.isBusy=true;
 adapter.observe(f.b,{kind:'tokens',output:16200});adapter.observe(f.b,{kind:'block_end'});
 const first=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result;
 assert.ok(first.run.startedAt<=first.serverTime);assert.equal(first.run.tokens,16200);assert.equal(first.run.progress,'模型阶段完成');
 const next=(await f.provider.executeRemote(command({kind:'session.snapshot',revision:first.revision}),()=>true)).result;
 assert.equal(next.unchanged,true);assert.equal(next.run.id,first.run.id);assert.equal(next.run.startedAt,first.run.startedAt);assert.ok(next.serverTime>=first.serverTime);
 const other=(await f.provider.executeRemote(command({kind:'session.snapshot'},'session-a'),()=>true)).result;assert.equal(other.run,null);
 adapter.observe(f.b,{kind:'result',isError:false});adapter.observe(f.b,{kind:'busy',busy:false});f.b.proc.isBusy=false;
 const final=(await f.provider.executeRemote(command({kind:'session.snapshot'}),()=>true)).result;assert.ok(final.run.finishedAt>=final.run.startedAt);
 f.b.sessionId='rebound-session';const rebound=(await f.provider.executeRemote(command({kind:'session.snapshot'},'rebound-session'),()=>true)).result;assert.equal(rebound.run,null);
 adapter.dispose();
});
