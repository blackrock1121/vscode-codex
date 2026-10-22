const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const Module=require('node:module'),load=Module._load;
let api;try{Module._load=function(name,...args){return name==='vscode'?{window:{},Uri:{},ViewColumn:{Active:1}}:load.call(this,name,...args);};api=require('../dist/test/diagnostic-safety.js');}finally{Module._load=load;}
const fault=code=>Object.assign(new Error('PRIVATE_TOKEN /private/body'),{code});
function temporary(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-3a1-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function capture(t){const rows=[];api.setOperationLogSink(line=>rows.push(JSON.parse(line.slice(line.indexOf('{')))));t.after(()=>api.setOperationLogSink());return rows;}

for(const code of ['EACCES','ENOSPC'])test(`3a1 并发 flush 与退出遇到 ${code} 不绕过退避紧密重试`,async t=>{
 const dir=temporary(t),health=[],writer=new api.DailyLogWriter(dir,undefined,undefined,line=>health.push(line));let attempts=0;
 t.mock.method(fs.promises,'appendFile',async()=>{attempts++;throw fault(code);});
 writer.write('pending');await Promise.all([writer.flush(),...Array.from({length:24},()=>writer.flush()),writer.dispose()]);
 assert.equal(attempts,1);assert.equal(health.length,1);assert.ok(writer.pendingBytes>0);assert.doesNotMatch(health[0],/PRIVATE/);
});

test('3a1 两个日志出口故障有独立反馈，恢复损失计数落盘并被全面诊断检出',async t=>{
 const dir=temporary(t),writer=new api.DailyLogWriter(dir),warnings=[],rows=[];
 t.mock.method(console,'warn',line=>warnings.push(line));let failing=true;
 const sink=line=>{if(failing)throw fault('EIO');rows.push(JSON.parse(line.slice(line.indexOf('{'))));writer.write(line);};
 api.setOperationLogSink(sink);t.after(()=>api.setOperationLogSink());
 api.operationLog('fixture','start');api.operationLog('fixture','completed');
 const trace=new api.PerformanceTrace(row=>sink('[perf] '+JSON.stringify(row)));
 trace.begin('thread',{});trace.finish('cancelled');failing=false;
 api.operationLog('fixture','completed');trace.begin('next',{});trace.finish('completed');await writer.dispose();
 assert.equal(warnings.length,2);const recovered=rows.filter(r=>r.stage==='recovered');assert.equal(recovered.length,2);
 assert.ok(recovered.every(r=>r.lostRecords>=2&&r.operationId));
 for(const row of recovered)assert.ok(warnings.some(line=>JSON.parse(line.slice(line.indexOf('{'))).operationId===row.operationId));
 const result=await api.scanPluginLogs(dir,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()+1000});
 assert.equal(result.coverage.droppedLines,recovered.reduce((n,r)=>n+r.lostRecords,0));
 assert.ok(result.findings.some(r=>r.category==='采集完整性'));assert.equal(result.general.recoveries,2);
 assert.doesNotMatch(JSON.stringify({warnings,rows}),/PRIVATE|\/private/);
});

test('3a1 初始化 RPC 失败自动释放进程和请求，保留 RPC 错误码及网络分类',async t=>{
 const rows=capture(t),diagnostics=[];
 const rpc=new api.CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd(),{TEST_FAIL_INITIALIZE:'1'},true);
 rpc.on('diagnostic',row=>diagnostics.push(row));t.after(()=>rpc.disposeAndWait());await assert.rejects(rpc.start(),{rpcCode:-32603});
 assert.equal(rpc.isClosed,true);assert.equal(rpc.transportSnapshot().localPendingRequests,0);assert.equal(rpc.telemetry,undefined);
 assert.ok(rows.some(r=>r.stage==='failed'&&r.rpcCode===-32603&&r.failureCategory==='network_or_service'));
 assert.doesNotMatch(JSON.stringify({rows,diagnostics}),/PRIVATE_TOKEN/);
});

