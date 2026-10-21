const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter,once}=require('node:events');
const Module=require('node:module'),load=Module._load;
const vscode={window:{},workspace:{textDocuments:[],getConfiguration:()=>({get:(_key,fallback)=>fallback})},Uri:{file:fsPath=>({fsPath})}};
let api;try{Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};api=require('../dist/test/diagnostic-safety.js');}finally{Module._load=load;}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const fault=code=>Object.assign(new Error('PRIVATE_TOKEN /private/prompt'),{code});
const output={report:'本地证据',findings:[],summary:{turns:0,tools:0,failures:0,longestTurnMs:0,versions:[]},sourceNote:'测试'};
const scope={pluginVersion:'0.1.162',windowId:'test',workspaceId:'test',workspaceName:'测试'};
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-87cc-')),logs=path.join(dir,'logs'),rows=[],health=[];
 const writer=new api.DailyLogWriter(logs,{pluginVersion:'0.1.162',windowId:'test',hostId:'test'},undefined,line=>health.push(line));
 api.setOperationLogSink(line=>{rows.push(JSON.parse(line.slice('[operation] '.length)));writer.write(line);});
 t.after(async()=>{api.setOperationLogSink();await writer.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 const scan=async()=>{await writer.flush();await writer.flush();return api.scanPluginLogs(logs,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()+1000});};
 return {dir,logs,rows,writer,health,scan};
}

