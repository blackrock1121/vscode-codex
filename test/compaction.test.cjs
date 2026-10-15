const {test}=require('node:test');
const assert=require('node:assert/strict');
const {CodexProcess}=require('../dist/test/codex/process.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(t){
 const events=[];
 const p=new CodexProcess({codexPath:'/unused',cwd:process.cwd(),permissionMode:'default'},
  {emit:e=>events.push(e),onPermission:()=>{},onSessionId:()=>{},onClose:()=>{}});
 p.sessionId='test-session';p.activeModel='test-model';
 p.rpc.request=async()=>({});
 t.after(()=>p.dispose());
 const note=(method,params={})=>p.notification({method,params:{threadId:'test-session',...params}});
 const item={id:'compact-1',type:'contextCompaction'};
 const logs=()=>events.filter(e=>e.kind==='diag'&&e.message.startsWith('[compaction] ')).map(e=>JSON.parse(e.message.slice(13)));
 const usage=n=>note('thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:n},modelContextWindow:100000}});
 return {p,events,note,item,logs,usage};
}

test('手动压缩分别记录受理、开始、重试、用量和完成，完成前不释放会话',async t=>{
 const {p,events,note,item,logs,usage}=fixture(t);
 usage(80000);p.compact();await flush();
 assert.equal(p.isBusy,true);
 assert.deepEqual(logs().map(x=>x.stage),['start','settings_synced','request_accepted']);
 note('item/started',{item});
 note('error',{willRetry:true,error:{message:'包含敏感正文的服务端报错'}});
 usage(15000);
 note('item/completed',{item});
 const end=logs().at(-1);
 assert.equal(end.outcome,'completed');assert.equal(end.trigger,'manual');
 assert.equal(end.preTokens,80000);assert.equal(end.latestTokens,15000);
 assert.equal(end.contextWindow,100000);assert.equal(end.usageUpdates,1);
 assert.equal(end.model,'test-model');assert.equal(end.retries,1);
 assert.ok(end.elapsedMs>=end.serverElapsedMs);assert.ok(end.serverElapsedMs>=0);
 assert.equal(p.isBusy,false);assert.equal(p.compactionTimer,undefined);
 assert.doesNotMatch(JSON.stringify(logs()),/敏感正文/);
 note('turn/completed',{turn:{id:'compact-turn',status:'completed'}});
 assert.equal(logs().filter(x=>x.stage==='end').length,1);
 assert.equal(events.filter(e=>e.kind==='result').length,1);
});

test('自动压缩去重开始事件，定时记录等待，结束不终止回复且不伪造压缩后用量',t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const {p,events,note,item,logs,usage}=fixture(t);
 usage(80000);p.busy=true;
 note('item/started',{item});note('item/started',{item});
 t.mock.timers.tick(60000);
 assert.equal(logs().filter(x=>x.stage==='start').length,1);
 assert.equal(logs().filter(x=>x.stage==='server_started').length,1);
 assert.equal(logs().filter(x=>x.stage==='waiting').length,2);
 note('item/completed',{item});
 const end=logs().at(-1);
 assert.equal(end.trigger,'auto');assert.equal(end.latestTokens,null);assert.equal(end.usageUpdates,0);
 assert.equal(p.isBusy,true);assert.equal(events.some(e=>e.kind==='result'),false);
 const count=logs().length;t.mock.timers.tick(60000);assert.equal(logs().length,count);
 note('item/agentMessage/delta',{itemId:'reply',delta:'继续回复'});
 assert.equal(events.at(-1).text,'继续回复');
});

test('缺少开始或完成事件时不伪造服务端耗时或成功',async t=>{
 const {p,note,item,logs}=fixture(t);
 p.compact();await flush();note('item/completed',{item});
 assert.equal(logs().at(-1).serverElapsedMs,null);
 assert.equal(logs().at(-1).preTokens,null);
 p.compact();await flush();
 note('turn/completed',{turn:{id:'skipped',status:'completed'}});
 assert.equal(logs().at(-1).outcome,'turn_ended_without_compaction_completed');
 assert.equal(logs().filter(x=>x.stage==='end').length,2);
 assert.equal(p.compactionTimer,undefined);
});

