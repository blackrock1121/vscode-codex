const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net'), http = require('node:http');
const {once} = require('node:events');
const {randomUUID} = require('node:crypto');
const {WebSocket, WebSocketServer} = require('ws');
const Module = require('node:module'), load = Module._load;
let api;
try {
  Module._load = function(name, ...args) { return name === 'vscode' ? {window:{},workspace:{getConfiguration:()=>({get:(_k,f)=>f})}} : load.call(this,name,...args); };
  api = require('../dist/test/diagnostic-safety.js');
} finally { Module._load = load; }
const {GeneralAccumulator} = require('../dist/test/diagnostics/general.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const fault = code => Object.assign(new Error('PRIVATE_TOKEN /private/body'), {code});

function fixture(t) {
  const dir = fs.mkdtempSync('/tmp/codex-50df-'), logs = path.join(dir,'logs'), rows = [];
  const writer = new api.DailyLogWriter(logs,{pluginVersion:require('../package.json').version,windowId:'fixture',hostId:'fixture'});
  api.setOperationLogSink(line => { rows.push(JSON.parse(line.slice(12))); writer.write(line); });
  t.after(async()=>{ api.setOperationLogSink(); await writer.dispose(); fs.rmSync(dir,{recursive:true,force:true}); });
  return {dir, rows, writer, scan:async()=>{await writer.flush();return api.scanPluginLogs(logs,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()+1000});}};
}

test('50df 快照清单后消失的文件标为不可还原，重现不能当新增文件删除',async t=>{
  const f=fixture(t),root=path.join(f.dir,'workspace');fs.mkdirSync(root);
  const file=path.join(root,'source.ts');fs.writeFileSync(file,'原有源码');
  const snapshot=new api.WorkspaceSnapshot([root]),read=snapshot.read.bind(snapshot);
  snapshot.read=async p=>{await fs.promises.unlink(p);return read(p);};
  await snapshot.capture();snapshot.read=read;
  assert.equal(snapshot.skipReasons.get(file),'unreadable');
  fs.writeFileSync(file,'重新出现的用户源码');
  assert.equal((await snapshot.changed()).has(file),false);
  assert.equal(snapshot.unrestorableChanges.has(file),true);
  assert.ok(f.rows.some(r=>r.operation==='snapshot.capture'&&r.stage==='unavailable'&&r.changedDuringRead===1));
  assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('snapshot.capture')));
});

test('50df 稳定小文件仅一次读取，状态核验仍拒绝读取中改写的文件',async t=>{
  const f=fixture(t),file=path.join(f.dir,'source.ts');fs.writeFileSync(file,'x'.repeat(500));
  const snapshot=new api.WorkspaceSnapshot([]),open=fs.promises.open;let reads=0,mutate=false;
  t.mock.method(fs.promises,'open',async(...args)=>{const h=await open(...args),read=h.read.bind(h);
    h.read=async(...params)=>{reads++;const r=await read(...params);if(mutate)await fs.promises.appendFile(file,'changed');return r;};return h;});
  assert.equal((await snapshot.read(file)).text.length,500);assert.equal(reads,1);
  mutate=true;assert.equal((await snapshot.read(file)).reason,'unreadable');
});

test('50df 历史分页重复及 legacy 缺失内容均失败，保留缓存并绑定后续恢复',async t=>{
  const f=fixture(t),store=new api.SessionStore(f.dir,()=>'/unused'),runId=randomUUID();
  let mode='duplicate';const thread={id:'thread-a',turns:[{id:'old',items:[]}]};store.threads.set(thread.id,thread);
  const rpc={runId,isClosed:false,dispose(){},async request(method,p){
    if(method==='thread/read')return {thread:{id:p.threadId,historyMode:mode==='legacy'?'legacy':'paginated',turns:mode==='legacy'?[{id:'bad'}]:undefined}};
    if(mode==='duplicate')return {data:[{id:'same',items:[]}],nextCursor:p.cursor?null:'page2'};
    return {data:[{id:'new',items:[]}],nextCursor:null};
  }};
  store.rpc=rpc;store.connection=async()=>rpc;t.after(()=>store.dispose());
  for(mode of ['duplicate','legacy']) {
    await assert.rejects(store.hydrate(thread.id),{name:'SyntaxError'});
    assert.equal(store.threads.get(thread.id),thread);
  }
  mode='ok';await store.hydrate('unrelated');
  assert.equal(f.rows.some(r=>r.stage==='recovered'),false);
  await store.hydrate(thread.id);assert.equal(store.countLines(thread.id),1);
  const recovery=f.rows.find(r=>r.stage==='recovered');assert.ok(recovery.previousFailureId);
  const scan=await f.scan();assert.equal(scan.general.recoveredFailureChains,1);
  assert.ok(scan.general.recoveryEvidence[0].failureLocation);assert.match(scan.report,/已关联恢复/);
});

