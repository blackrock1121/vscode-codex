const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),http=require('node:http');
const Module=require('node:module'),load=Module._load,child=require('node:child_process');
const listeners=new Set();let nativeMode='success',lastDirectory;
const vscode={UIKind:{Desktop:1},env:{uiKind:1},workspace:{},
 window:{state:{focused:false},onDidChangeWindowState:fn=>{listeners.add(fn);return {dispose:()=>listeners.delete(fn)};}},
 commands:{executeCommand:async()=>{}}};
let api;
try {Module._load=function(name,...args){
 if(name==='vscode')return vscode;
 if(name==='node:child_process')return {...child,execFile(file,args,options,callback){
   if(file!=='/usr/bin/open')return child.execFile(file,args,options,callback);
   lastDirectory=path.dirname(args.at(-1));
   const result=nativeMode==='native_timeout'?{ok:false,error:'PRIVATE_BODY',code:'ETIMEDOUT',phase:'delivered_lookup'}:nativeMode==='superseded'?{ok:true,accepted:false,phase:'queued'}:nativeMode==='denied'?{ok:false,error:'PRIVATE_BODY'}:nativeMode==='invalid'?{}:{ok:true};
   const write=nativeMode==='timeout'?Promise.resolve():fsp.writeFile(path.join(lastDirectory,'result.json'),JSON.stringify(result));
   write.then(()=>callback(null,'',''),callback);
 }};
 return load.call(this,name,...args);
};api=require(process.env.DIAGNOSTIC_DD0_API||'../dist/test/diagnostic-safety.js');}finally{Module._load=load;}
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dd0-')),rows=[];
 const writer=new api.DailyLogWriter(dir,{pluginVersion:require('../package.json').version,windowId:'test',hostId:'test'});
 api.setOperationLogSink(line=>{rows.push(JSON.parse(line.slice(12)));writer.write(line);});
 t.after(async()=>{api.setOperationLogSink();await writer.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 return {rows,writer,scan:async()=>{await writer.flush();return api.scanPluginLogs(dir,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()+60000});}};
}

test('dd0 已在前台不等待聚焦命令，后台交接和超时仍核对真实状态',async t=>{
 const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 t.after(()=>{vscode.commands.executeCommand=async()=>{};vscode.window.state.focused=false;});
 vscode.window.state.focused=true;vscode.commands.executeCommand=()=>{calls++;return new Promise(()=>{});};
 let done=false;const fast=api.focusNotificationWindow().then(()=>{done=true;});await tick();
 assert.equal(done,true,'前台窗口不应被无关命令应答阻塞');await fast;assert.equal(calls,0);
 vscode.window.state.focused=false;const focused=api.focusNotificationWindow();await tick();
 for(const notify of listeners)notify({focused:true});await focused;assert.equal(calls,1);assert.equal(listeners.size,0);
 const failed=assert.rejects(api.focusNotificationWindow(),{code:'ETIMEDOUT'});await tick();t.mock.timers.tick(2000);await failed;
 const failure=f.rows.find(r=>r.stage==='failed');vscode.window.state.focused=true;await api.focusNotificationWindow();
 assert.equal(f.rows.find(r=>r.stage==='recovered').previousFailureId,failure.failureId);
 t.mock.timers.reset();assert.ok((await f.scan()).general.recoveredFailureChains>=1);
});

test('dd0 原生点击丢失会话返回失败，不能向辅助程序应答成功',async t=>{
 fixture(t);vscode.window.state.focused=true;
 const p=Object.create(api.ChatViewProvider.prototype);
 Object.assign(p,{notificationWindowKey:'window',sessions:new Set(),detached:new Map(),store:{list:()=>[]},output:{appendLine(){}}});
 await assert.rejects(p.handleNotificationUri({path:'/notification',query:'window=window&session=missing'},true),{code:'ENOENT'});
});