test('3a1 主动关闭 RPC 记录取消，未结算请求全部拒绝且不误计为连接故障',async t=>{
 const rows=capture(t),rpc=new api.CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd());t.after(()=>rpc.disposeAndWait());
 await rpc.start();const pending=rpc.request('hang');assert.equal(rpc.transportSnapshot().oldestPendingRequest.method,'hang');
 rpc.dispose();await assert.rejects(pending,{name:'AbortError'});
 assert.equal(rpc.transportSnapshot().connectionState,'closed');assert.equal(rpc.transportSnapshot().localPendingRequests,0);
 assert.ok(rows.some(r=>r.operation==='rpc.process'&&r.stage==='cancelled'));
 assert.ok(!rows.some(r=>r.operation==='rpc.process'&&r.stage==='failed'));
});

test('3a1 历史格式错误与缺失/权限失败保留旧内容，断线只重读一次并记录恢复',async t=>{
 const rows=capture(t),store=new api.SessionStore(process.cwd(),()=>'/unused'),old={id:'thread',turns:[{id:'old',items:[]}],updatedAt:0};
 store.threads.set('thread',old);let page={};const rpc={isClosed:false,request:async method=>method==='thread/read'?{thread:{id:'thread',historyMode:'paginated'}}:page};store.connection=async()=>rpc;
 await assert.rejects(store.hydrate('thread'),{name:'SyntaxError'});assert.equal(store.threads.get('thread'),old);
 for(const code of ['ENOENT','EACCES']){store.connection=async()=>({isClosed:false,request:async()=>{throw fault(code);}});await assert.rejects(store.hydrate('thread'),{code});assert.equal(store.threads.get('thread'),old);}
 let connections=0;page={data:[{id:'new',items:[]}],nextCursor:null};
 store.connection=async()=>++connections===1?{isClosed:true,request:async()=>{throw fault('EPIPE');}}:rpc;
 await store.hydrate('thread');assert.equal(connections,2);assert.equal(store.countLines('thread'),1);
 const recovered=rows.find(r=>r.operation==='session.hydrate'&&r.stage==='recovered');assert.ok(recovered);
 assert.ok(rows.some(r=>r.stage==='completed'&&r.operationId===recovered.operationId));assert.doesNotMatch(JSON.stringify(rows),/PRIVATE/);
});

test('3a1 未观测等待保留未知归因，仅增加客户端状态且各阶段时间守恒',()=>{
 const rows=[];let now=0,state={connectionState:'connected',localPendingRequests:1};
 const trace=new api.PerformanceTrace(r=>rows.push(r),()=>now,()=>1000+now,()=>state);trace.begin('thread',{});
 now=30;trace.heartbeat();state={connectionState:'connected',localPendingRequests:0};now=80;trace.start('tool','tool');now=100;trace.end('tool');
 state={connectionState:'closed',localPendingRequests:0};now=110;trace.finish('cancelled');
 const r=rows.find(r=>r.event==='turn_summary');assert.equal(r.phasesMs.unobserved,90);assert.equal(r.phasesMs.tools,20);
 assert.deepEqual(r.unobservedEvidenceMs,{rpc_pending:30,no_active_backend_event:50,connection_closed:10});
 assert.equal(Object.values(r.phasesMs).reduce((a,b)=>a+b,0),r.elapsedMs);assert.equal(r.outcome,'cancelled');assert.equal(r.incompleteSpans,0);
});

test('3a1 页面上报通道失效后补发一次，图片失败可见且无正文或 URL',t=>{
 const {JSDOM}=require('jsdom'),dom=new JSDOM('<img src="https://private.invalid/?token=PRIVATE">'),previous=global.window;global.window=dom.window;
 t.after(()=>{global.window=previous;dom.window.close();});const sent=[],warnings=[];let fail=true;t.mock.method(console,'warn',s=>warnings.push(s));
 const report=api.installWebviewErrors(s=>{if(fail)throw fault('EPIPE');sent.push(s);});
 report('webview.runtime',new TypeError('PRIVATE'));report('webview.runtime',new TypeError('PRIVATE'));assert.equal(warnings.length,1);
 fail=false;window.dispatchEvent(new window.MessageEvent('message'));report('webview.runtime',new TypeError('PRIVATE'));assert.deepEqual(sent,['webview.runtime: TypeError']);
 window.document.querySelector('img').dispatchEvent(new window.Event('error'));assert.equal(sent[1],'webview.image.load.remote: Error');assert.equal(warnings.length,2);assert.doesNotMatch(JSON.stringify({sent,warnings}),/PRIVATE|private.invalid/);
});