test('50df 后端账户失败不自动重放，成功读取只恢复同类失败链',async t=>{
  const f=fixture(t),store=new api.SessionStore(f.dir,()=>'/unused'),runId=randomUUID(),failureId=randomUUID();
  let failing=true,calls=0;
  const rpc={runId,isClosed:false,dispose(){},async request(){calls++;if(failing)throw Object.assign(fault('ECONNRESET'),{failureId,processRunId:runId,errorOrigin:'backend',rpcCode:-32603});return {ok:true};}};
  store.rpc=rpc;store.connection=async()=>rpc;t.after(()=>store.dispose());
  await assert.rejects(store.read('account/rateLimits/read'));assert.equal(calls,1);
  failing=false;await store.read('model/list');assert.equal(f.rows.some(r=>r.stage==='recovered'),false);
  await store.read('account/rateLimits/read');await store.read('account/rateLimits/read');
  assert.equal(f.rows.filter(r=>r.stage==='recovered').length,1);
  const scan=await f.scan();assert.equal(scan.general.recoveredFailureChains,1);
  assert.ok(scan.findings.some(r=>r.category==='后端服务'));assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN/);
});

test('50df 较早启动的并发成功不能消除后发生的读取失败',async t=>{
  const f=fixture(t),store=new api.SessionStore(f.dir,()=>'/unused');let resolve;
  const wait=new Promise(r=>resolve=r);let calls=0;
  const rpc={runId:randomUUID(),isClosed:false,dispose(){},request:()=>++calls===1?wait:Promise.reject(fault('ECONNRESET'))};
  store.rpc=rpc;store.connection=async()=>rpc;t.after(()=>store.dispose());
  const early=store.read('account/read');await assert.rejects(store.read('account/read'));resolve({ok:true});await early;
  assert.equal(f.rows.some(r=>r.stage==='recovered'),false);assert.equal(store.readFailures.size,1);
});

test('50df 唯一失败链按版本窗口隔离，未关联恢复不抵扣错误，工具 js 不归为页面异常',()=>{
  const a=new GeneralAccumulator(),id=randomUUID();
  const where=(version='v1',window='w1',line=1)=>({file:'log',line,pluginVersion:version,windowId:window});
  const failed={stage:'failed',operation:'session.read',failureId:id,errorOrigin:'backend'};
  a.add('',failed,where());a.add('',failed,where());a.add('',failed,where('v2'));a.add('',failed,where('v1','w2'));
  a.add('',{stage:'recovered',operation:'session.read'},where());
  a.add('',{stage:'recovered',operation:'session.read',previousFailureId:id},where('v1','w1',2));
  a.add('',{event:'codex.tool_result',success:false,tool_name:'js',call_id:'call',traceId:'trace'},where());
  const r=a.result();assert.equal(r.summary.failureChains,3);assert.equal(r.summary.recoveredFailureChains,1);
  assert.equal(r.summary.linkedRecoveries,1);assert.equal(r.summary.recoveries,2);
  assert.ok(r.findings.some(f=>f.category==='工具执行'));assert.ok(r.findings.every(f=>f.category!=='页面脚本'));
});

test('50df RPC 超时保留阈值及执行器来源，挂起请求及时释放且后续成功',async t=>{
  const f=fixture(t),rpc=new api.CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd());t.after(()=>rpc.disposeAndWait());
  await rpc.start();await assert.rejects(rpc.request('hang',{},10),{errorOrigin:'timeout'});
  assert.equal(rpc.pending.size,0);assert.deepEqual(await rpc.request('echo',{ok:true}),{ok:true});
  const row=f.rows.find(r=>r.operation==='rpc.request'&&r.outcome==='failed');assert.equal(row.timeoutMs,10);assert.equal(row.terminationReason,'timeout');
  assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('timeoutMs=10')));
});

