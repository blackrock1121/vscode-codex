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
const scope={pluginVersion:'0.1.160',windowId:'test',workspaceId:'test',workspaceName:'测试'};
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-66f-')),logs=path.join(dir,'logs'),rows=[],health=[];
 const writer=new api.DailyLogWriter(logs,{pluginVersion:'0.1.160',windowId:'test',hostId:'test'},undefined,line=>health.push(line));
 api.setOperationLogSink(line=>{rows.push(JSON.parse(line.slice('[operation] '.length)));writer.write(line);});
 t.after(async()=>{api.setOperationLogSink();await writer.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 const scan=async()=>{await writer.flush();await writer.flush();return api.scanPluginLogs(logs,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()+1000});};
 return {dir,logs,rows,writer,health,scan};
}

test('66f 队列发送异常落盘且保留队首，明确恢复后只发送一次',async t=>{
 const f=await fixture(t),q=new api.SessionTaskQueue();const item=q.add({text:'PRIVATE_TOKEN',images:[],files:[],contexts:[],labels:[],imageUris:[]});
 let sends=0;await q.drain(()=>true,async()=>{sends++;throw fault('EPIPE');});
 assert.equal(q.paused,true);assert.equal(q.items[0],item);assert.equal(q.sending,undefined);
 await q.drain(()=>true,async()=>{sends++;return true;});assert.equal(sends,1);
 q.paused=false;await q.drain(()=>true,async()=>{sends++;return true;});assert.equal(q.items.length,0);
 const rows=f.rows.filter(r=>r.operation==='queue.dispatch');assert.deepEqual(rows.map(r=>r.stage),['start','failed','start','dispatched']);
 assert.ok(rows.every(r=>r.operationId===item.id));assert.doesNotMatch(JSON.stringify(rows),/PRIVATE/);
 assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('queue.dispatch')));
});

test('66f RPC 管道失败只有一个故障标识，并发请求各有编号；主动关闭不计错误',async t=>{
 const f=await fixture(t),rpc=new api.CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd());
 t.after(()=>rpc.disposeAndWait());await rpc.start();
 const a=rpc.request('hang'),b=rpc.request('hang'),results=Promise.allSettled([a,b]),closed=once(rpc,'close');
 rpc.child.stdin.emit('error',fault('EPIPE'));const failures=await results;await closed;
 const [x,y]=failures.map(r=>r.reason);assert.equal(x.failureId,y.failureId);assert.notEqual(x.requestId,y.requestId);
 assert.equal(x.processRunId,rpc.runId);assert.equal(x.errorOrigin,'transport');
 assert.equal(f.rows.filter(r=>r.operation==='rpc.process'&&r.stage==='failed').length,1);
 const end=f.rows.find(r=>r.operation==='rpc.process'&&r.stage==='end');assert.equal(end.phase,'stdin');assert.equal(end.failureId,x.failureId);
 const report=await f.scan();assert.equal(report.general.failureChains,1);assert.ok(report.general.correlatedErrors>=3);
 const normal=new api.CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd());await normal.start();
 const pending=normal.request('hang'),cancelled=assert.rejects(pending,{name:'AbortError'});await normal.disposeAndWait();await cancelled;
 assert.equal(f.rows.some(r=>r.processRunId===normal.runId&&(r.stage==='failed'||r.outcome==='failed')),false);
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN|private\/prompt/);
});

test('66f 后端 RPC 拒绝与本地超时分别分类，连接仍可成功请求',async t=>{
 const f=await fixture(t),rpc=new api.CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd());t.after(()=>rpc.disposeAndWait());await rpc.start();
 await assert.rejects(rpc.request('thread/start',{}),e=>e.errorOrigin==='backend'&&e.rpcCode===-32602);
 await assert.rejects(rpc.request('hang',{},5),e=>e.errorOrigin==='timeout');
 assert.equal(rpc.isClosed,false);assert.deepEqual(await rpc.request('echo',{ok:true}),{ok:true});
 assert.equal(f.rows.filter(r=>r.operation==='rpc.process'&&r.stage==='start').length,1);
});

test('66f 关闭管理存储取消挂起读取，不在窗口退出后重建进程',async t=>{
 const f=await fixture(t),store=new api.SessionStore(process.cwd(),()=>path.resolve('test/fake-codex.cjs'));t.after(()=>store.dispose());
 await store.connection();const work=store.read('hang'),rejected=assert.rejects(work,{name:'AbortError'});await tick();await store.dispose();await rejected;
 assert.equal(f.rows.filter(r=>r.operation==='rpc.process'&&r.stage==='start').length,1);
 assert.equal(f.rows.some(r=>r.operation==='session.read'&&r.stage==='retry'),false);
});