test('3a1 损坏诊断记录显示列表不完整，修复后清除警告',async t=>{
 const dir=temporary(t);capture(t);const jobs=new api.DiagnosticJobs(dir,{pluginVersion:'test',windowId:'test',workspaceId:'test',workspaceName:'测试'},async()=>({report:'',findings:[],summary:{turns:0,tools:0,failures:0,longestTurnMs:0,versions:[]},sourceNote:'test'}),async()=>({status:'not_configured'}));
 t.after(()=>jobs.dispose());const record=await jobs.start();await Promise.all([...jobs.tasks]);
 const bad=path.join(dir,randomUUID()+'.json');fs.writeFileSync(bad,'{PRIVATE');assert.equal((await jobs.list())[0].id,record.id);assert.match(jobs.listWarning,/1 条/);
 fs.unlinkSync(bad);assert.equal((await jobs.list()).length,1);assert.equal(jobs.listWarning,undefined);
});

for(const mode of ['exit','timeout','progress','cancel'])test(`3a1 worker ${mode} 均有有界终态与资源释放`,async t=>{
 const dir=temporary(t),file=path.join(dir,'worker.cjs'),controller=new AbortController();
 fs.writeFileSync(file,mode==='exit'?'process.exit(2)':mode==='progress'?"require('node:worker_threads').parentPort.postMessage({type:'progress',message:'step'});setInterval(()=>{},1000)":'setInterval(()=>{},1000)');
 const run=api.workerRunner(file,dir,500),p=run(()=>{throw new Error('进度处理失败');},controller.signal);if(mode==='cancel')controller.abort();
 await assert.rejects(p,mode==='exit'?/未完成（2）/:mode==='timeout'?/扫描超时/:mode==='progress'?/进度处理失败/:/中断/);
});

test('3a1 非法诊断设置明确提示，合法本地规则不请求模型目录',async t=>{
 const rows=capture(t);const invalid=await api.loadDiagnosticConfiguration({engine:'bad'},{model:'selected',effort:'high'},async()=>[]);
 assert.match(invalid.error,/设置无效/);assert.equal(invalid.options.model,'selected');assert.ok(rows.some(r=>r.operation==='diagnostics.configuration'&&r.stage==='failed'));
 const valid=await api.loadDiagnosticConfiguration({kind:'general',hours:24,engine:'rules'},{effort:'high'},()=>{throw new Error('不应查询');});assert.equal(valid.error,undefined);assert.equal(valid.options.engine,'rules');
});

test('3a1 压缩恢复过程中关闭只记录同一次取消，迟到结果不产生成功终态',async t=>{
 const rows=capture(t),p=new api.CodexProcess({codexPath:'/unused',cwd:process.cwd(),model:'selected',effort:'high',permissionMode:'default'},
  {emit(){},onPermission(){},onSessionId(){},onClose(){}});let release;
 p.busy=true;p.compactionRestore={model:'selected',effort:'high',pending:false,isError:false};p.rpc.request=()=>new Promise(r=>release=r);
 p.finish(false);p.dispose();release({});await new Promise(r=>setImmediate(r));
 const events=rows.filter(r=>r.operation==='compaction.restore');assert.deepEqual(events.map(r=>r.stage),['start','cancelled']);assert.equal(events[0].operationId,events[1].operationId);
 assert.deepEqual([p.opts.model,p.opts.effort,p.opts.permissionMode],['selected','high','default']);
});