test('50df 手机桥接断开、网络错误、重连、主动关闭均有可关联终态',async t=>{
  const f=fixture(t),dir=path.join(f.dir,'bridge');fs.mkdirSync(dir,{mode:0o700});
  fs.writeFileSync(path.join(dir,'bridge.json'),JSON.stringify({version:1,token:'a'.repeat(64)}),{mode:0o600});
  const sockets=new Set();const server=net.createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.once('data',()=>s.write(JSON.stringify({kind:'registered',version:1,features:{events:true}})+'\n'));});
  await new Promise(r=>server.listen(path.join(dir,'bridge.sock'),r));fs.chmodSync(path.join(dir,'bridge.sock'),0o600);
  const client=new api.RemoteBridgeClient(dir,{windowId:'w',workspaceId:'p',label:'fixture'},async()=>({accepted:true,result:{}}));
  t.after(()=>{client.dispose();for(const s of sockets)s.destroy();server.close();});
  const connect=async()=>{const connected=once(server,'connection');client.start();await connected;await once(client.socket,'data');};
  await connect();const first=client.socket,closed=once(first,'close');[...sockets][0].end();await closed;
  const disconnect=f.rows.find(r=>r.stage==='disconnected');assert.equal(disconnect.reason,'peer_closed');assert.equal(disconnect.connectionKind,'remote_bridge');
  clearTimeout(client.retry);client.retry=undefined;await connect();
  const recovery=f.rows.find(r=>r.stage==='recovered');assert.equal(recovery.previousFailureId,disconnect.failureId);assert.equal(recovery.previousConnectionId,disconnect.connectionId);
  const second=client.socket;second.emit('error',fault('ECONNRESET'));const secondClosed=once(second,'close');second.destroy();await secondClosed;
  assert.equal(f.rows.findLast(r=>r.stage==='disconnected').reason,'socket_error');
  clearTimeout(client.retry);client.retry=undefined;await connect();
  const lastClosed=once(client.socket,'close');client.dispose();await lastClosed;
  assert.equal(f.rows.at(-1).stage,'cancelled');assert.equal(f.rows.at(-1).reason,'dispose');assert.equal(client.retry,undefined);
  const scan=await f.scan();assert.equal(scan.general.recoveredFailureChains,2);
  assert.ok(scan.findings.some(r=>r.category==='手机接入连接'));assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN|aaaaaaaaaaaaaaaaaaaa/);
});

for(const sync of [false,true])test(`50df WebSocket ${sync?'同步':'回调'}发送失败落盘、结束压缩、释放双方且不重放`,async t=>{
  const f=fixture(t),routes=[];let requests=0;
  const server=http.createServer(),wss=new WebSocketServer({server});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  wss.on('connection',ws=>ws.on('message',()=>{requests++;ws.send(JSON.stringify({type:'response.created',response:{id:'r'}}));}));
  const relay=await api.CompactionRelay.start(`http://127.0.0.1:${server.address().port}/v1`,()=>({model:'compact',effort:'high'}),r=>routes.push(r));
  t.after(()=>{relay.close();for(const s of wss.clients)s.terminate();wss.close();server.closeAllConnections();server.close();});
  const ws=new WebSocket(relay.baseUrl.replace('http:','ws:')+'/responses');t.after(()=>ws.terminate());await once(ws,'open');
  const local=[...relay.wss.clients][0];local.send=(_data,_opts,cb)=>{if(sync)throw fault('EPIPE');queueMicrotask(()=>cb(fault('EPIPE')));};
  const closed=once(ws,'close');ws.send(JSON.stringify({type:'response.create',model:'chosen',input:[{type:'compaction_trigger'}]}));await closed;
  assert.equal(requests,1);assert.deepEqual(routes.map(r=>r.stage),['request','response']);assert.equal(routes[1].outcome,'failed');assert.equal(routes[1].reason,'client_send');
  assert.ok(f.rows.some(r=>r.operation==='relay.websocket.write'&&r.reason==='client_send'));
  assert.equal(routes[1].failureId,f.rows.find(r=>r.operation==='relay.websocket.write').failureId);
  assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('client_send')));assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN/);
});

for(const branch of ['notification','discovery'])test(`50df 子线程 ${branch} 委派异常及时释放挂起请求并落盘`,async t=>{
  const f=fixture(t),opts={codexPath:path.resolve('test/fake-codex.cjs'),cwd:process.cwd(),model:'selected',effort:'high',permissionMode:'default',speedMode:'fast',compactionAutoValidate:false};
  const p=new api.CodexProcess(opts,{emit(){},onPermission(){},onSessionId(){},onClose(){}});t.after(()=>p.disposeAndWait());
  await p.rpc.start();p.sessionId='root';p.busy=true;p.ensureChild=async()=>true;
  const closed=once(p.rpc,'close'),pending=assert.rejects(p.rpc.request('hang'),{name:'AbortError'}),started=performance.now();
  if(branch==='notification') {
    p.childNotification=()=>{throw fault('EIO');};
    p.routeChildNotification({method:'turn/started',params:{threadId:'child',turn:{id:'turn'}}});
  }else {
    p.finishTreeIfReady=()=>{throw fault('EIO');};p.discoverChildren({type:'collabAgentToolCall',receiverThreadIds:['child']});
  }
  await pending;await closed;
  assert.equal(p.isBusy,false);assert.equal(p.isExited,true);assert.equal(p.rpc.pending.size,0);assert.equal(p.childNotificationQueue.size,0);
  assert.equal(f.rows.filter(r=>r.operation===`process.child.${branch}`&&r.stage==='failed').length,1);
  assert.ok((await f.scan()).findings.some(r=>r.evidence.includes(`process.child.${branch}`)));
  assert.deepEqual([p.opts.model,p.opts.effort,p.opts.speedMode,p.opts.permissionMode],['selected','high','fast','default']);
  assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN/);
  t.diagnostic(JSON.stringify({branch,releaseMs:Math.round(performance.now()-started),previousPendingTimeoutMs:60000}));
});

