const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const Module=require('node:module'),load=Module._load;
const vscode={window:{},Uri:{joinPath:(...parts)=>({toString:()=>parts.join('/')})},ViewColumn:{Active:1}};
let api;try{Module._load=function(name,...args){return name==='vscode'?vscode:load.call(this,name,...args);};api=require('../dist/test/diagnostic-safety.js');}finally{Module._load=load;}
const {DailyLogWriter,CheckpointManager,DiagnosticJobs,CodexProcess,CodexRpc,scanPluginLogs,postWebviewMessage,setOperationLogSink,observeOperation}=api;
const error=code=>Object.assign(new Error('PRIVATE_PROMPT token=PRIVATE_TOKEN /private/secret'),{code});
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-03eb-')),health=[],rows=[];
 const logs=path.join(dir,'logs'),writer=new DailyLogWriter(logs,{pluginVersion:'0.1.144',windowId:'test-window',hostId:'test-host'},undefined,line=>health.push(line));
 setOperationLogSink(line=>{rows.push(JSON.parse(line.slice('[operation] '.length)));writer.write(line);});
 t.after(async()=>{setOperationLogSink();await writer.dispose();fs.rmSync(dir,{recursive:true,force:true});});
 const scan=async()=>{await writer.flush();await writer.flush();return scanPluginLogs(logs,()=>{},{kind:'general',hours:0,engine:'rules',toMs:Date.now()+1000});};
 const text=()=>fs.readdirSync(logs).filter(f=>f.endsWith('.log')).map(f=>fs.readFileSync(path.join(logs,f),'utf8')).join('');
 return {dir,logs,writer,health,rows,scan,text};
}

test('03eb 日志写盘失败保留批次，恢复后仅落盘一次且能被全面诊断检出',async t=>{
 const f=await fixture(t);const append=fs.promises.appendFile;let fail=true;
 t.mock.method(fs.promises,'appendFile',async(...args)=>{if(fail&&String(args[0]).startsWith(f.logs))throw error('ENOSPC');return append(...args);});
 f.writer.write('before-failure');await f.writer.flush();
 assert.equal(f.health.length,1);assert.match(f.health[0],/ENOSPC/);assert.doesNotMatch(f.health[0],/PRIVATE/);
 f.writer.write('after-failure');fail=false;const result=await f.scan();
 assert.equal((f.text().match(/before-failure/g)||[]).length,1);assert.equal((f.text().match(/after-failure/g)||[]).length,1);
 const events=f.health.map(line=>JSON.parse(line.slice('[logging] '.length)));
 assert.deepEqual(events.map(e=>e.stage),['failed','recovered']);assert.equal(events[0].operationId,events[1].operationId);
 assert.ok(result.findings.some(x=>x.category==='采集完整性'&&x.evidence.includes('ENOSPC')));assert.ok(result.general.recoveries>=1);
});

test('03eb 跨日部分写入成功后失败，重试不重放已写入日期',async t=>{
 const f=await fixture(t),append=fs.promises.appendFile;let calls=0;
 t.mock.method(fs.promises,'appendFile',async(...args)=>{if(++calls===2)throw error('EIO');return append(...args);});
 const yesterday=new Date();yesterday.setDate(yesterday.getDate()-1);
 f.writer.write('first-day-row',yesterday);f.writer.write('second-day-row');await f.writer.flush();await f.writer.flush();await f.writer.flush();
 assert.equal((f.text().match(/first-day-row/g)||[]).length,1);assert.equal((f.text().match(/second-day-row/g)||[]).length,1);
});

test('03eb 持续磁盘失败最多三次后台重试，反馈不递归且缓冲有界',async t=>{
 const f=await fixture(t);let calls=0;t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(fs.promises,'appendFile',async()=>{calls++;throw error('EACCES');});
 f.writer.write('pending');await f.writer.flush();
 for(let i=0;i<12;i++){t.mock.timers.tick(4000);if(f.writer.flushing)await f.writer.flushing;await immediate();}
 assert.equal(calls,4);assert.equal(f.health.length,1);assert.ok(f.writer.pendingBytes<1024*1024);
});

