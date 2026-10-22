const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {once}=require('node:events');
const Module=require('node:module'),load=Module._load;
const vscode={window:{},workspace:{textDocuments:[],getConfiguration:()=>({get:(_key,fallback)=>fallback})}};
let api;try{Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};api=require('../dist/test/diagnostic-safety.js');}finally{Module._load=load;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-3a562940-')),rows=[];
 const writer=new api.DailyLogWriter(dir,{pluginVersion:'test',windowId:'test-window',hostId:'test-host'});
 api.setOperationLogSink(line=>{rows.push(JSON.parse(line.slice('[operation] '.length)));writer.write(line);});
 t.after(async()=>{api.setOperationLogSink();await writer.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 return {rows,writer,scan:async()=>{await writer.flush();return api.scanPluginLogs(dir,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()+1000});}};
}
function provider(read){
 const p=Object.create(api.ChatViewProvider.prototype),sent=[];
 Object.assign(p,{disposed:false,usageInFlight:false,lastUsageAt:0,lastUsage:{kind:'usage',weekPct:20},
  sessions:new Set([{}]),store:{read},maybeNotifyUsage(){},handleEmit(){},post:(_c,e)=>sent.push(e)});
 return {p,sent};
}
for(const [message,category]of [['401 Unauthorized PRIVATE_TOKEN','authentication'],['HTTP 403 PRIVATE_TOKEN','permission']])
test(`3a562940 ${category} 暂停无效轮询，手动成功后恢复且故障落盘可检出`,async t=>{
 const f=await fixture(t);let clock=Date.now(),calls=0,fail=true;
 t.mock.method(Date,'now',()=>clock);
 const {p,sent}=provider(async()=>{calls++;if(fail)throw Object.assign(new Error(message),{rpcCode:-32603,errorOrigin:'backend'});return {rateLimits:{}};});
 for(let i=0;i<480;i++){p.fetchUsage();await tick();clock+=180000;}
 assert.equal(calls,1);assert.equal(sent.length,1);assert.match(sent[0].message,/暂停自动查询/);
 assert.equal(p.lastUsage.weekPct,20);assert.equal(p.usageBlockedCategory,category);
 fail=false;p.fetchUsage(true);await tick();assert.equal(calls,2);assert.equal(p.usageBlockedCategory,undefined);
 clock+=180000;p.fetchUsage();await tick();assert.equal(calls,3);
 const failure=f.rows.find(r=>r.operation==='account.usage'&&r.stage==='failed'),recovery=f.rows.find(r=>r.operation==='account.usage'&&r.stage==='recovered');
 assert.equal(failure.failureCategory,category);assert.equal(failure.failureId,recovery.failureId);
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('account.usage')&&r.evidence.includes(category)));
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN/);
 t.diagnostic(JSON.stringify({scenario:category,pollTicks:480,beforeRequests:480,afterRequestsBeforeRecovery:1}));
});
test('3a562940 网络失败指数退避有上限，缓存可用且恢复重置退避',async t=>{
 const f=await fixture(t);let clock=Date.now(),calls=0,fail=true;t.mock.method(Date,'now',()=>clock);
 const {p}=provider(async()=>{calls++;if(fail)throw new Error('error sending request PRIVATE_TOKEN');return {rateLimits:{}};});
 for(let i=0;i<480;i++){p.fetchUsage();await tick();clock+=180000;}
 const attempts=calls;assert.ok(attempts<=53);assert.equal(p.usageFails,5);assert.equal(p.lastUsage.weekPct,20);
 assert.ok(f.rows.filter(r=>r.stage==='failed').every(r=>r.retryAfterMs<=1800000));
 fail=false;clock=p.usageRetryAt;p.fetchUsage();await tick();assert.equal(calls,attempts+1);assert.equal(p.usageFails,0);assert.equal(p.usageRetryAt,0);
 t.diagnostic(JSON.stringify({scenario:'network',pollTicks:480,beforeRequests:480,afterRequestsBeforeRecovery:attempts}));
});
test('3a562940 账号切换丢弃旧用量与旧错误，合并飞行中刷新；销毁后不重启',async t=>{
 const f=await fixture(t),hold=deferred();let calls=0;
 const {p,sent}=provider(async()=>{if(++calls===1)return hold.promise;return {rateLimits:{}};});
 p.fetchUsage(true);p.resetUsagePolling();p.resetUsagePolling();assert.equal(p.lastUsage,undefined);
 hold.reject(new Error('401 Unauthorized PRIVATE_TOKEN'));await tick();await tick();
 assert.equal(calls,2);assert.equal(p.usageInFlight,false);assert.equal(p.usageBlockedCategory,undefined);
 assert.equal(f.rows.filter(r=>r.operation==='account.usage'&&r.stage==='cancelled').length,1);
 assert.equal(f.rows.some(r=>r.stage==='failed'),false);assert.ok(sent.every(r=>r.kind==='usage'));
 p.disposed=true;p.fetchUsage(true);p.resetUsagePolling();assert.equal(calls,2);
});
test('3a562940 管理连接账号更新与登录成功触发恢复，旧连接与失败登录不触发',async t=>{
 await fixture(t);let changed=0;
 const s=new api.SessionStore(process.cwd(),()=>path.resolve('test/fake-codex.cjs'),()=>changed++);t.after(()=>s.dispose());
 const first=await s.connection();first.emit('notification',{method:'account/updated'});
 first.emit('notification',{method:'account/login/completed',params:{success:false}});
 first.emit('notification',{method:'account/login/completed',params:{success:true}});assert.equal(changed,2);
 await first.disposeAndWait();await s.connection();first.emit('notification',{method:'account/updated'});assert.equal(changed,2);
});
for(const event of ['notification','request'])test(`3a562940 ${event} 内部异常安全落盘并终结，挂起 RPC 不再等满超时`,async t=>{
 const f=await fixture(t),messages=[];
 const opts={codexPath:path.resolve('test/fake-codex.cjs'),cwd:process.cwd(),permissionMode:'default',model:'selected-model',effort:'high',speedMode:'fast',transportDiagnostics:false};
 const p=new api.CodexProcess(opts,{emit:e=>{messages.push(e);if(e.kind==='diag')f.writer.write(e.message);},onPermission(){},onSessionId(){},onClose(){}});
 t.after(()=>p.disposeAndWait());await p.rpc.start();p.busy=true;p.sessionId='thread';p.latency.begin('thread',{});
 const pending=p.rpc.request('hang'),rejected=assert.rejects(pending,{name:'AbortError'}),closed=once(p.rpc,'close');
 const started=performance.now();
 if(event==='notification')p.rpc.child.stdout.emit('data',JSON.stringify({method:'turn/completed',params:{}})+'\n');
 else {p.request=async()=>{throw Object.assign(new TypeError('PRIVATE_TOKEN'),{code:'EIO'});};p.rpc.child.stdout.emit('data',JSON.stringify({id:'request',method:'item/tool/call',params:{}})+'\n');}
 await rejected;await closed;
 assert.equal(p.rpc.isClosed,true);assert.equal(p.rpc.pending.size,0);assert.equal(p.isBusy,false);assert.equal(p.isExited,true);
 assert.equal(f.rows.filter(r=>r.operation===`process.${event}`&&r.stage==='failed').length,1);
 assert.equal(messages.filter(m=>m.kind==='error').length,1);
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes(`process.${event}`)));assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN/);
 assert.deepEqual([p.opts.model,p.opts.effort,p.opts.speedMode,p.opts.permissionMode],['selected-model','high','fast','default']);
 const next=new api.CodexRpc(opts.codexPath,opts.cwd);t.after(()=>next.disposeAndWait());await next.start();assert.deepEqual(await next.request('echo',{ok:true}),{ok:true});
 t.diagnostic(JSON.stringify({scenario:event,releaseMs:Math.round(performance.now()-started),previousPendingTimeoutMs:60000}));
});
test('3a562940 异步异常上报页面也失败时不会留下未处理拒绝',async t=>{
 const f=await fixture(t),p=new api.CodexProcess({codexPath:path.resolve('test/fake-codex.cjs'),cwd:process.cwd(),transportDiagnostics:false,permissionMode:'default'},
  {emit:e=>{if(e.kind==='error')throw new Error('PRIVATE_TOKEN');},onPermission(){},onSessionId(){},onClose(){}});
 t.after(()=>p.disposeAndWait());await p.rpc.start();p.request=async()=>{throw new TypeError('PRIVATE_TOKEN');};
 const closed=once(p.rpc,'close');p.rpc.emit('request',{id:'x',method:'item/tool/call'});await closed;
 assert.ok(f.rows.some(r=>r.operation==='process.error.delivery'&&r.stage==='failed'));assert.equal(p.isExited,true);
});
test('3a562940 通知重复点击共享打开操作，跨层失败为同一故障，恢复后可再点击',async t=>{
 const f=await fixture(t),router=new api.NotificationRouter(),hold=deferred();t.after(()=>router.dispose());let calls=0;
 const fault=Object.freeze(new Error('PRIVATE_TOKEN'));
 const url=await router.endpoint('session',()=>api.observeOperation('notification.focus',async()=>{calls++;await hold.promise;throw fault;}));
 const a=fetch(url,{method:'POST'}),b=fetch(url,{method:'POST'});
 // 让服务器收到两条请求后再释放；事件而非固定休眠作为同步屏障。
 let requests=0;const arrived=deferred();router.server.on('request',()=>{if(++requests===2)arrived.resolve();});
 await arrived.promise;hold.resolve();assert.equal((await a).status,500);assert.equal((await b).status,500);assert.equal(calls,1);
 const failures=f.rows.filter(r=>r.stage==='failed');assert.equal(failures.length,2);assert.equal(failures[0].failureId,failures[1].failureId);
 await router.endpoint('session',async()=>{calls++;});assert.equal((await fetch(url,{method:'POST'})).status,204);assert.equal(calls,2);
 const result=await f.scan();assert.equal(result.general.failureChains,1);assert.ok(result.findings.filter(r=>r.evidence.includes('notification.')).every(r=>r.category==='通知'));
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN/);
});
test('3a562940 HTTP 状态明确区分认证和访问拒绝，不猜测凭据过期',()=>{
 const payload=attributes=>({resourceLogs:[{scopeLogs:[{logRecords:[{attributes:Object.entries(attributes).map(([key,value])=>({key,value:typeof value==='number'?{intValue:String(value)}:{stringValue:value}}))}]}]}]});
 for(const [status,category]of [[401,'authentication'],[403,'permission']]){
  const row=api.transportDiagnostics(payload({'event.name':'codex.api_request','http.response.status_code':status,'error.message':'PRIVATE_TOKEN'}))[0];
  assert.equal(row.hasError,true);assert.equal(row.failureCategory,category);assert.equal(row.failureEvidence,'http_status');assert.doesNotMatch(JSON.stringify(row),/PRIVATE_TOKEN/);
 }
});
test('3a562940 同 callId 双观测合并，跨窗口、不同嵌套调用和缺标识不猜测合并',async t=>{
 const f=await fixture(t);
 const {GeneralAccumulator}=require('../dist/test/diagnostics/general.js'),a=new GeneralAccumulator();
 const perf={event:'span_end',kind:'tool',itemId:'call-a',traceId:'turn-a',outcome:'failed'},transport={event:'codex.tool_result',call_id:'call-a',traceId:'turn-a',success:false};
 for(const [i,row]of [perf,transport,{...transport,call_id:'nested'},{...transport,traceId:undefined}].entries())a.add('',row,{file:'test',line:i+1,windowId:'window'});
 a.add('',transport,{file:'test',line:5,windowId:'other-window'});
 const r=a.result();assert.equal(r.summary.errors,5);assert.equal(r.summary.correlatedToolErrors,4);assert.equal(r.summary.toolFailureChains,3);
 assert.match(r.report,/1 条缺少完整关联/);
 for(const row of [perf,transport])f.writer.write(`[perf] ${JSON.stringify(row)}`);
 const scanned=await f.scan();assert.equal(scanned.general.correlatedToolErrors,2);assert.equal(scanned.general.toolFailureChains,1);
});
