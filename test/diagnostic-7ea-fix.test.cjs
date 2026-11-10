const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {randomUUID} = require('node:crypto');
const {EventEmitter} = require('node:events');
const Module = require('node:module'), load = Module._load;
let api;
try {
  Module._load = function(name, ...args) { return name === 'vscode' ? {window:{}, Uri:{}, ViewColumn:{}} : load.call(this, name, ...args); };
  api = require('../dist/test/diagnostic-safety.js');
} finally { Module._load = load; }
const tick = () => new Promise(resolve => setImmediate(resolve));
const privateError = code => Object.assign(new Error('PRIVATE_PROMPT /private/secret token=PRIVATE_TOKEN'), {code});
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-7ea-')), rows = [];
  const writer = new api.DailyLogWriter(path.join(dir, 'logs'), {pluginVersion:require('../package.json').version, windowId:'test', hostId:'test'});
  api.setOperationLogSink(line => { rows.push(JSON.parse(line.slice('[operation] '.length))); writer.write(line); });
  t.after(async () => { api.setOperationLogSink(); await writer.dispose(); fs.rmSync(dir, {recursive:true, force:true}); });
  return {dir, rows, async scan() {
    await writer.flush(); await writer.flush();
    const logs = fs.readdirSync(path.join(dir, 'logs')).map(f => fs.readFileSync(path.join(dir, 'logs', f), 'utf8')).join('');
    assert.doesNotMatch(logs, /PRIVATE_PROMPT|PRIVATE_TOKEN|\/private\/secret/);
    return api.scanPluginLogs(path.join(dir, 'logs'), () => {}, {kind:'general', hours:0, engine:'rules', toMs:Date.now()+1000});
  }};
}
function record() {
  return {id:randomUUID(), status:'completed', trackingSchema:1, createdAt:Date.now(), updatedAt:Date.now(), pluginVersion:'0.1.208', findings:[
    {id:'test', fingerprint:'7ea:test', title:'测试', severity:'warning', evidence:'测试', recommendation:'复验', traceIds:[]}
  ]};
}
test('7ea 回报导入失败去重落盘，合法新修订明确恢复且全面诊断检出', async t => {
  const f = await fixture(t), ledger = new api.DiagnosticLedger(f.dir), r = record();
  const batch = await ledger.begin(r); await ledger.bind(batch.batchId, 'session');
  fs.writeFileSync(ledger.receiptPath(batch.batchId), '{PRIVATE_TOKEN');
  for (let i=0; i<3; i++) assert.match((await ledger.sync([r])).get(r.id).batch.error, /JSON/);
  const failure = f.rows.filter(x => x.operation === 'diagnostics.receipt.validate' && x.stage === 'failed');
  assert.equal(failure.length, 1);
  const view = (await ledger.sync([r])).get(r.id);
  fs.writeFileSync(ledger.receiptPath(batch.batchId), JSON.stringify({schema:1, diagnosticId:r.id, batchId:batch.batchId, revision:1,
    results:[{issueId:view.issues[0].id, outcome:'not_a_bug', reason:'测试结论'}]}));
  assert.equal((await ledger.sync([r])).get(r.id).batch.error, undefined);
  const recovery = f.rows.find(x => x.operation === 'diagnostics.receipt.validate' && x.stage === 'recovered');
  assert.equal(recovery.previousFailureId, failure[0].failureId);
  await ledger.sync([r]);
  assert.equal(f.rows.filter(x => x.operation === 'diagnostics.receipt.validate').length, 2);
  const scanned = await f.scan(); assert.ok(scanned.findings.some(x => x.evidence.includes('diagnostics.receipt.validate')));
  assert.ok(scanned.general.recoveries >= 1);
});
test('7ea 台账读写失败立即传播，锁关闭失败仍释放锁且不覆盖主错误，下一次可恢复', async t => {
  const f = await fixture(t), ledger = new api.DiagnosticLedger(f.dir), r = record();
  await ledger.sync([r]);
  const read = fs.promises.readFile, open = fs.promises.open;
  let fail = true, calls = 0;
  t.mock.method(fs.promises, 'readFile', async (...args) => {
    if (fail && String(args[0]).endsWith('ledger.json')) { calls++; throw privateError('EACCES'); }
    return read(...args);
  });
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('ledger.lock')) {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); if(fail) throw privateError('EIO'); };
    }
    return handle;
  });
  await assert.rejects(ledger.sync([r]), {code:'EACCES'}); assert.equal(calls,1);
  assert.equal(fs.existsSync(path.join(ledger.dir,'ledger.lock')),false);
  fail=false; assert.equal((await ledger.sync([r])).get(r.id).issues.length,1);
  const scanned=await f.scan();assert.ok(scanned.findings.some(x=>x.evidence.includes('diagnostics.ledger')));
});
class Socket extends EventEmitter {
  readyState=1; callback; sent=[];
  pause(){} resume(){}
  send(data, _options, callback){this.sent.push(data);this.callback=callback;}
  close(code=1000){if(this.readyState===3)return;this.readyState=3;this.emit('close',code,Buffer.alloc(0));}
  terminate(){this.close(1006);}
}
test('7ea WebSocket 正常响应、写入失败与关闭竞争有独立终态，取消代码不自动豁免', async t => {
  const f=await fixture(t), routes=[];
  const relay=await api.CompactionRelay.start('http://127.0.0.1:1',()=>({model:'target',effort:'high'}),r=>routes.push(r));
  t.after(()=>relay.close());
  const pairs=[];
  for(const scenario of ['success','failure','client_close','upstream_close','relay_close']) {
    const client=new Socket(),upstream=new Socket(),id=randomUUID();pairs.push({client,upstream});
    relay.websocket({headers:{}},new URL('http://127.0.0.1/responses'),client,upstream,id);
    client.emit('message',Buffer.from(JSON.stringify({type:'response.create',model:'source',input:[{type:'compaction_trigger'}]})),false);
    await tick();assert.equal(typeof upstream.callback,'function');
    if(scenario==='success') {
      upstream.callback();await tick();upstream.emit('message',Buffer.from(JSON.stringify({type:'response.completed',response:{id:'r',output:[]}})),false);
      client.callback();client.close();
      assert.ok(routes.some(r=>r.connectionId===id&&r.stage==='response'&&r.outcome==='completed'));
    } else {
      if(scenario==='client_close') client.close(1000);
      if(scenario==='upstream_close') upstream.close(1006);
      if(scenario==='relay_close') relay.close();
      upstream.callback(privateError('ECANCELED'));await tick();
      const rows=f.rows.filter(r=>r.connectionId===id&&r.operation==='relay.websocket.write');
      assert.equal(rows.length,1);
      assert.equal(rows[0].stage,['client_close','relay_close'].includes(scenario)?'cancelled':'failed');
      const terminal=routes.filter(r=>r.connectionId===id&&r.stage==='response');assert.equal(terminal.length,1);
      assert.equal(terminal[0].outcome,['client_close','relay_close'].includes(scenario)?'cancelled':scenario==='failure'?'failed':'incomplete');
    }
  }
  const scanned=await f.scan();assert.ok(scanned.findings.some(x=>x.evidence.includes('relay.websocket.write')));
});
test('7ea 诊断超时与取消保持结构化来源；后端失败沿调用链保留 failureId', async t => {
  const f=await fixture(t);
  await assert.rejects(api.diagnosticWait(()=>new Promise(()=>{}),undefined,5),{code:'ETIMEDOUT',errorOrigin:'timeout'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(api.diagnosticWait(()=>{throw Error('不得执行');},controller.signal),{name:'AbortError'});
  const failureId=randomUUID(),rpc=new EventEmitter();rpc.start=async()=>{};rpc.disposeAndWait=async()=>{};
  rpc.request=async(method)=> {
    if(method==='config/read')return {config:{}};
    if(method==='thread/start')return {thread:{id:'thread'},model:'selected',reasoningEffort:'high'};
    throw Object.assign(privateError('EPIPE'),{rpcCode:-32603,errorOrigin:'backend',failureId,requestId:8});
  };
  const result=await api.analyzeWithModel(rpc,{report:'本地报告',findings:[]},{model:'selected',effort:'high'},f.dir,()=>{},new AbortController().signal);
  assert.equal(result.modelAnalysis.status,'failed');assert.match(result.report,/本地报告/);
  const failure=f.rows.find(r=>r.operation==='diagnostics.model'&&r.stage==='failed');
  assert.equal(failure.failureId,failureId);assert.equal(failure.rpcCode,-32603);assert.equal(failure.requestId,8);
  await f.scan();
});
test('7ea 会话退出观察派生连接清理拒绝，避免后台未处理 Promise',async t=>{
  const f=await fixture(t),store=new api.SessionStore(f.dir,()=> 'unused');
  store.preparations.add({dispose:async()=>{throw privateError('EIO');}});
  store.dispose();await tick();
  assert.equal(f.rows.filter(r=>r.operation==='session.fork.dispose'&&r.stage==='failed').length,1);
  const result=await f.scan();assert.ok(result.findings.some(r=>r.evidence.includes('session.fork.dispose')));
});
test('7ea 远端发布与观察故障分别记录，同阶段重复汇总且成功后关联恢复',async t=>{
  const f=await fixture(t);let fail=true;
  const adapter=new api.RemoteSessionAdapter({publish(){if(fail)throw privateError('EPIPE');}});
  const ctx={sessionId:'session'};
  adapter.publish('session',{});adapter.publish('session',{});
  adapter.observe(ctx,{kind:'status',label:null});
  const failed=f.rows.filter(r=>r.operation==='remote.adapter'&&r.stage==='failed');
  assert.deepEqual(failed.map(r=>r.phase),['publish','observe']);
  fail=false;adapter.publish('other-session',{});adapter.observe({sessionId:'other-session'},{kind:'status',label:'ready'});
  assert.equal(f.rows.filter(r=>r.stage==='recovered').length,0);
  adapter.publish('session',{});adapter.observe(ctx,{kind:'status',label:'ready'});
  const recovered=f.rows.filter(r=>r.operation==='remote.adapter'&&r.stage==='recovered');
  assert.equal(recovered.length,2);assert.equal(recovered[0].occurrenceCount,2);
  for(const r of recovered)assert.equal(r.previousFailureId,failed.find(f=>f.phase===r.phase).failureId);
  const result=await f.scan();assert.ok(result.general.recoveries>=2);
});