test('3a1 旧速度报告读取损坏结构化行会标记不完整，而不是空报告成功',async t=>{
 const dir=temporary(t),day=new Date().toISOString().slice(0,10);fs.writeFileSync(path.join(dir,`codex-chat-${day}.log`),'[perf] {PRIVATE}\n');
 const {readPerformanceReport}=require('../dist/test/diagnosticsReport.js');const report=await readPerformanceReport(dir);
 assert.match(report,/1 条结构化记录损坏/);assert.doesNotMatch(report,/PRIVATE/);
});

test('3a1 额度接口失败保留缓存并限频，恢复日志沿用同一故障 ID',async t=>{
 const rows=capture(t),p=Object.create(api.ChatViewProvider.prototype),old={kind:'usage',weekPct:20},sent=[];let fail=true,calls=0;
 Object.assign(p,{usageInFlight:false,lastUsageAt:0,lastUsage:old,lastUsageUpdatedAt:Date.now()-1000,sessions:new Set([{}]),
  store:{read:async()=>{calls++;if(fail)throw Object.assign(new Error('failed to fetch codex rate limits: error sending request PRIVATE_TOKEN'),{rpcCode:-32603});return {rateLimits:{}};}},
  maybeNotifyUsage(){},handleEmit(){},post:(_c,e)=>sent.push(e)});
 const flush=()=>new Promise(r=>setImmediate(r));p.fetchUsage(true);await flush();assert.equal(p.lastUsage,old);assert.match(sent[0].message,/额度刷新失败/);
 p.fetchUsage();await flush();assert.equal(calls,1);fail=false;p.fetchUsage(true);await flush();assert.equal(calls,2);assert.equal(p.usageInFlight,false);
 const events=rows.filter(r=>r.operation==='account.usage');assert.deepEqual(events.map(r=>r.stage),['start','failed','start','completed','recovered']);assert.equal(events[1].operationId,events[4].operationId);assert.equal(events[1].failureId,events[4].failureId);assert.equal(events[1].failureCategory,'network_or_service');assert.doesNotMatch(JSON.stringify(rows),/PRIVATE/);
});

test('3a1 远程只读处理器同步抛错可回传失败，连接继续处理下一条请求',async t=>{
 const net=require('node:net'),{once}=require('node:events'),dir=temporary(t),rows=capture(t);fs.chmodSync(dir,0o700);
 fs.writeFileSync(path.join(dir,'bridge.json'),JSON.stringify({version:1,token:'1'.repeat(64)}),{mode:0o600});
 const server=net.createServer();await new Promise(r=>server.listen(path.join(dir,'bridge.sock'),r));fs.chmodSync(path.join(dir,'bridge.sock'),0o600);
 const connected=once(server,'connection');let fail=true;
 const client=new api.RemoteBridgeClient(dir,{windowId:'window',workspaceId:'project',label:'测试'},()=>{if(fail)throw fault('EIO');return Promise.resolve({accepted:true,result:[]});});
 t.after(()=>{client.dispose();server.close();});client.start();const [socket]=await connected;t.after(()=>socket.destroy());
 const frames=[],waiters=[];let buffer='';socket.on('data',data=>{buffer+=data;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),frame=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(waiters.length)waiters.shift()(frame);else frames.push(frame);}});
 const next=()=>frames.length?Promise.resolve(frames.shift()):new Promise(r=>waiters.push(r));await next();socket.write(JSON.stringify({kind:'registered',version:1})+'\n');
 const command={version:1,commandId:'cmd',deviceId:'phone',issuedAt:Date.now(),expiresAt:Date.now()+60000,target:{windowId:'window',workspaceId:'project',sessionId:''},operation:{kind:'session.list'}};
 const request=id=>socket.write(JSON.stringify({kind:'execute',id,command})+'\n');
 request('first');assert.deepEqual((await next()).reply,{accepted:false,error:'PLUGIN_OPERATION_FAILED'});fail=false;request('second');assert.equal((await next()).reply.accepted,true);
 assert.ok(rows.some(r=>r.operation==='remote.execute'&&r.stage==='failed'));assert.ok(rows.some(r=>r.operation==='remote.execute'&&r.stage==='completed'));assert.doesNotMatch(JSON.stringify(rows),/PRIVATE/);
});