test('dd0 通知成功、拒绝、无效结果和清理失败分别留痕且不覆盖主结果',async t=>{
 const f=fixture(t),rm=fsp.rm;t.after(()=>{nativeMode='success';});
 const send=()=>api.sendLocalNotification('/fixture','PRIVATE_BODY','','vscode://fixture');
 nativeMode='denied';await assert.rejects(send(),/PRIVATE_BODY/);
 assert.equal(f.rows.find(r=>r.operation==='notification.show'&&r.stage==='failed').phase,'native_result');
 nativeMode='invalid';await assert.rejects(send(),{name:'SyntaxError'});
 nativeMode='success';await send();assert.equal(fs.existsSync(lastDirectory),false);
 t.mock.method(fsp,'rm',async file=>{if(file===lastDirectory)throw Object.assign(Error('PRIVATE_BODY'),{code:'EACCES'});return rm(file,{recursive:true,force:true});});
 await send();assert.ok(f.rows.some(r=>r.operation==='notification.cleanup'&&r.errorCode==='EACCES'));
 t.mock.restoreAll();await rm(lastDirectory,{recursive:true,force:true});
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_BODY|fixture/);
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('native_result')));
});

test('dd0 通知确认超时归为 await_result/ETIMEDOUT，后续发送可恢复',async t=>{
 const f=fixture(t);nativeMode='timeout';t.after(()=>{nativeMode='success';});
 t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});let reads=0;const read=fsp.readFile;
 t.mock.method(fsp,'readFile',async(...args)=>{if(String(args[0]).endsWith('result.json'))reads++;return read(...args);});
 const pending=assert.rejects(api.sendLocalNotification('/fixture','','','vscode://fixture'),{code:'ETIMEDOUT'});
 for(let i=0;i<1000&&!reads;i++)await tick();assert.ok(reads>0);
 // 文件读取消费 ENOENT 后才有轮询定时器。
 for(let i=0;i<20;i++)await tick();t.mock.timers.tick(30100);await pending;
 assert.ok(f.rows.some(r=>r.stage==='failed'&&r.phase==='await_result'&&r.failureCategory==='timeout'));
 t.mock.restoreAll();t.mock.timers.reset();nativeMode='success';await api.sendLocalNotification('/fixture','','','vscode://fixture');
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('ETIMEDOUT')));
});

test('dd0 图像 HTTP 成功、400、提前断流保持原请求且日志可归因',async t=>{
 const f=fixture(t),seen=[];let mode='success';
 const server=http.createServer(async(req,res)=>{
   const chunks=[];for await(const c of req)chunks.push(c);seen.push(Buffer.concat(chunks).toString());
   res.writeHead(mode==='400'?400:200,{'content-type':'application/json'});
   if(mode==='abort'){res.write('{"partial":');setImmediate(()=>res.destroy());return;}
   res.end(mode==='400'?JSON.stringify({error:{code:'invalid_request_error',message:'PRIVATE_BODY'}}):'{"ok":true}');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const relay=await api.CompactionRelay.start(`http://127.0.0.1:${server.address().port}/v1`,()=>undefined,()=>{}, {processRunId:'00000000-0000-0000-0000-000000000001'});
 t.after(()=>{relay.close();server.closeAllConnections();server.close();});
 const body=JSON.stringify({prompt:'PRIVATE_BODY',model:'chosen',quality:'high'});
 const send=()=>fetch(relay.baseUrl+'/images/generations',{method:'POST',body});
 assert.equal(await (await send()).text(),'{"ok":true}');mode='400';const rejected=await send();assert.equal(rejected.status,400);assert.match(await rejected.text(),/PRIVATE_BODY/);
 mode='abort';await assert.rejects(async()=>{await (await send()).text();});mode='success';assert.equal((await send()).status,200);
 await tick();assert.ok(seen.every(x=>x===body));
 const starts=f.rows.filter(r=>r.operation==='relay.http'&&r.stage==='start');assert.equal(starts.length,4);
 assert.ok(starts.every(r=>r.targetKind==='image_generation'&&r.requestModified===false));
 const error=f.rows.find(r=>r.stage==='failed'&&r.httpStatusCode===400);
 assert.equal(error.responseErrorCode,'invalid_request_error');assert.equal(error.reason,'http_error_response');
 for(const s of starts)assert.equal(f.rows.filter(r=>r.operationId===s.operationId&&['failed','completed','cancelled'].includes(r.stage)).length,1);
 assert.ok(f.rows.some(r=>r.stage==='failed'&&r.reason==='response_error'));
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_BODY|prompt|quality/);
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('responseErrorCode=invalid_request_error')));
});