test('87cc 同步断管立即关闭整条连接并释放并发等待，只读调用自动恢复一次',async t=>{
 const f=await fixture(t),store=new api.SessionStore(process.cwd(),()=>path.resolve('test/fake-codex.cjs'));t.after(()=>store.dispose());
 const first=await store.connection(),pending=first.request('hang'),rejected=assert.rejects(pending,e=>e.code==='EPIPE');
 first.child.stdin.write=()=>{throw fault('EPIPE');};
 assert.deepEqual(await store.read('echo',{ok:true}),{ok:true});await rejected;
 assert.equal(first.isClosed,true);assert.equal(first.pending.size,0);
 assert.equal(f.rows.filter(r=>r.operation==='rpc.process'&&r.stage==='failed').length,1);
 const recovery=f.rows.find(r=>r.operation==='session.read'&&r.stage==='recovered');assert.equal(recovery.previousProcessRunId,first.runId);
 const failures=f.rows.filter(r=>r.processRunId===first.runId&&r.stage==='failed');assert.equal(new Set(failures.map(r=>r.failureId)).size,1);
 assert.ok((await f.scan()).general.failureChains>=1);assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN/);
});
test('87cc 不可写管道明确终止；参数序列化失败不废弃健康连接',async t=>{
 const f=await fixture(t),rpc=new api.CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd());t.after(()=>rpc.disposeAndWait());await rpc.start();
 const cyclic={};cyclic.self=cyclic;await assert.rejects(rpc.request('echo',cyclic),{name:'TypeError',errorOrigin:'client'});
 assert.equal(rpc.isClosed,false);assert.deepEqual(await rpc.request('echo',{ok:true}),{ok:true});
 Object.defineProperty(rpc.child.stdin,'writable',{value:false});
 await assert.rejects(rpc.request('echo'),{code:'ERR_STREAM_DESTROYED'});assert.equal(rpc.isClosed,true);assert.equal(rpc.pending.size,0);
 assert.equal(f.rows.filter(r=>r.operation==='rpc.process'&&r.stage==='failed').length,1);
});
test('87cc 无效 RPC 输入归类为数据错误并落盘，不记录输入正文',async t=>{
 const f=await fixture(t),rpc=new api.CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd());t.after(()=>rpc.disposeAndWait());await rpc.start();
 await assert.rejects(rpc.request('invalid-envelope',{value:{secret:'PRIVATE_TOKEN'}}),{name:'SyntaxError'});
 assert.ok(f.rows.some(r=>r.operation==='rpc.process'&&r.failureCategory==='invalid_data'));
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('invalid_data')));assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN/);
});
test('87cc 日志缓冲丢弃计数带时间，24 小时扫描可检出并继续接收恢复日志',async t=>{
 const f=await fixture(t),fromMs=Date.now()-1000;
 for(let i=0;i<100;i++)f.writer.write('x'.repeat(32768));
 await f.writer.flush();await f.writer.flush();f.writer.write('after-overflow');await f.writer.flush();
 const result=await api.scanPluginLogs(f.logs,()=>{},{kind:'general',hours:24,engine:'rules',fromMs,toMs:Date.now()+1000});
 assert.ok(result.coverage.droppedLines>0);assert.ok(result.findings.some(r=>r.id==='log-coverage'));
 const text=fs.readdirSync(f.logs).map(n=>fs.readFileSync(path.join(f.logs,n),'utf8')).join('');assert.match(text,/\[\d{4}-\d\d-\d\dT[^\]]+\].*\[logging\] droppedLines=/);assert.match(text,/after-overflow/);
});
test('87cc 压缩迟到响应保留原轮次，未知和子线程请求不冒认当前轮次；不完整终态可检出',async t=>{
 const f=await fixture(t),events=[];
 const p=new api.CodexProcess({codexPath:'/unused',cwd:process.cwd(),permissionMode:'default'},{emit:e=>{events.push(e);if(e.kind==='diag')f.writer.write(e.message);},onPermission(){},onSessionId(){},onClose(){}});t.after(()=>p.dispose());
 p.sessionId='root';p.latency.begin('root',{});const first=p.latency.currentTraceId;
 const route={routeId:require('node:crypto').randomUUID(),threadId:'root',fromModel:'chosen',toModel:'compact',effort:'high',serviceTier:null,transport:'websocket'};
 p.compactionRouted({...route,stage:'request'});p.latency.finish('interrupted');p.latency.begin('root',{});
 p.compactionRouted({...route,stage:'response',outcome:'incomplete',reason:'upstream_closed'});
 p.compactionRouted({...route,stage:'response',outcome:'completed'});
 p.compactionRouted({...route,routeId:'child',threadId:'child',stage:'request'});
 const rows=events.filter(e=>e.kind==='diag'&&e.message.startsWith('[compaction_route]')).map(e=>JSON.parse(e.message.slice(19)));
 assert.equal(rows[1].traceId,first);assert.notEqual(rows[1].traceId,p.latency.currentTraceId);assert.equal(rows[2].traceId,null);assert.equal(rows[3].traceId,null);
 assert.ok(rows.every(r=>r.configurationScope==='request_only'&&r.sessionConfigurationChanged===false));
 const scan=await f.scan();assert.ok(scan.general.warnings>0);assert.ok(scan.findings.some(r=>r.evidence.includes('incomplete')));
});
for(const branch of ['running','notification','repair'])test(`87cc 跨窗口 ${branch} 旧快照不能覆盖锁内的新终态`,async t=>{
 const f=await fixture(t),dir=path.join(f.dir,'jobs');fs.mkdirSync(dir);const id=require('node:crypto').randomUUID(),file=path.join(dir,id+'.json');
 const record={id,scope,createdAt:Date.now(),ownerPid:99999999,status:branch==='running'?'running':'completed',progress:'旧状态',findings:[],notification:{status:branch==='notification'?'sending':'not_configured',ownerPid:99999999},repair:{status:branch==='repair'?'creating':'started',ownerPid:99999999}};
 fs.writeFileSync(file,JSON.stringify(record));const jobs=new api.DiagnosticJobs(dir,scope,async()=>output,async()=>({status:'not_configured'}));t.after(()=>jobs.dispose());
 const update=jobs.update.bind(jobs);let changed=false;
 jobs.update=async(...args)=>{if(!changed){changed=true;fs.writeFileSync(file,JSON.stringify({...record,status:'completed',progress:'新结果',ownerPid:process.pid,notification:{status:'sent'},repair:{status:'started',sessionId:'session'}}));}return update(...args);};
 const [actual]=await jobs.list();assert.equal(changed,true);assert.equal(actual.status,'completed');assert.equal(actual.progress,'新结果');assert.equal(actual.notification.status,'sent');assert.equal(actual.repair.status,'started');
});
test('87cc 小文件快照减少分配且增长保持有界读取，分项耗时落盘',async t=>{
 const f=await fixture(t),root=path.join(f.dir,'workspace');fs.mkdirSync(root);const file=path.join(root,'small.ts');fs.writeFileSync(file,'x'.repeat(500));
 const snapshot=new api.WorkspaceSnapshot([root]),alloc=Buffer.allocUnsafe;let allocated=0;
 t.mock.method(Buffer,'allocUnsafe',function(size){allocated+=size;return alloc(size);});
 assert.equal((await snapshot.read(file)).text.length,500);t.mock.restoreAll();assert.ok(allocated<2048);
 const open=fs.promises.open;let reads=0;
 t.mock.method(fs.promises,'open',async(...args)=>{const h=await open(...args);if(args[0]===file){const stat=h.stat.bind(h),read=h.read.bind(h);h.stat=async()=>{const s=await stat();fs.appendFileSync(file,'x'.repeat(10000));return s;};h.read=async(...p)=>{reads++;return read(...p);};}return h;});
 assert.equal((await snapshot.read(file)).reason,'unreadable');assert.ok(reads<=4,'增长后仍按块读取，不能逐字节循环');t.mock.restoreAll();
 await snapshot.capture();const row=f.rows.findLast(r=>r.operation==='snapshot.capture'&&r.stage==='completed');
 for(const field of ['inventoryMs','directoryMs','readMs','fingerprintMs'])assert.ok(Number.isFinite(row[field]));assert.ok((await f.scan()).coverage.records>0);
});
test('87cc 兼容压缩恢复记录实际提交配置，等待期间改设置不篡改恢复结果',async t=>{
 const f=await fixture(t),hold=deferred(),requests=[];
 const p=new api.CodexProcess({codexPath:'/unused',cwd:process.cwd(),model:'chosen',effort:'high',speedMode:'fast',permissionMode:'default'},{emit(){},onPermission(){},onSessionId(){},onClose(){}});t.after(()=>p.dispose());
 p.sessionId='root';p.busy=true;p.beganAt=Date.now();p.compactionRestore={model:'chosen',effort:'high',pending:false,isError:false};
 p.rpc.request=async(method,params)=>{requests.push({method,params});await hold.promise;return {};};
 p.finish(false);await p.setSpeedMode('default');hold.resolve();await tick();
 assert.equal(requests[0].params.serviceTier,'priority');
 const rows=f.rows.filter(r=>r.operation==='compaction.restore');assert.deepEqual(rows.map(r=>r.stage),['start','completed']);
 assert.ok(rows.every(r=>r.serviceTier==='priority'&&r.model==='chosen'&&r.effort==='high'&&r.processRunId===p.rpc.runId));
 assert.equal(p.opts.speedMode,'default');assert.equal(p.busy,false);
});
