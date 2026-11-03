const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const {randomUUID}=require('node:crypto');
const listeners=new Set();
const vscode={window:{state:{focused:false},onDidChangeWindowState:fn=>{listeners.add(fn);return {dispose:()=>listeners.delete(fn)};}},commands:{executeCommand:async()=>{}},workspace:{}};
const load=Module._load;let api;
try{Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};api=require(process.env.DIAGNOSTIC_4D94_API||'../dist/test/diagnostic-safety.js');}finally{Module._load=load;}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-4d94-')),rows=[];
 const writer=new api.DailyLogWriter(dir,{pluginVersion:'test',windowId:'test',hostId:'test'});
 api.setOperationLogSink(line=>{rows.push(JSON.parse(line.slice(12)));writer.write(line);});
 t.after(async()=>{api.setOperationLogSink();await writer.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,rows,scan:async()=>{await writer.flush();return api.scanPluginLogs(dir,()=>{},{kind:'performance',hours:0,engine:'rules'});}};
}

test('4d94 RPC 并发成功、失败、超时、取消均有同一开始结束标识和唯一终态',async t=>{
 const f=fixture(t),rpc=new api.CodexRpc(path.resolve('test/fake-codex.cjs'),f.dir,{TEST_FAIL_ACCOUNT:'1'});
 t.after(()=>rpc.disposeAndWait());await rpc.start();
 await Promise.all([rpc.request('echo',{private:'PRIVATE_BODY'}),assert.rejects(rpc.request('account/read')),assert.rejects(rpc.request('hang',{},10))]);
 const pending=assert.rejects(rpc.request('hang'));await rpc.disposeAndWait();await pending;
 const requests=f.rows.filter(r=>r.operation==='rpc.request');
 for(const start of requests.filter(r=>r.stage==='start')){const rows=requests.filter(r=>r.operationId===start.operationId);assert.equal(rows.length,2,'每次请求的 start/end 必须关联');assert.equal(rows[1].stage,'end');assert.equal(rows[1].requestId,start.requestId);}
 assert.equal(new Set(requests.filter(r=>r.stage==='start').map(r=>r.operationId)).size,5);
 assert.equal(rpc.transportSnapshot().localPendingRequests,0);
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('rpc.request')));assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_BODY/);
});

test('4d94 原连接保存新会话名称，失败不污染缓存，恢复可重试且不跨会话',async t=>{
 const f=fixture(t),p=new api.CodexProcess({cwd:f.dir,codexPath:'/unused',model:'gpt-6-astra',effort:'high',speedMode:'fast',permissionMode:'default'}, {emit(){},onClose(){},onPermission(){},onSessionId(){}});
 t.after(()=>p.dispose());p.sessionId='new-thread';let calls=0,fail=true;
 p.rpc.request=async(method,params)=>{calls++;assert.equal(method,'thread/name/set');assert.deepEqual(params,{threadId:'new-thread',name:'新标题'});if(fail)throw Object.assign(Error('PRIVATE_BODY'),{rpcCode:-32600});};
 const store=new api.SessionStore(f.dir,()=>'/unused');store.connection=async()=>assert.fail('新会话不能使用另一个管理进程');store.threads.set('new-thread',{name:'旧标题'});
 await assert.rejects(store.setCustomTitle('new-thread','新标题',p));assert.equal(store.threads.get('new-thread').name,'旧标题');fail=false;
 assert.equal(await store.setCustomTitle('new-thread','新标题',p),true);assert.equal(store.threads.get('new-thread').name,'新标题');
 await assert.rejects(store.setCustomTitle('other-thread','新标题',p));assert.equal(calls,2);
 assert.equal(p.opts.model,'gpt-6-astra');assert.equal(p.opts.effort,'high');assert.equal(p.opts.speedMode,'fast');assert.equal(p.opts.permissionMode,'default');
 p.dispose();await assert.rejects(store.setCustomTitle('new-thread','新标题',p));assert.equal(calls,2);
});

test('4d94 修复标题失败向页面反馈并落盘，后续成功有终态且不重发任务',async t=>{
 const f=fixture(t),provider=Object.create(api.ChatViewProvider.prototype),posted=[],ctx={ready:true,panel:{},webview:{},sessionId:'new-thread',proc:{currentSessionId:'new-thread'}};
 let fail=true,sends=0;
 Object.assign(provider,{sessions:new Set([ctx]),openSession:async()=>ctx,post:(_c,m)=>posted.push(m),handleSend:async()=>{sends++;return true;},refreshSessions(){},
 store:{setCustomTitle:async(id,title,owner)=>{assert.equal(owner,ctx.proc);if(fail)throw Object.assign(Error('PRIVATE_BODY'),{rpcCode:-32600});return true;}}});
 assert.equal(await provider.createDiagnosticRepairSession('修复','新标题'),'new-thread');await flush();
 assert.ok(posted.some(m=>m.kind==='notice'&&m.message.includes('名称未能保存')));assert.equal(sends,1);
 fail=false;await provider.createDiagnosticRepairSession('修复','新标题');await flush();assert.equal(sends,2);
 assert.deepEqual(f.rows.filter(r=>r.operation==='session.repair.title').map(r=>r.stage),['start','failed','start','completed']);
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('session.repair.title')));assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_BODY/);
});