test('03eb 快照 EACCES 不能当成不存在，恢复不得删除原文件',async t=>{
 const f=await fixture(t),file=path.join(f.dir,'original.txt');fs.writeFileSync(file,'original');
 const cp=new CheckpointManager(path.join(f.dir,'checkpoints'));cp.setSession('session');const id=cp.beginTurn('PRIVATE_PROMPT',0);
 const read=fs.readFileSync;t.mock.method(fs,'readFileSync',function(...args){if(args[0]===file)throw error('EACCES');return read(...args);});
 cp.snapshotFile(file);cp.flush();fs.writeFileSync(file,'edited');const restored=cp.restore(id);
 assert.equal(read(file,'utf8'),'edited');assert.equal(restored.restoredFiles,0);assert.deepEqual(restored.skipped,[file]);
 const result=await f.scan();assert.ok(result.findings.some(x=>x.category==='快照与还原点'&&x.evidence.includes('permission')));assert.doesNotMatch(f.text(),/PRIVATE_PROMPT|PRIVATE_TOKEN|secret/);
});

test('03eb 检查点原子保存失败保留上次完整文件，恢复写入后数据可重新加载',async t=>{
 const f=await fixture(t),storage=path.join(f.dir,'checkpoints'),cp=new CheckpointManager(storage);cp.setSession('session');cp.beginTurn('first',0);cp.flush();
 const file=path.join(storage,fs.readdirSync(storage).find(name=>name.endsWith('.json'))),before=fs.readFileSync(file,'utf8'),rename=fs.renameSync;let fail=true;
 t.mock.method(fs,'renameSync',function(...args){if(fail&&args[1]===file)throw error('ENOSPC');return rename(...args);});
 cp.beginTurn('second',1);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.readdirSync(storage).some(name=>name.endsWith('.tmp')),false);
 fail=false;cp.flush();const recovered=new CheckpointManager(storage);recovered.setSession('session');assert.equal(recovered.list().length,2);
 assert.ok(f.rows.some(r=>r.operation==='checkpoint.persist'&&r.stage==='failed'));
});

const scope={pluginVersion:'0.1.144',windowId:'test',workspaceId:'test',workspaceName:'测试'};
const output={report:'本地证据',findings:[],summary:{turns:0,tools:0,failures:0,longestTurnMs:0,versions:[]},sourceNote:'测试'};
test('03eb 诊断更新权限失败立即返回，不误作锁竞争循环四十次',async t=>{
 const f=await fixture(t),jobs=new DiagnosticJobs(path.join(f.dir,'jobs'),scope,async()=>output,async()=>({status:'not_configured'}));
 t.after(()=>jobs.dispose());let calls=0;const open=fs.promises.open;
 t.mock.method(fs.promises,'open',async(...args)=>{if(String(args[0]).endsWith('.update.lock')){calls++;throw error('EACCES');}return open(...args);});
 await assert.rejects(observeOperation('diagnostics.update',()=>jobs.update(randomUUID(),()=>{})),{code:'EACCES'});assert.equal(calls,1);
 const result=await f.scan();assert.ok(result.findings.some(r=>r.evidence.includes('diagnostics.update')&&r.evidence.includes('EACCES')));
});

test('03eb 诊断目录读取失败可见，损坏记录不会隐藏其余记录，中断和成功均有终态',async t=>{
 const f=await fixture(t),dir=path.join(f.dir,'jobs');let release;
 const jobs=new DiagnosticJobs(dir,scope,(_p,signal)=>new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(error('ABORT_ERR')));}),async()=>({status:'not_configured'}));
 t.after(()=>jobs.dispose());const first=await jobs.start();release(output);await Promise.all([...jobs.tasks]);
 assert.equal((await jobs.get(first.id)).status,'completed');
 const second=await jobs.start();await jobs.cancel(second.id);await Promise.all([...jobs.tasks]);assert.equal((await jobs.get(second.id)).status,'interrupted');
 assert.ok(f.rows.some(r=>r.operation==='diagnostics.execute'&&r.diagnosticId===second.id&&r.stage==='cancelled'));
 assert.ok(!f.rows.some(r=>r.operation==='diagnostics.execute'&&r.diagnosticId===second.id&&r.stage==='failed'));
 fs.writeFileSync(path.join(dir,randomUUID()+'.json'),'{PRIVATE_TOKEN');assert.equal((await jobs.list()).length,2);
 const readdir=fs.promises.readdir;let fail=true;t.mock.method(fs.promises,'readdir',async(...args)=>{if(fail&&args[0]===dir)throw error('EACCES');return readdir(...args);});
 await assert.rejects(jobs.list(),{code:'EACCES'});fail=false;assert.equal((await jobs.list()).length,2);
 const result=await f.scan();assert.ok(result.findings.some(r=>r.evidence.includes('diagnostics.list')));assert.ok(result.findings.some(r=>r.evidence.includes('invalid_data')));assert.doesNotMatch(f.text(),/PRIVATE/);
});