test('请求失败记录超时分类，关闭计时器，不把错误正文写入埋点',async t=>{
 const {p,logs}=fixture(t);
 p.rpc.request=async method=>{if(method==='thread/compact/start')throw Error('Codex 请求超时：敏感数据');return {};};
 p.compact();await flush();
 assert.equal(logs().find(x=>x.stage==='request_failed').timeout,true);
 assert.equal(logs().at(-1).outcome,'request_failed');
 assert.equal(p.isBusy,false);assert.equal(p.compactionTimer,undefined);
 assert.doesNotMatch(JSON.stringify(logs()),/敏感数据/);
});

test('完成后的迟到请求失败关联原压缩，不终止下一轮',async t=>{
 const {p,note,item,logs}=fixture(t);
 let reject;p.rpc.request=method=>method==='thread/settings/update'?Promise.resolve({}):new Promise((_,r)=>{reject=r;});
 p.compact();await flush();note('item/completed',{item});
 p.busy=true;
 reject(Error('晚到错误'));await flush();
 assert.equal(p.isBusy,true);
 assert.equal(logs().at(-1).stage,'request_failed');
 assert.equal(logs().at(-1).id,logs()[0].id);
 assert.equal(logs().filter(x=>x.stage==='end').length,1);
});

test('手动压缩跟随当前会话速度，关闭快速后不会沿用上一轮的收费档位',async t=>{
 for(const [previous,selected,tier] of [['fast','default','default'],['default','fast','priority'],['default','default','default'],['fast','fast','priority']]){
  const {p,note,item,logs}=fixture(t),calls=[];
  p.lastDispatched={model:'test-model',effort:'high',speedMode:previous};
  p.rpc.request=async(method,params)=>{calls.push({method,params});return {};};
  await p.setSpeedMode(selected);p.compact();await flush();
  assert.deepEqual(calls,[
   {method:'thread/settings/update',params:{threadId:'test-session',serviceTier:tier}},
   {method:'thread/compact/start',params:{threadId:'test-session'}},
  ]);
  assert.equal(logs()[0].speedMode,selected);
  assert.equal(logs()[0].model,'test-model');assert.equal(logs()[0].effort,'high');
  note('item/completed',{item});
 }
});

test('自动压缩不另外同步或提档，运行中切换不改变本轮档位',async t=>{
 for(const [running,next] of [['default','fast'],['fast','default']]){
  const {p,note,item,logs}=fixture(t);
  p.lastDispatched={model:'test-model',effort:'high',speedMode:running};
  p.rpc.request=()=>{throw Error('自动压缩不应额外发送配置或压缩请求');};
  p.busy=true;await p.setSpeedMode(next);
  note('item/started',{item});note('item/completed',{item});
  assert.equal(logs().at(-1).speedMode,running);
  assert.equal(p.isBusy,true);
 }
});

test('速度同步失败时取消手动压缩，不降级为沿用旧档位',async t=>{
 const {p,events,logs}=fixture(t),calls=[];
 p.rpc.request=async method=>{calls.push(method);throw Error('不支持此方法 (-32601)');};
 p.compact();await flush();
 assert.deepEqual(calls,['thread/settings/update']);
 assert.equal(logs().at(-1).outcome,'settings_sync_failed');
 assert.equal(p.isBusy,false);assert.equal(p.compactionTimer,undefined);
 assert.match(events.find(e=>e.kind==='error').message,/无法同步会话速度配置.*压缩未启动/);
});

test('等待速度同步期间停止或销毁，不再触发压缩；重复点击只同步一次',async t=>{
 for(const action of ['interrupt','dispose']){
  const {p,logs}=fixture(t),calls=[];let release;
  p.rpc.request=(method)=>{calls.push(method);return new Promise(resolve=>{release=resolve;});};
  p.compact();p.compact();
  if(action==='interrupt')await p.interrupt();else p.dispose();
  release({});await flush();
  assert.deepEqual(calls,['thread/settings/update']);
  assert.equal(p.isExited,true);assert.equal(p.compactionTimer,undefined);
  assert.equal(logs().filter(x=>x.stage==='request_accepted').length,0);
 }
});

