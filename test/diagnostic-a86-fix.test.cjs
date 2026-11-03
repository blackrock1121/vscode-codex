const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const Module=require('node:module'),load=Module._load;
let api;
try {Module._load=function(name,...args){return name==='vscode'?{window:{},workspace:{getConfiguration:()=>({get:(_k,f)=>f})}}:load.call(this,name,...args);};api=require('../dist/test/diagnostic-safety.js');}finally{Module._load=load;}
const fault=()=>Object.assign(new Error('PRIVATE_BODY /private/path'),{code:'ENOSPC'});
function fixture(t){const dir=fs.mkdtempSync('/tmp/codex-a86-'),rows=[];const writer=new api.DailyLogWriter(dir,{pluginVersion:'fixture',windowId:'fixture',hostId:'fixture'});api.setOperationLogSink(line=>{rows.push(JSON.parse(line.slice(12)));writer.write(line);});t.after(async()=>{api.setOperationLogSink();await writer.dispose();fs.rmSync(dir,{recursive:true,force:true});});return {dir,rows,scan:async()=>{await writer.flush();return api.scanPluginLogs(dir,()=>{},{kind:'general',hours:0,engine:'rules'});}};}

test('a86 发送收尾磁盘失败也释放发送锁，保留活动以供恢复并能再次发送',async t=>{
 const f=fixture(t),p=Object.create(api.ChatViewProvider.prototype),ctx={checkpoints:{finishWorkspaceActivity(){throw fault();}}};
 p.post=()=>{};p.handleSendInner=async()=>false;
 await assert.rejects(p.handleSend(ctx,'x'),{code:'ENOSPC'});
 assert.equal(ctx.sending,false);
 const original=new Error('发送阶段原始失败');p.handleSendInner=async()=>{throw original;};
 await assert.rejects(p.handleSend(ctx,'x'),error=>error===original);assert.equal(ctx.sending,false);
 ctx.checkpoints.finishWorkspaceActivity=()=>{};let calls=0;p.handleSendInner=async()=>{calls++;return true;};
 assert.equal(await p.handleSend(ctx,'x'),true);assert.equal(calls,1);
 assert.ok(f.rows.some(r=>r.operation==='send.cleanup'&&r.stage==='failed'));
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('send.cleanup')));
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_BODY|private\/path/);
});

test('a86 首次目录失败后连续打开只发一次请求，冷却后成功关联恢复且不改会话选择',async t=>{
 const f=fixture(t),p=new api.CodexProcess({codexPath:'/unused',cwd:f.dir,model:'gpt-6-astra',effort:'high',speedMode:'default',permissionMode:'default',compactionMode:'session',compactionAutoValidate:false},{emit(){},onPermission(){},onSessionId(){},onClose(){}});
 t.after(()=>p.dispose());p.rpc.start=async()=>{};let calls=0;
 p.rpc.request=async()=>{calls++;throw Object.assign(new Error('HTTP 503'),{errorOrigin:'backend'});};
 await p.refreshModels();await p.refreshModels();await p.refreshModels();assert.equal(calls,1);
 p.modelsRetryAt=0;p.rpc.request=async()=>{calls++;return {data:[]};};await p.refreshModels();
 assert.equal(calls,2);assert.equal(p.opts.model,'gpt-6-astra');assert.equal(p.opts.effort,'high');assert.equal(p.opts.permissionMode,'default');
 assert.ok(f.rows.some(r=>r.operation==='models.load'&&r.stage==='recovered'&&r.previousFailureId));
 assert.ok((await f.scan()).general.recoveredFailureChains>=1);
});

test('a86 工具输入错误有专门类别，取消来源未知不能冒充用户停止',()=>{
 assert.equal(api.failureCategory('apply_patch verification failed: Failed to find expected lines in PRIVATE'),'patch_mismatch');
 assert.equal(api.failureCategory('write_stdin failed: Unknown process id 44958'),'tool_session_missing');
 const row=new api.StderrDiagnostics().classify('2026-11-03T01:00:00Z ERROR codex_core::tools::router: error=dynamic tool call was cancelled before receiving a response');
 assert.equal(row.event,'tool_cancelled');assert.equal(row.severity,'warning');assert.equal(row.cancellationReason,'unknown');
});

