const {test}=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {once}=require('node:events'),{randomUUID}=require('node:crypto');
const {WebSocket,WebSocketServer}=require('ws');
const Module=require('node:module'),load=Module._load;let api;
try{Module._load=function(name,...args){return name==='vscode'?{window:{},workspace:{}}:load.call(this,name,...args);};api=require('../dist/test/diagnostic-safety.js');}finally{Module._load=load;}
const {classifyIncident}=require('../dist/test/diagnostics/general.js');
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-253b-')),rows=[],writer=new api.DailyLogWriter(dir,{pluginVersion:'test',windowId:'test',hostId:'test'});
 api.setOperationLogSink(line=>{rows.push(JSON.parse(line.slice(12)));writer.write(line);});
 t.after(async()=>{api.setOperationLogSink();await writer.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 return {rows,writer,scan:async()=>{await writer.flush();return api.scanPluginLogs(dir,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()+1000});}};
}
async function serverFixture(t,handler=()=>{}){
 const server=http.createServer(handler),sockets=new Set();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{for(const s of sockets)s.destroy();server.close();});
 return {server,url:`http://127.0.0.1:${server.address().port}/v1`};
}
function rejectedWs(url){
 return new Promise((resolve,reject)=>{
  const ws=new WebSocket(url.replace('http:','ws:')+'/responses');let status;
  ws.on('open',()=>{ws.terminate();reject(Error('不能提前报告握手成功'));});
  ws.on('unexpected-response',(req,res)=>{status=res.statusCode;res.destroy();req.destroy();ws.terminate();});
  ws.on('error',()=>{});ws.on('close',()=>resolve(status));
 });
}
test('253b 通知业务事件不再误报；真实发送失败与静默策略仍按结果区分',()=>{
 for(const line of ['[notify] dispatch session=a event=error local=true remote=false muted=true epoch=1',
  '[notify] local_result session=a event=error result=accepted elapsedMs=204'])assert.equal(classifyIncident(line),undefined);
 assert.equal(classifyIncident('[notify] local_result event=error result=failed').severity,'error');
 assert.equal(classifyIncident('[notify] dispatch event=error error=ECONNRESET').severity,'error');
 assert.equal(classifyIncident('',{operation:'compaction.http.upstream',stage:'failed'}).category,'连接与进程');
 assert.equal(classifyIncident('',{diagnosticType:'compaction_route',stage:'response',outcome:'failed'}).category,'压缩');
});
for(const status of [403,502])test(`253b WS ${status} 保留上游拒绝，无虚假 open、无请求重放，恢复后能正常收发`,async t=>{
 const f=fixture(t),{server,url}=await serverFixture(t),wss=new WebSocketServer({noServer:true});let deny=true,attempts=0,messages=0;
 server.on('upgrade',(req,socket,head)=>{attempts++;if(deny)socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\n\r\n`);
  else wss.handleUpgrade(req,socket,head,ws=>ws.on('message',data=>{messages++;ws.send(data);}));});
 const runId=randomUUID(),relay=await api.CompactionRelay.start(url,()=>undefined,()=>{}, {processRunId:runId});
 t.after(()=>{relay.close();wss.close();});
 assert.equal(await rejectedWs(relay.baseUrl),status);assert.equal(attempts,1);assert.equal(messages,0);
 const failure=f.rows.find(r=>r.stage==='failed');assert.equal(failure.httpStatusCode,status);assert.equal(failure.processRunId,runId);assert.ok(failure.connectionId);
 deny=false;const ws=new WebSocket(relay.baseUrl.replace('http:','ws:')+'/responses');t.after(()=>ws.terminate());await once(ws,'open');
 const response=once(ws,'message');ws.send('PRIVATE_INPUT');assert.equal((await response)[0].toString(),'PRIVATE_INPUT');assert.equal(messages,1);
 const scan=await f.scan();assert.equal(scan.general.compactionErrors,0);assert.equal(scan.general.failureChains,1);
 assert.equal(f.rows.filter(r=>r.stage==='completed').length,1);assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_INPUT/);
});
test('253b WS 握手超时和主动关闭均有唯一终态且释放上游',async t=>{
 const f=fixture(t),{server,url}=await serverFixture(t);server.on('upgrade',()=>{});
 const relay=await api.CompactionRelay.start(url,()=>undefined,()=>{}, {handshakeTimeoutMs:40});t.after(()=>relay.close());
 assert.equal(await rejectedWs(relay.baseUrl),502);await tick();
 const failure=f.rows.find(r=>r.stage==='failed');assert.equal(failure.failureCategory,'timeout');assert.equal(f.rows.filter(r=>r.stage==='failed').length,1);
 const pending=once(server,'upgrade'),ws=new WebSocket(relay.baseUrl.replace('http:','ws:')+'/responses');ws.on('error',()=>{});await pending;
 const closed=new Promise(r=>ws.once('close',r));relay.close();await closed;await tick();
 assert.equal(f.rows.filter(r=>r.stage==='failed').length,1);assert.ok(f.rows.some(r=>r.stage==='cancelled'));assert.equal(relay.sockets.size,0);
});
for(const mode of ['status','cut','cancel'])test(`253b HTTP ${mode} 终态落盘且不污染压缩统计`,async t=>{
 const f=fixture(t);let received;
 const seen=new Promise(r=>received=r),{url}=await serverFixture(t,async(req,res)=>{
  for await(const chunk of req){}received(res);
  if(mode==='status'){res.writeHead(403);res.end('PRIVATE_RESPONSE');}
  else{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: partial\n\n');}
 });
 const routes=[],runId=randomUUID(),relay=await api.CompactionRelay.start(url,()=>undefined,r=>routes.push(r),{processRunId:runId});t.after(()=>relay.close());
 const req=http.request(relay.baseUrl+'/responses',{method:'POST'});req.on('error',()=>{});
 const responding=once(req,'response');req.end('{}');const remote=await seen,[res]=await responding;
 let text='';res.on('data',c=>{text+=c;});const done=new Promise(r=>res.on('close',r));
 if(mode==='cut')remote.destroy();if(mode==='cancel')req.destroy();await done;await tick();await tick();
 const end=f.rows.find(r=>r.operation==='relay.http'&&r.stage!=='start');assert.equal(end.processRunId,runId);assert.equal(end.requestKind,'passthrough');assert.equal(routes.length,0);
 if(mode==='status'){assert.equal(res.statusCode,403);assert.equal(text,'PRIVATE_RESPONSE');assert.equal(end.stage,'failed');}
 if(mode==='cut'){assert.equal(res.complete,false);assert.equal(end.stage,'failed');}
 if(mode==='cancel')assert.equal(end.stage,'cancelled');
 assert.equal(f.rows.filter(r=>r.operation==='relay.http').length,2);assert.equal((await f.scan()).general.compactionErrors,0);
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_RESPONSE|data: partial/);
});
test('253b 页面消息投递拒绝、后续成功关联到同一故障链',async t=>{
 const f=fixture(t);let fail=true;const target={postMessage:async()=>{if(fail)throw Error('PRIVATE_TOKEN');return true;}};
 assert.equal(await api.postWebviewMessage(target,{}),false);assert.equal(await api.postWebviewMessage(target,{}),false);
 fail=false;assert.equal(await api.postWebviewMessage(target,{}),true);
 assert.deepEqual(f.rows.map(r=>r.stage),['failed','recovered']);assert.equal(f.rows[1].previousFailureId,f.rows[0].failureId);
 assert.equal((await f.scan()).general.recoveredFailureChains,1);assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN/);
});
test('253b 保留安全网络原因，模型容量不足独立分类，不记录包装异常正文',()=>{
 const cause=Object.assign(Error('PRIVATE_URL'),{code:'ECONNREFUSED'}),fields=api.errorFields(Error('PRIVATE_TOKEN',{cause}));
 assert.equal(fields.causeCode,'ECONNREFUSED');assert.equal(fields.failureCategory,'network_or_service');
 assert.equal(api.errorFields(Error('Proxy connection ended before receiving CONNECT response')).transportReason,'proxy_connect_closed');
 assert.equal(api.errorFields(Error('HTTP 502')).failureCategory,'network_or_service');
 assert.equal(api.errorFields(Error('Selected model is at capacity.')).failureCategory,'model_capacity');
 assert.doesNotMatch(JSON.stringify(fields),/PRIVATE/);
});
test('253b 工作区活动校验静默读错改为去重故障，修复存储后关联恢复',async t=>{
 const f=fixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-activity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const activity=api.WorkspaceActivity.begin(dir,[dir]);activity.finish();
 const read=fs.readFileSync;let fail=true;
 t.mock.method(fs,'readFileSync',function(file,...args){
  if(fail&&String(file).includes('workspace-activity'))throw Object.assign(Error('PRIVATE_PATH'),{code:'EACCES'});
  return read.call(this,file,...args);
 });
 for(let i=0;i<3;i++)assert.match(api.WorkspaceActivity.blockReason(dir,[activity.id],[path.join(dir,'file')]),/无法验证/);
 assert.equal(f.rows.filter(r=>r.operation==='workspace.activity.verify').length,1);
 fail=false;assert.equal(api.WorkspaceActivity.blockReason(dir,[activity.id],[path.join(dir,'file')]),undefined);
 assert.equal((await f.scan()).general.recoveredFailureChains,1);assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_PATH/);
});
test('253b 结束指纹读取失败保留安全拒绝并落盘，正常文件仍可还原',async t=>{
 const f=fixture(t),dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-fingerprint-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'file'),cp=new api.CheckpointManager(path.join(dir,'state'));cp.setSession('test');
 t.after(()=>cp.flush());fs.writeFileSync(file,'before');cp.startWorkspaceActivity([dir]);const id=cp.beginTurn('test',0,true);
 cp.recordSnapshot(file,'before');fs.writeFileSync(file,'after');const lstat=fs.lstatSync;let fail=true;
 t.mock.method(fs,'lstatSync',function(p,...args){if(fail&&p===file)throw Object.assign(Error('PRIVATE_PATH'),{code:'EACCES'});return lstat.call(this,p,...args);});
 cp.completeSnapshot();assert.throws(()=>cp.restore(id),/缺少并行保护或结束时的文件指纹/);assert.equal(fs.readFileSync(file,'utf8'),'after');
 assert.ok(f.rows.some(r=>r.operation==='checkpoint.fingerprint'&&r.errorCode==='EACCES'));
 fail=false;cp.startWorkspaceActivity([dir]);const next=cp.beginTurn('next',1,true);cp.recordSnapshot(file,'after');fs.writeFileSync(file,'last');cp.completeSnapshot();
 assert.equal(cp.restore(next).restoredFiles,1);assert.equal(fs.readFileSync(file,'utf8'),'after');
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('checkpoint.fingerprint')));assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_PATH/);
});