test('50df 提问状态清理失败落盘且本轮仍结束，修正后可继续正常收尾',async t=>{
  const f=fixture(t),events=[],p=new api.CodexProcess({codexPath:'/unused',cwd:f.dir,questionStateDir:f.dir,permissionMode:'default',compactionAutoValidate:false},
    {emit:e=>events.push(e),onPermission(){},onSessionId(){},onClose(){}});t.after(()=>p.dispose());
  p.sessionId='thread';p.busy=true;
  const file=api.questionStateFile(f.dir,'thread');fs.mkdirSync(file);
  p.finish(false);assert.equal(p.isBusy,false);assert.ok(f.rows.some(r=>r.operation==='question.cleanup'&&r.stage==='failed'));
  assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('question.cleanup')));
  fs.rmdirSync(file);fs.writeFileSync(file,'{}');p.busy=true;p.finish(false);
  assert.equal(p.isBusy,false);assert.equal(fs.existsSync(file),false);assert.equal(events.filter(e=>e.kind==='result').length,2);
});

test('50df CLI 技能安装及 SSE 错误按来源分类，不推断指定模型或页面缺陷',()=>{
  const {classifyIncident}=require('../dist/test/diagnostics/general.js');
  assert.equal(classifyIncident('',{type:'runtime_error',severity:'error',message:'codex_skills_extension::host_service: failed to install system skills: Directory not empty'}).category,'后端组件');
  assert.equal(classifyIncident('',{type:'event',event:'codex.sse_event',hasError:true,model:'chosen',failureEvidence:'error_message'}).category,'后端服务');
  assert.equal(classifyIncident('',{type:'event',event:'codex.sse_event',hasError:false}),undefined);
});

for(const sync of [false,true])test(`50df WebSocket 握手后上游发送${sync?'同步':'回调'}失败明确终结，避免握手后静默中断`,async t=>{
  const f=fixture(t),routes=[];let routed;
  const firstRoute=new Promise(r=>routed=r),server=http.createServer(),wss=new WebSocketServer({noServer:true});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const upgrade=once(server,'upgrade');
  const relay=await api.CompactionRelay.start(`http://127.0.0.1:${server.address().port}/v1`,()=>({model:'compact',effort:'high'}),r=>{routes.push(r);if(r.stage==='request')routed();});
  t.after(()=>{relay.close();for(const s of wss.clients)s.terminate();wss.close();server.closeAllConnections();server.close();});
  const ws=new WebSocket(relay.baseUrl.replace('http:','ws:')+'/responses');t.after(()=>ws.terminate());
  const opened=once(ws,'open'),[req,socket,head]=await upgrade; t.after(()=>socket.destroy());
  assert.equal(ws.readyState,WebSocket.CONNECTING);assert.equal(routes.length,0);
  wss.handleUpgrade(req,socket,head,()=>{});await opened;
  const upstream=[...relay.sockets].find(s=>!relay.wss.clients.has(s)&&s.readyState===WebSocket.OPEN);assert.ok(upstream);
  upstream.send=(_data,_opts,cb)=>{if(sync)throw fault('EPIPE');queueMicrotask(()=>cb(fault('EPIPE')));};
  const closed=once(ws,'close');ws.send(JSON.stringify({type:'response.create',model:'chosen',input:[{type:'compaction_trigger'}]}));await firstRoute;await closed;
  assert.deepEqual(routes.map(r=>r.stage),['request','response']);assert.equal(routes[1].outcome,'failed');assert.equal(routes[1].reason,'upstream_send');
  assert.equal(f.rows.filter(r=>r.operation==='relay.websocket.write').length,1);
  assert.equal(routes[1].failureId,f.rows.find(r=>r.operation==='relay.websocket.write').failureId);
  assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('upstream_send')));
});