test('66f 日志写入失败和超时均标明扫描缺口，恢复后批次仅落盘一次',async t=>{
 const f=await fixture(t),append=fs.promises.appendFile;let fail=true;
 t.mock.method(fs.promises,'appendFile',async(...args)=>{if(fail)throw fault('ENOSPC');return append(...args);});
 f.writer.write('unique-marker');const before=await api.flushLogWriters([f.writer]);assert.equal(before.status,'incomplete');assert.ok(before.pendingLines>0);
 const partial=api.checkLogFlush(output,before);assert.ok(partial.findings.some(f=>f.id==='logging-flush-incomplete'));
 fail=false;const after=await api.flushLogWriters([f.writer]);assert.equal(after.status,'completed');
 assert.ok((await f.scan()).findings.some(f=>f.category==='采集完整性'));
 const hold=deferred();t.mock.method(fs.promises,'appendFile',async(...args)=>{await hold.promise;return append(...args);});
 f.writer.write('in-flight-marker');const timeout=await api.flushLogWriters([f.writer],5);
 assert.equal(timeout.status,'timeout');assert.ok(timeout.pendingBytes>0);assert.ok(timeout.pendingLines>0);
 hold.resolve();assert.equal((await api.flushLogWriters([f.writer])).status,'completed');
 const text=fs.readdirSync(f.logs).map(n=>fs.readFileSync(path.join(f.logs,n),'utf8')).join('');assert.equal(text.split('unique-marker').length-1,1);
});

test('66f 诊断进度突发合并，终态不排在百条过时写盘之后',async t=>{
 const f=await fixture(t),hold=deferred();let progress,finish,writes=0;
 const jobs=new api.DiagnosticJobs(path.join(f.dir,'jobs'),scope,p=>{progress=p;return new Promise(r=>finish=r);},async()=>({status:'not_configured'}));
 t.after(()=>jobs.dispose());const started=await jobs.start();const save=jobs.saveInner.bind(jobs);
 jobs.saveInner=async record=>{if(record.status==='running'){writes++;await hold.promise;}return save(record);};
 for(let i=0;i<100;i++)progress('扫描 '+i);await tick();finish(api.checkLogFlush(output,{status:'incomplete',pendingWriters:1,failedWriters:1,pendingBytes:10,pendingLines:1,droppedLines:0}));
 hold.resolve();await Promise.all([...jobs.tasks]);const result=await jobs.get(started.id);
 assert.equal(result.status,'completed');assert.match(result.progress,/证据缺口/);assert.equal(writes,1);
 t.diagnostic(JSON.stringify({progressEvents:100,persistedProgressWrites:writes}));
});

test('66f 模型诊断定时进度抛错收敛为失败，关闭一次并保留本地证据',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setInterval']});
 const rpc=new EventEmitter();rpc.closed=0;rpc.start=()=>new Promise(()=>{});rpc.request=async()=>({});rpc.reject=()=>{};rpc.disposeAndWait=async()=>{rpc.closed++;rpc.emit('close');};
 let called=0;const result=api.analyzeWithModel(rpc,output,{kind:'general',hours:0,engine:'model',model:'chosen',effort:'high'},f.dir,()=>{if(++called===2)throw fault('EIO');},new AbortController().signal);
 await tick();t.mock.timers.tick(15000);const actual=await result;
 assert.equal(actual.modelAnalysis.status,'failed');assert.match(actual.report,/本地证据/);assert.equal(rpc.closed,1);
 assert.equal(rpc.listenerCount('close'),0);assert.ok((await f.scan()).findings.some(r=>r.evidence.includes('diagnostics.model.progress')));
});

test('66f 快照读取途中改写或删除文件不保留混合正文，稳定后可重新捕获',async t=>{
 const f=await fixture(t),root=path.join(f.dir,'work');fs.mkdirSync(root);const file=path.join(root,'source.txt');fs.writeFileSync(file,'a'.repeat(130000));
 const open=fs.promises.open;let mode='change';
 t.mock.method(fs.promises,'open',async(...args)=>{const handle=await open(...args);if(args[0]===file&&mode!=='stable'){
   const read=handle.read.bind(handle);let touched=false;handle.read=async(...params)=>{const result=await read(...params);if(!touched){touched=true;if(mode==='change')fs.appendFileSync(file,'changed');else fs.unlinkSync(file);}return result;};
 }return handle;});
 const changed=new api.WorkspaceSnapshot([root]);await changed.capture();assert.equal(changed.files.has(file),false);assert.equal(changed.skipReasons.get(file),'unreadable');
 mode='delete';const removed=new api.WorkspaceSnapshot([root]);await removed.capture();assert.equal(removed.skipReasons.get(file),'unreadable');
 mode='stable';fs.writeFileSync(file,'stable');const stable=new api.WorkspaceSnapshot([root]);await stable.capture();assert.equal(stable.files.get(file),'stable');
 fs.writeFileSync(file,'edited');assert.equal((await stable.changed()).get(file),'stable');
 const report=await f.scan();assert.ok(report.findings.some(r=>r.category==='快照与还原点'));
});