test('失败、停止、断开和销毁均记录结束并释放计时器',async t=>{
 for(const mode of ['failed','interrupted','connection_closed','disposed','disposeAndWait']){
  const {p,note,item,logs}=fixture(t);
  p.busy=true;note('item/started',{item});
  if(mode==='connection_closed')p.rpc.emit('close',1,Error('连接断开'));
  else if(mode==='disposed')p.dispose();
  else if(mode==='disposeAndWait')await p.disposeAndWait();
  else note('turn/completed',{turn:{id:mode,status:mode}});
  assert.equal(logs().at(-1).outcome,mode==='disposeAndWait'?'disposed':mode);
  assert.equal(p.compactionTimer,undefined);
  assert.equal(logs().filter(x=>x.stage==='end').length,1);
 }
});

test('压缩外及其他会话的事件不产生压缩埋点',t=>{
 const {p,note,item,logs}=fixture(t);
 note('error',{willRetry:true});
 p.notification({method:'item/started',params:{threadId:'other',item}});
 assert.deepEqual(logs(),[]);assert.equal(p.compactionTimer,undefined);
});

test('压缩记录用量明细、结构化错误类别及 HTTP 状态，不推测服务端排队时间',t=>{
 const {p,note,item,logs}=fixture(t);p.busy=true;
 note('item/started',{turnId:'turn-a',item});
 note('thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:900,inputTokens:800,cachedInputTokens:700,
  outputTokens:100,reasoningOutputTokens:0,privateText:'PRIVATE_USAGE'},modelContextWindow:100000}});
 note('error',{willRetry:true,error:{message:'PRIVATE_ERROR',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:502,extra:'PRIVATE'}}}});
 const retry=logs().at(-1);assert.equal(retry.errorCategory,'responseStreamDisconnected');assert.equal(retry.httpStatusCode,502);
 note('error',{willRetry:true,error:{codexErrorInfo:'serverOverloaded'}});
 assert.equal(logs().at(-1).errorCategory,'serverOverloaded');
 note('item/completed',{item});const end=logs().at(-1);
 assert.equal(end.turnId,'turn-a');assert.equal(end.itemId,'compact-1');
 assert.equal(end.latestUsage.cachedInputTokens,700);assert.equal(end.latestUsage.reasoningOutputTokens,0);
 assert.ok(end.firstUsageMs>=0);assert.equal(end.serverQueueMs,null);assert.equal(end.networkTransitMs,null);
 assert.equal(end.inferenceMs,null);assert.equal(end.timingScope,'client_observed_notifications');
 assert.doesNotMatch(JSON.stringify(logs()),/PRIVATE/);
});

test('批量延迟送达的遥测按源时间和线程关联旧压缩，进程指标不冒充单次压缩',t=>{
 const {p,note,item,events}=fixture(t);p.busy=true;note('item/started',{item});
 const sourceTimeMs=p.compactionTrace.startedWallMs;note('item/completed',{item});
 const event={type:'event',sourceTimeMs,'conversation.id':'test-session',event:'codex.sse_event'};
 const latest=()=>JSON.parse(events.filter(e=>e.kind==='diag'&&e.message.startsWith('[transport] ')).at(-1).message.slice(12));
 p.rpc.emit('diagnostic',event);assert.equal(latest().compactionId,1);
 p.rpc.emit('diagnostic',{...event,'conversation.id':'other'});assert.equal(latest().compactionId,null);
 p.rpc.emit('diagnostic',{...event,sourceTimeMs:sourceTimeMs-1});assert.equal(latest().compactionId,null);
 p.rpc.emit('diagnostic',{...event,type:'metric'});assert.equal(latest().compactionId,null);
 p.rpc.emit('diagnostic',{...event,sourceTimeMs:null});assert.equal(latest().compactionId,null);
});