test('03eb Webview 关闭、拒绝和恢复由一个边界处理，不产生未捕获拒绝',async t=>{
 const f=await fixture(t);let mode='reject';const target={postMessage:()=>mode==='reject'?Promise.reject(error('EPIPE')):Promise.resolve(mode==='ok')};
 assert.equal(await postWebviewMessage(target,{body:'PRIVATE_PROMPT'}),false);assert.equal(await postWebviewMessage(target,{}),false);
 mode='ok';assert.equal(await postWebviewMessage(target,{}),true);
 const rows=f.rows.filter(r=>r.operation==='webview.delivery');assert.deepEqual(rows.map(r=>r.stage),['failed','recovered']);assert.equal(rows[0].operationId,rows[1].operationId);
 mode='closed';assert.equal(await postWebviewMessage(target,{}),false);mode='ok';await postWebviewMessage(target,{});
 const result=await f.scan();assert.ok(result.findings.some(r=>r.category==='页面脚本'));assert.equal(result.general.recoveries,2);assert.doesNotMatch(f.text(),/PRIVATE/);
});

test('03eb 模型目录重复分页会有限结束且不改用户模型或权限',async t=>{
 const f=await fixture(t),p=new CodexProcess({codexPath:'codex',cwd:process.cwd(),model:'selected-model',effort:'high',permissionMode:'default',speedMode:'fast',compactionAutoValidate:false},
 {emit(){},onPermission(){},onSessionId(){},onClose(){}});t.after(()=>p.disposeAndWait());let calls=0;
 p.rpc.request=async()=>{calls++;return {data:[],nextCursor:'same'};};await p.loadModels();assert.equal(calls,2);
 assert.deepEqual([p.opts.model,p.opts.effort,p.opts.permissionMode,p.opts.speedMode],['selected-model','high','default','fast']);
 assert.ok(f.rows.some(r=>r.operation==='models.load'&&r.stage==='failed'));
});

test('03eb RPC 通知监听器异常有安全终态并关闭连接，不逃逸到宿主事件循环',async t=>{
 const f=await fixture(t),rpc=new CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd());t.after(()=>rpc.disposeAndWait());await rpc.start();rpc.on('notification',()=>{throw error('EIO');});
 assert.doesNotThrow(()=>rpc.child.stdout.emit('data',JSON.stringify({method:'test/event',params:{body:'PRIVATE_PROMPT'}})+'\n'));
 assert.equal(rpc.closed,true);assert.ok(f.rows.some(r=>r.operation==='rpc.handler'&&r.stage==='failed'));assert.doesNotMatch(JSON.stringify(f.rows),/PRIVATE/);
 rpc.dispose();
});

test('03eb 页面异常仅上报错误类别并合并重复，不泄漏消息正文或页面 URL',t=>{
 const {JSDOM}=require('jsdom');const dom=new JSDOM('',{url:'https://private.invalid/?token=PRIVATE_TOKEN'});const previous=global.window;
 global.window=dom.window;t.after(()=>{global.window=previous;dom.window.close();});
 const sent=[];api.installWebviewErrors(message=>sent.push(message));
 for(let i=0;i<8;i++)window.dispatchEvent(new window.ErrorEvent('error',{message:'PRIVATE_PROMPT',error:new window.TypeError('PRIVATE_TOKEN')}));
 assert.deepEqual(sent,['webview.runtime: TypeError']);
 const event=new window.Event('unhandledrejection');event.reason=error('EACCES');window.dispatchEvent(event);
 window.dispatchEvent(new window.ErrorEvent('error',{message:'ResizeObserver loop completed with undelivered notifications.'}));
 assert.equal(sent.length,3);assert.match(sent[2],/ResizeObserver loop/);assert.doesNotMatch(sent.join(' '),/PRIVATE|private.invalid/);
});