test('a86 远端图片读取失败脱敏落盘，文件恢复后仍能读取且不重复记录预期拒绝',async t=>{
 const f=fixture(t),file=path.join(f.dir,'PRIVATE_BODY.png'),item={type:'image',src:file};
 const ctx={sessionId:'session',checkpoints:{}},registration=()=>({windowId:'window',workspaceId:'workspace'});
 const adapter=new api.RemoteSessionAdapter({registration,contexts:()=>[ctx],markPrivate:async()=>{},store:{hydrate:async()=>{},load:()=>[item]},cwd:()=>f.dir});
 t.after(()=>adapter.dispose());
 const request=index=>adapter.execute({version:1,commandId:'image-'+index,deviceId:'phone',issuedAt:Date.now(),expiresAt:Date.now()+60000,
  target:{...registration(),sessionId:'session'},operation:{kind:'session.image',item:0,revision:api.itemRevision(item),index,offset:0}},()=>true);
 assert.equal((await request(0)).error,'IMAGE_NOT_AVAILABLE');
 assert.ok(f.rows.some(row=>row.operation==='remote.image.read'&&row.errorCode==='ENOENT'));
 fs.writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv8AAAAASUVORK5CYII=','base64'));
 assert.equal((await request(0)).accepted,true);
 const failures=f.rows.length;assert.equal((await request(1)).error,'IMAGE_NOT_AVAILABLE');assert.equal(f.rows.length,failures);
 assert.ok((await f.scan()).findings.some(row=>row.evidence.includes('remote.image.read')));
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_BODY/);
});

test('a86 HTTP 响应头等待可观测但不截断后端，客户端取消及下一请求恢复各有终态',async t=>{
 const f=fixture(t);let mode='hang',pending;
 const server=http.createServer((req,res)=>{req.resume();if(mode==='hang'){pending=res;return;}res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();setTimeout(()=>res.end('data: done\n\n'),80);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const relay=await api.CompactionRelay.start(`http://127.0.0.1:${server.address().port}`,()=>undefined,()=>{},{responseHeaderHeartbeatMs:20});
 t.after(()=>{relay.close();server.closeAllConnections();server.close();});
 const request=()=>{let query;const done=new Promise((resolve,reject)=>{query=http.get(relay.baseUrl+'/responses',res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));res.on('error',reject);});query.on('error',reject);});return {done,abort:()=>query.destroy()};};
 const waitFor=async predicate=>{const deadline=Date.now()+1000;while(!predicate()){assert.ok(Date.now()<deadline,'事件等待超时');await new Promise(resolve=>setTimeout(resolve,5));}};
 const first=request();await waitFor(()=>f.rows.some(r=>r.operation==='relay.http'&&r.stage==='waiting'));
 assert.equal(pending.destroyed,false);pending.writeHead(200);pending.end('backend done');assert.equal((await first.done).status,200);
 const cancelled=request();const rejected=assert.rejects(cancelled.done);await waitFor(()=>f.rows.filter(r=>r.stage==='waiting').length>=2);cancelled.abort();await rejected;
 await waitFor(()=>f.rows.some(r=>r.operation==='relay.http'&&r.stage==='cancelled'));
 mode='ok';const next=await request().done;assert.equal(next.status,200);assert.match(next.body,/done/);
 const ends=f.rows.filter(r=>r.operation==='relay.http'&&r.stage==='completed');assert.equal(ends.length,2);
 const last=ends.at(-1).operationId;assert.ok(f.rows.some(r=>r.operationId===last&&r.stage==='response_headers'));
 assert.ok(!f.rows.some(r=>r.operationId===last&&r.stage==='waiting'));
 assert.equal((await f.scan()).general.errors,0);
});

test('a86 日志磁盘与输出通道同时失败仍从宿主反馈，恢复后补写且诊断检出',async t=>{
 const dir=fs.mkdtempSync('/tmp/codex-a86-health-'),blocked=path.join(dir,'blocked'),fallback=[];
 fs.writeFileSync(blocked,'file');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 t.mock.method(console,'warn',line=>fallback.push(line));
 const writer=new api.DailyLogWriter(blocked,undefined,undefined,()=>{throw fault();});t.after(()=>writer.dispose());
 writer.write('fixture');await writer.flush();assert.equal(fallback.length,1);assert.match(fallback[0],/"stage":"failed"/);
 fs.unlinkSync(blocked);fs.mkdirSync(blocked);await writer.flush();await writer.flush();
 assert.equal(writer.healthSnapshot().failed,false);assert.ok(fallback.some(line=>line.includes('recovered')));
 const result=await api.scanPluginLogs(blocked,()=>{},{kind:'general',hours:0,engine:'rules'});
 assert.ok(result.findings.some(row=>row.category==='采集完整性'));assert.doesNotMatch(fallback.join(''),/PRIVATE_BODY|private\/path/);
});

test('a86 诊断消息错误不会执行操作，设置失败与成功具有完整操作边界',async t=>{
 const f=fixture(t),jobs=new (require('node:events').EventEmitter)();let calls=0,fail=true;
 const page=new api.DiagnosticsPage({},jobs,async()=>{},async()=>{},{save:async()=>{calls++;if(fail)throw fault();}});
 t.after(()=>page.dispose());await page.message({type:'PRIVATE_BODY'});assert.equal(calls,0);
 const options={kind:'general',hours:0,engine:'rules'};
 await assert.rejects(page.message({type:'configure',options}),{code:'ENOSPC'});fail=false;
 await page.message({type:'configure',options});
 assert.ok(f.rows.some(r=>r.phase==='configure'&&r.stage==='failed'));
 assert.ok(f.rows.some(r=>r.phase==='configure'&&r.stage==='completed'));
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('diagnostics.page.message')));
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_BODY/);
});