test('dd0 压缩配置证据从落盘到模型摘要保留 false、未知和默认档位，API 失败不冒充插件异常',async t=>{
 const f=fixture(t);
 for(const changed of [false,true,undefined])f.writer.write('[compaction_route] '+JSON.stringify({atMs:Date.now(),stage:'response',
   fromModel:'gpt-6-astra',fromEffort:'high',toModel:'gpt-6.1-sol',effort:'xhigh',serviceTier:null,
   configurationScope:'request_only',sessionConfigurationChanged:changed,outcome:'completed',privateBody:'PRIVATE_BODY'}));
 f.writer.write('[transport] '+JSON.stringify({atMs:Date.now(),type:'event',event:'codex.api_request',success:false,hasError:true,failureCategory:'network_or_service'}));
 const result=await f.scan();assert.equal(result.compactionEvidence.length,3);
 assert.deepEqual(result.compactionEvidence.map(r=>r.sessionConfigurationChanged),[false,true,undefined]);
 assert.ok(result.compactionEvidence.every(r=>r.fromEffort==='high'&&r.serviceTier===null));
 const prompt=api.diagnosticModelPrompt(result);assert.match(prompt,/"sessionConfigurationChanged":false/);assert.doesNotMatch(prompt,/PRIVATE_BODY/);
 assert.match(result.report,/request_only \/ 否/);assert.match(result.report,/request_only \/ 未记录/);
 assert.ok(result.findings.some(r=>r.category==='后端服务'&&r.evidence.includes('codex.api_request')));
 assert.ok(!result.findings.some(r=>r.category==='插件运行'&&r.evidence.includes('codex.api_request')));
});

test('dd0 宿主处理峰值按轮次重置，保留连接峰值且上一轮终态不被重置',async t=>{
 const f=fixture(t),events=[];let clock=1000;
 t.mock.method(require('node:perf_hooks').performance,'now',()=>clock);
 const p=new api.CodexProcess({codexPath:path.resolve('test/fake-codex.cjs'),cwd:process.cwd(),permissionMode:'default'},
   {emit:e=>events.push(e),onClose(){},onPermission(){},onSessionId(){}});
 t.after(()=>p.dispose());await p.rpc.start();
 p.latency.begin('root',{});
 p.rpc.on('notification',m=>{if(m.method==='unicode/notification')clock+=350;});
 await p.rpc.request('unicode-output');
 for(let i=0;i<1000&&p.rpc.transportSnapshot().maxHandlerMs<350;i++)await tick();
 assert.equal(p.rpc.transportSnapshot().maxHandlerMs,350);
 p.latency.begin('root',{}); // finish superseded 必须先使用旧轮次窗口。
 await p.rpc.request('echo',{});p.latency.finish('completed');
 const summaries=events.filter(e=>e.kind==='diag'&&e.message.startsWith('[perf] ')).map(e=>JSON.parse(e.message.slice(7))).filter(r=>r.event==='turn_summary');
 assert.deepEqual(summaries.map(r=>r.maxHandlerMs),[350,0]);
 assert.ok(summaries.every(r=>r.processMaxHandlerMs===350&&r.handlerTimingScope==='turn'));
 const accumulator=new api.PerformanceAccumulator();summaries.forEach(r=>accumulator.add(r));
 assert.equal(accumulator.result().findings.find(r=>r.id==='host').occurrences,1);
 t.mock.restoreAll();assert.equal(f.rows.filter(r=>r.operation==='rpc.process'&&r.stage==='failed').length,0);
});


test('通知原生阶段超时落盘可检出；被新操作取代不会伪报已发送', async t=>{
 const f=fixture(t);t.after(()=>{nativeMode='success';});
 nativeMode='native_timeout';
 await assert.rejects(api.sendLocalNotification('/fixture','','','vscode://fixture'),{code:'ETIMEDOUT'});
 assert.ok(f.rows.some(r=>r.operation==='notification.show'&&r.stage==='failed'&&r.phase==='delivered_lookup'&&r.failureCategory==='timeout'));
 nativeMode='superseded';assert.equal(await api.sendLocalNotification('/fixture','','','vscode://fixture'),false);
 nativeMode='success';assert.equal(await api.sendLocalNotification('/fixture','','','vscode://fixture'),true);
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('delivered_lookup')));
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_BODY/);
});
