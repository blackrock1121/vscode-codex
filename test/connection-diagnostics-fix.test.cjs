const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {CodexProcess}=require('../dist/test/codex/process.js');
const {CodexRpc}=require('../dist/test/codex/rpc.js');
const {performance}=require('node:perf_hooks');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(t,extra={}){
 const events=[],calls=[];
 const p=new CodexProcess({codexPath:path.resolve('test/fake-codex.cjs'),cwd:process.cwd(),
  permissionMode:'default',model:'gpt-6-astra',effort:'high',speedMode:'default',
  compactionAutoValidate:false,env:{OPENAI_BASE_URL:''},...extra},
  {emit:e=>events.push(e),onPermission(){},onSessionId(){},onClose(){}});
 p.rpc.start=async()=>{};
 t.after(()=>p.disposeAndWait());
 return {p,events,calls};
}

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

test('压缩配置与本机身份在预热时并行读取，迟到结果在发送前复用而不重复请求',async t=>{
 const {p,calls}=fixture(t),config=deferred(),identity=deferred();
 p.rpc.request=(method,params,timeout)=>{
  calls.push({method,params,timeout});
  if(method==='config/read')return config.promise;
  if(method==='getAuthStatus')return identity.promise;
  return Promise.resolve({data:[],nextCursor:null});
 };
 await p.prepare();
 assert.deepEqual(calls.slice(0,2).map(c=>c.method),['config/read','getAuthStatus']);
 assert.deepEqual(calls[1].params,{includeToken:false,refreshToken:false});
 assert.equal(calls[0].timeout,undefined,'可选启动预算不能充当 config/read 的真实 RPC 超时');
 config.resolve({config:{}});identity.resolve({authMethod:'chatgpt'});
 await flush();await p.prepareCompactionRelay();
 assert.ok(p.compactionRelay);
 assert.equal(calls.filter(c=>c.method==='config/read').length,1);
 assert.equal(calls.filter(c=>c.method==='getAuthStatus').length,1);
 assert.equal(p.opts.model,'gpt-6-astra');assert.equal(p.opts.effort,'high');
 assert.equal(p.opts.speedMode,'default');assert.equal(p.opts.permissionMode,'default');
});

test('两项独立只读探测的合成等待从相加变为并行等待',async t=>{
 const {p,calls}=fixture(t);let configFinished=false,identityStartedBeforeConfigFinished=false;
 p.rpc.request=(method,params,timeout)=>{
  calls.push({method,params,timeout});
  if(method==='config/read')return new Promise(resolve=>setTimeout(()=>{configFinished=true;resolve({config:{}});},120));
  if(method==='getAuthStatus'){
   identityStartedBeforeConfigFinished=!configFinished;
   return new Promise(resolve=>setTimeout(()=>resolve({authMethod:'chatgpt'}),120));
  }
  return Promise.resolve({data:[]});
 };
 const started=performance.now();await p.prepare();await p.prepareCompactionRelay();
 t.diagnostic(JSON.stringify({syntheticReadDelayMs:120,optionalPreparationMs:Math.round(performance.now()-started),
  configRequests:calls.filter(c=>c.method==='config/read').length,
  identityRequests:calls.filter(c=>c.method==='getAuthStatus').length}));
 assert.equal(identityStartedBeforeConfigFinished,true);
 assert.ok(p.compactionRelay);
});

test('启动只共享一个 200ms 可选优化预算，超预算不接管线程且迟到响应不创建转发器',async t=>{
 const {p,events,calls}=fixture(t),config=deferred(),identity=deferred();
 t.mock.timers.enable({apis:['setTimeout']});
 p.rpc.request=(method,params,timeout)=>{
  calls.push({method,params,timeout});
  if(method==='config/read')return config.promise;
  if(method==='getAuthStatus')return identity.promise;
  return Promise.resolve({data:[]});
 };
 await p.prepare();
 const preparing=p.prepareCompactionRelay();
 t.mock.timers.tick(200);await preparing;
 assert.equal(p.compactionRelay,undefined);
 assert.ok(events.some(e=>e.kind==='diag'&&e.message.includes('startup_budget_expired')));
 config.resolve({config:{}});identity.resolve({authMethod:'chatgpt'});await flush();
 assert.equal(p.compactionRelay,undefined);
 assert.equal(events.some(e=>e.kind==='diag'&&e.message.includes('"stage":"ready"')),false);
 assert.equal(calls.filter(c=>c.method==='config/read').length,1);
 assert.equal(calls.filter(c=>c.method==='getAuthStatus').length,1);
});

test('session 与自定义环境不发起压缩配置或身份探测',async t=>{
 for(const extra of [{compactionMode:'session'},{env:{OPENAI_BASE_URL:'https://example.invalid'}},
  {env:{OPENAI_BASE_URL:'',HTTPS_PROXY:'http://127.0.0.1:9'}}]){
  const {p,calls}=fixture(t,extra);
  p.rpc.request=async method=>{calls.push(method);return {data:[]};};
  await p.prepare();await p.prepareCompactionRelay();
  assert.deepEqual(calls,['model/list']);assert.equal(p.compactionRelay,undefined);
 }
});

test('配置读取失败明确记录原生回退，同一连接不原样重复失败',async t=>{
 const {p,events,calls}=fixture(t);
 p.rpc.request=async method=>{
  calls.push(method);if(method==='config/read')throw Error('只读配置失败');
  return method==='getAuthStatus'?{authMethod:'chatgpt'}:{data:[]};
 };
 await p.prepare();await p.prepareCompactionRelay();await p.prepareCompactionRelay();
 assert.equal(calls.filter(m=>m==='config/read').length,1);
 assert.equal(p.compactionRelay,undefined);
 assert.ok(events.some(e=>e.kind==='diag'&&e.message.includes('settings_unavailable')));
});

test('预取期间关闭连接不会迟到创建压缩转发器',async t=>{
 const {p,events}=fixture(t),config=deferred(),identity=deferred();
 p.rpc.request=method=>method==='config/read'?config.promise:
  method==='getAuthStatus'?identity.promise:Promise.resolve({data:[]});
 await p.prepare();const preparing=p.prepareCompactionRelay();
 p.dispose();config.resolve({config:{}});identity.resolve({authMethod:'chatgpt'});await preparing;
 assert.equal(p.compactionRelay,undefined);assert.equal(p.isExited,true);
 assert.equal(events.some(e=>e.kind==='diag'&&e.message.includes('"stage":"ready"')),false);
});

test('真实 RPC 超时释放待处理请求，后续调用仍成功且关闭清空未完成请求',async t=>{
 const rpc=new CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd());
 t.after(()=>rpc.disposeAndWait());await rpc.start();
 await assert.rejects(rpc.request('hang',{},10),/超时/);
 assert.equal(rpc.transportSnapshot().localPendingRequests,0);
 assert.deepEqual(await rpc.request('echo',{ok:true}),{ok:true});
 const pending=rpc.request('hang',{},60_000);
 const rejected=assert.rejects(pending,/连接已关闭/);
 await rpc.disposeAndWait();await rejected;
 assert.equal(rpc.transportSnapshot().localPendingRequests,0);
});