test('03eb unknown 工具失败保留可观察异常类别与证据缺口，不复制输出、不凭工具名认定取消',()=>{
 const {failureType,PerformanceTrace}=require('../dist/test/codex/performanceTrace.js');
 assert.equal(failureType('TypeError: PRIVATE_PROMPT token=PRIVATE_TOKEN'),'TypeError');
 assert.equal(failureType('源码中提到了 TypeError: example'),undefined);
 const rows=[],trace=new PerformanceTrace(row=>rows.push(row));trace.begin('thread',{});
 for(const [id,tool,text]of [['js','js','ReferenceError: PRIVATE_TOKEN'],['ask','AskUserQuestion',undefined]]){
  trace.observe({method:'item/started',params:{threadId:'thread',turnId:'turn',item:{id,type:'dynamicToolCall',tool}}});
  trace.observe({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id,type:'dynamicToolCall',tool,success:false,status:'failed',contentItems:text?[{text}]:[]}}});
 }
 trace.finish('completed');const ends=rows.filter(r=>r.event==='span_end');
 assert.equal(ends[0].errorType,'ReferenceError');assert.equal(ends[0].failureEvidence,'tool_output');
 assert.equal(ends[1].outcome,'failed');assert.equal(ends[1].failureEvidence,'unavailable');
 assert.doesNotMatch(JSON.stringify(rows),/PRIVATE/);
});


test('03eb 诊断页面刷新失败与恢复同 ID 落盘，原报告仍能重新加载',async t=>{
 const f=await fixture(t),{EventEmitter}=require('node:events'),jobs=new EventEmitter();jobs.scope=scope;let fail=true;
 jobs.list=async()=>{if(fail)throw error('EACCES');return [{id:'record',status:'completed'}];};
 const sent=[],panel={webview:{postMessage:async m=>{sent.push(m);return true;},asWebviewUri:u=>u,onDidReceiveMessage:()=>{}},onDidDispose:()=>{},dispose(){}};
 vscode.window.createWebviewPanel=()=>panel;
 const page=new api.DiagnosticsPage({extensionUri:'extension'},jobs,async()=>{},async()=>{});t.after(()=>page.dispose());page.show(false);
 await page.message({type:'ready'});assert.equal(sent.at(-1).type,'error');fail=false;await page.message({type:'refresh'});
 assert.equal(sent.at(-1).type,'state');assert.equal(sent.at(-1).records[0].id,'record');
 const rows=f.rows.filter(r=>r.operation==='diagnostics.page.refresh');assert.deepEqual(rows.map(r=>r.stage),['failed','recovered']);assert.equal(rows[0].operationId,rows[1].operationId);
 const result=await f.scan();assert.ok(result.findings.some(r=>r.evidence.includes('diagnostics.page.refresh')));assert.ok(result.general.recoveries);assert.doesNotMatch(f.text(),/PRIVATE/);
});

test('03eb 业务批次已写入但丢弃计数写入失败时，计数仍可单独重试',async t=>{
 const f=await fixture(t),append=fs.promises.appendFile;let fail=true;
 t.mock.method(fs.promises,'appendFile',async(...args)=>{if(fail&&String(args[1]).includes('droppedLines='))throw error('ENOSPC');return append(...args);});
 for(let i=0;i<100;i++)f.writer.write('x'.repeat(32768));
 await f.writer.flush();await f.writer.flush();assert.ok(f.writer.dropped>0);
 fail=false;await f.writer.flush();await f.writer.flush();
 assert.match(f.text(),/droppedLines=\d+/);assert.equal(f.writer.dropped,0);assert.deepEqual(f.health.map(line=>JSON.parse(line.slice('[logging] '.length)).stage),['failed','recovered']);
});