test('66f 图片读取在 stat 后增长也只读预算内字节，宿主明确缺失及恢复',async t=>{
 const f=await fixture(t),file=path.join(f.dir,'private.png');fs.writeFileSync(file,'small');const open=fs.promises.open;let readBytes=0,closed=false;
 t.mock.method(fs.promises,'open',async(...args)=>{const h=await open(...args);if(args[0]===file){const stat=h.stat.bind(h),read=h.read.bind(h),close=h.close.bind(h);
  h.stat=async()=>{const s=await stat();fs.appendFileSync(file,'x'.repeat(1000));return s;};h.read=async(...p)=>{const r=await read(...p);readBytes+=r.bytesRead;return r;};h.close=async()=>{closed=true;return close();};}return h;});
 await assert.rejects(api.readImageFile(file,100),{code:'EFBIG'});assert.equal(readBytes,101);assert.equal(closed,true);
 t.mock.restoreAll();const provider=Object.create(api.ChatViewProvider.prototype);provider.resolveWorkspaceFile=async()=>undefined;
 assert.equal(await provider.loadLocalImage('PRIVATE_TOKEN'),undefined);provider.resolveWorkspaceFile=async()=>file;
 assert.match(await provider.loadLocalImage('PRIVATE_TOKEN'),/^data:image\/png;base64,/);
 assert.deepEqual(f.rows.filter(r=>r.operation==='webview.image.read').map(r=>r.stage),['start','unavailable','start','completed']);
 assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE_TOKEN|private.png/);assert.ok((await f.scan()).findings.some(r=>r.category==='页面脚本'));
});

test('66f 启动后的遥测、压缩和通知服务器错误不会成为宿主未捕获异常',async t=>{
 const f=await fixture(t),telemetry=await api.LocalTelemetry.start(()=>{}),relay=await api.CompactionRelay.start('http://127.0.0.1:9',()=>undefined,()=>{}),router=new api.NotificationRouter(1);
 t.after(()=>{telemetry.close();relay.close();router.dispose();});await router.endpoint('test',async()=>{});
 for(const service of [telemetry,relay,router]){service.server.emit('error',fault('ECONNRESET'));service.server.emit('error',fault('EIO'));}
 for(const operation of ['telemetry.server','compaction.server','notification.server'])assert.equal(f.rows.filter(r=>r.operation===operation&&r.stage==='failed').length,2);
 assert.equal(telemetry.server.listening,true);assert.equal(relay.server.listening,true);assert.equal(router.server.listening,true);
 assert.ok((await f.scan()).general.errors>=6);assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE/);
});

test('66f 历史先失败仍等待快照收尾，连接先失败立即被观察并由调用方收敛',async t=>{
 await fixture(t);const snapshot=deferred(),started=deferred(),provider=Object.create(api.ChatViewProvider.prototype);
 provider.output={appendLine(){}};provider.config=()=>({get:(_k,def)=>def});provider.post=()=>{};provider.workspaceDirs=()=>[];provider.localSnapshotExcludedPaths=()=>[];provider.reportSnapshotSkips=()=>{};
 provider.ensureProcess=async()=>{throw fault('ECONNRESET');};provider.store={readTurnCount:async()=>{throw fault('EIO');}};
 t.mock.method(api.WorkspaceSnapshot.prototype,'capture',async()=>{started.resolve();await snapshot.promise;});
 const ctx={sessionId:'existing',sendSeq:1};let done=false;const work=provider.handleSendInner(ctx,'PRIVATE_TOKEN').finally(()=>done=true),rejection=assert.rejects(work,{code:'EIO'});
 await started.promise;await tick();assert.equal(done,false);snapshot.resolve();await rejection;assert.equal(done,true);assert.ok(ctx.snapshot);
});

test('66f 缺失工具计时不按零秒相加，有计时和无计时分别呈现',()=>{
 const {analyzePerformance}=require('../dist/test/diagnostics/analysis.js');
 const row={event:'span_end',kind:'tool',outcome:'failed',failureCategory:'missing_file'};
 const unknown=analyzePerformance([{...row,durationMs:null},{...row}]).findings[0];
 assert.match(unknown.evidence,/累计耗时 未观测/);assert.match(unknown.evidence,/2 次耗时未知/);
 const mixed=analyzePerformance([{...row,durationMs:null},{...row,durationMs:200}]).findings[0];
 assert.match(mixed.evidence,/1 次有计时/);assert.match(mixed.evidence,/0.2 秒/);assert.match(mixed.evidence,/1 次耗时未知/);
});