test('4d94 聚焦命令挂起也在总预算内结束，迟到拒绝不重复导航，后续成功恢复',async t=>{
 const f=fixture(t);t.mock.timers.enable({apis:['setTimeout']});let rejectCommand,settled=false;
 const original=vscode.commands.executeCommand;t.after(()=>{vscode.commands.executeCommand=original;});
 vscode.window.state.focused=false;vscode.commands.executeCommand=()=>new Promise((_r,reject)=>{rejectCommand=reject;});
 const work=api.focusNotificationWindow().then(()=>{settled=true;return 'ok'},error=>{settled=true;return error.code});
 await flush();t.mock.timers.tick(2000);await flush();assert.equal(settled,true,'2 秒预算必须包括 executeCommand');
 assert.equal(await work,'ETIMEDOUT');assert.equal(listeners.size,0);
 const failure=f.rows.find(r=>r.operation==='notification.focus'&&r.stage==='failed');assert.ok(failure);
 rejectCommand(Error('PRIVATE_BODY'));await flush();assert.equal(f.rows.filter(r=>r.stage==='failed').length,1);
 vscode.commands.executeCommand=async()=>{};vscode.window.state.focused=true;await api.focusNotificationWindow();assert.equal(listeners.size,0);
 assert.equal(f.rows.find(r=>r.stage==='recovered').previousFailureId,failure.failureId);
 t.mock.timers.reset();assert.ok((await f.scan()).general.recoveredFailureChains>=1);assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_BODY/);
});

test('4d94 修复提示准确保留24小时、7天、全部及旧记录未知时间范围',()=>{
 const record={id:randomUUID(),createdAt:Date.now(),pluginVersion:'test',workspaceName:'test',diagnosticScope:'local-plugin-full',findings:[]};
 for(const hours of [24,168,0]){const prompt=api.diagnosticRepairPrompt({...record,options:{hours}},'报告');assert.match(prompt,hours?new RegExp(`最近 ${hours} 小时`):/全部保留日志/);if(hours)assert.doesNotMatch(prompt,/全部保留日志/);}
 const p=api.diagnosticRepairPrompt({...record,options:{hours:24,fromMs:0,toMs:86400000}},'报告');assert.match(p,/1970-01-01T00:00:00.000Z 至 1970-01-02T00:00:00.000Z/);assert.doesNotMatch(p,/全部保留日志/);
 assert.match(api.diagnosticRepairPrompt(record,'报告'),/时间范围见完整报告/);
});

test('4d94 模型摘要包含最长轮次用户等待和未发送类别，不把新失败分类降为未知',()=>{
 const a=new api.PerformanceAccumulator(),traceId=randomUUID();
 a.add({event:'turn_summary',traceId,elapsedMs:60019680,phasesMs:{user_wait:59538500,compaction:152950,unobserved:311580,PRIVATE_BODY:123}});
 for(const failureCategory of ['patch_mismatch','tool_session_missing'])a.add({event:'span_end',kind:'tool',outcome:'failed',failureCategory,durationMs:1});
 const result=a.result();assert.equal(result.summary.longestTurn.phasesMs.user_wait,59538500);assert.equal(result.summary.longestTurn.phasesMs.tools,undefined);
 assert.ok(result.findings.some(r=>r.id==='failure-patch_mismatch'));assert.ok(result.findings.some(r=>r.id==='failure-tool_session_missing'));
 result.findings.push(...Array.from({length:65},(_,i)=>({id:'extra-'+i,category:'后端组件异常',title:'超时',evidence:'已脱敏',recommendation:'核验',traceIds:[],severity:'warning'})));
 const prompt=api.diagnosticModelPrompt(result),payload=JSON.parse(prompt.slice(prompt.indexOf('{')));
 assert.equal(payload.performance.longestTurn.traceId,traceId);assert.ok(payload.evidenceOmittedByCategory['后端组件异常']>0);assert.doesNotMatch(prompt,/PRIVATE_BODY/);
 assert.equal(Object.values(payload.evidenceOmittedByCategory).reduce((a,b)=>a+b,0),payload.evidenceNotSent);
});
