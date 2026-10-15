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

function astraFixture(t){
 const f=fixture(t),p=f.p;
 p.activeModel='gpt-6-astra';p.activeEffort='medium';
 p.lastDispatched={model:'gpt-6-astra',effort:'high',speedMode:'default'};
 p.models=[{id:'gpt-6.1-sol',efforts:['medium','xhigh'],speedModes:['default','fast']}];
 return f;
}

test('Astra 手动压缩用 Sol xhigh，保持收费档位；原模型恢复前不放行消息',async t=>{
 for(const speed of ['default','fast']){
  const {p,note,item,logs,events}=astraFixture(t),calls=[];let release;
  await p.setSpeedMode(speed);
  p.rpc.request=async(method,params)=>{
   calls.push({method,params});
   if(method==='thread/settings/update'&&params.model==='gpt-6-astra')await new Promise(r=>{release=r;});
   return {};
  };
  p.compact();await flush();
  assert.equal(calls[0].params.model,'gpt-6.1-sol');assert.equal(calls[0].params.effort,'xhigh');
  assert.equal(calls[0].params.serviceTier,speed==='fast'?'priority':'default');
  assert.equal(logs().find(x=>x.stage==='model_selected').modelSource,'manual_override');
  note('item/completed',{item});
  assert.equal(p.isBusy,true);assert.equal(calls.length,2);
  note('turn/completed',{turn:{id:'compact-'+speed,status:'completed'}});await flush();
  assert.equal(p.sendUserMessage('不能提前发送'),false);
  assert.deepEqual(calls[2],{method:'thread/settings/update',params:{threadId:'test-session',model:'gpt-6-astra',effort:'high',serviceTier:speed==='fast'?'priority':'default'}});
  release({});await flush();
  assert.equal(p.isBusy,false);assert.equal(p.modelForNextTurn,'gpt-6-astra');
  assert.equal(events.filter(e=>e.kind==='result').length,1);
 }
});

test('压缩中切换会话配置，压缩档位保持不变，恢复不覆盖下一轮选择',async t=>{
 const {p,note,item}=astraFixture(t),calls=[];
 await p.setSpeedMode('fast');
 p.rpc.request=async(method,params)=>{calls.push({method,params});return {turn:{id:'next'}};};
 p.compact();await flush();
 await p.setSpeedMode('default');await p.setModel('gpt-6-luna');await p.setEffort('max');
 note('item/completed',{item});note('turn/completed',{turn:{id:'compact',status:'completed'}});await flush();
 assert.equal(calls[0].params.serviceTier,'priority');
 assert.equal(calls[2].params.serviceTier,'default');
 assert.equal(p.sendUserMessage('继续'),true);await flush();
 const next=calls.find(x=>x.method==='turn/start').params;
 assert.equal(next.model,'gpt-6-luna');assert.equal(next.effort,'max');assert.equal(next.serviceTier,'default');
});

test('压缩模型切换或启动失败也恢复原设置；恢复失败则关闭连接避免污染后续回答',async t=>{
 for(const failure of ['select','compact','restore']){
  const {p,note,item,events}=astraFixture(t),calls=[];
  p.rpc.request=async(method,params)=>{
   calls.push({method,params});
   if((failure==='select'&&params.model==='gpt-6.1-sol')||
      (failure==='compact'&&method==='thread/compact/start')||
      (failure==='restore'&&params.model==='gpt-6-astra'))throw Error('测试失败');
   return {};
  };
  p.compact();await flush();
  if(failure==='restore'){
   note('item/completed',{item});note('turn/completed',{turn:{id:'compact',status:'completed'}});
  }
  await flush();
  assert.ok(calls.some(x=>x.method==='thread/settings/update'&&x.params.model==='gpt-6-astra'));
  assert.equal(p.isBusy,false);assert.equal(p.isExited,failure==='restore');
  assert.equal(events.filter(e=>e.kind==='result').length,1);
  assert.equal(events.find(e=>e.kind==='result').isError,true);
  if(failure==='select')assert.equal(calls.some(x=>x.method==='thread/compact/start'),false);
  if(failure==='restore')assert.equal(p.sendUserMessage('不得继续使用临时模型'),false);
 }
});

test('沿用会话选项、未知原档位、缺失模型或不支持同一速度时不切换压缩模型',async t=>{
 for(const mode of ['session','unknown-effort','no-model','unsupported-speed','unsupported-effort']){
  const {p}=astraFixture(t),calls=[];
  if(mode==='session')p.opts.compactionMode='session';
  if(mode==='unknown-effort'){p.activeEffort=undefined;p.lastDispatched.effort='default';}
  if(mode==='no-model')p.models=[];
  if(mode==='unsupported-speed'){await p.setSpeedMode('fast');p.models[0].speedModes=['default'];}
  if(mode==='unsupported-effort')p.models[0].efforts=['medium'];
  p.rpc.request=async(method,params)=>{calls.push({method,params});return {};};
  p.compact();await flush();
  assert.equal(calls.length,2);assert.equal(calls[0].params.model,undefined);
  assert.equal(calls[0].params.serviceTier,mode==='unsupported-speed'?'priority':'default');
 }
});

test('从 CLI 返回值恢复未显式选择的推理档位，不把默认推理永久变成 xhigh',async t=>{
 const {p,note,item}=astraFixture(t),calls=[];
 p.lastDispatched.effort='default';p.activeEffort='low';
 p.rpc.request=async(method,params)=>{calls.push({method,params});return {};};
 p.compact();await flush();note('item/completed',{item});
 note('turn/completed',{turn:{id:'compact',status:'completed'}});await flush();
 assert.equal(calls[2].params.effort,'low');
});

test('等待模型目录时停止，不会在停止后切模型或发起压缩',async t=>{
 const {p}=astraFixture(t);let release;const calls=[];
 p.modelsReady=new Promise(r=>{release=r;});
 p.rpc.request=async(method,params)=>{calls.push({method,params});return {};};
 p.compact();await p.interrupt();release();await flush();
 assert.deepEqual(calls,[]);assert.equal(p.isExited,true);
});

test('未接入转发时，Astra 自动压缩保持原行为，不触发手动模型优化',t=>{
 const {p,note,item,logs}=astraFixture(t);p.busy=true;
 p.rpc.request=()=>{throw Error('自动压缩不应额外调用 RPC');};
 note('item/started',{item});note('item/completed',{item});
 assert.equal(logs().at(-1).model,'gpt-6-astra');assert.equal(p.compactionRestore,undefined);
 assert.equal(p.isBusy,true);
});

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

test('转发中的自动压缩保持本轮档位、忙碌状态和回答模型，结束后同轮继续',async t=>{
 for(const [running,next] of [['default','fast'],['fast','default']]){
  const {p,note,item,logs,events}=astraFixture(t);p.busy=true;
  p.lastDispatched.speedMode=running;
  p.rpc.request=()=>{throw Error('原生自动压缩不得调用手动 RPC 或切换会话模型');};
  await p.setSpeedMode(next);note('item/started',{item});
  p.compactionRouted({stage:'request',threadId:'test-session',fromModel:'gpt-6-astra',toModel:'gpt-6.1-sol',effort:'xhigh',serviceTier:running==='fast'?'priority':null,transport:'websocket'});
  note('item/completed',{item});
  const end=logs().at(-1);assert.equal(end.trigger,'auto');assert.equal(end.model,'gpt-6.1-sol');assert.equal(end.effort,'xhigh');
  assert.equal(end.modelSource,'transport_override');assert.equal(end.speedMode,running);
  assert.equal(p.modelForNextTurn,'gpt-6-astra');assert.equal(p.isBusy,true);assert.equal(p.compactionRestore,undefined);
  note('item/agentMessage/delta',{itemId:'continue',delta:'继续原任务'});assert.equal(events.at(-1).text,'继续原任务');
  note('turn/completed',{turn:{id:'answer',status:'completed'}});assert.equal(p.isBusy,false);
 }
});

test('已接入转发时手动压缩只同步收费档位，不临时切换主会话模型',async t=>{
 const {p,note,item}=astraFixture(t),calls=[];
 p.compactionRelay={close(){}};
 p.rpc.request=async(method,params)=>{calls.push({method,params});return {};};
 p.compact();await flush();
 assert.deepEqual(calls,[{method:'thread/settings/update',params:{threadId:'test-session',serviceTier:'default'}},{method:'thread/compact/start',params:{threadId:'test-session'}}]);
 note('item/completed',{item});note('turn/completed',{turn:{id:'manual',status:'completed'}});await flush();
 assert.equal(calls.length,2);assert.equal(p.compactionRestore,undefined);
});

test('自动优化只覆盖本线程连接配置；模型/档位按账号能力检查；退出关闭端口',async t=>{
 const {p}=astraFixture(t),calls=[];p.opts.env={OPENAI_BASE_URL:''};
 p.prepare=async()=>{};
 p.rpc.request=async(method,params)=>{
  calls.push({method,params});
  if(method==='config/read')return {config:{}};
  if(method==='getAuthStatus'){assert.deepEqual(params,{includeToken:false,refreshToken:false});return {authMethod:'chatgpt'};}
  if(method==='account/read')return {account:{type:'chatgpt'}};
  return {thread:{id:'test-session'},model:'gpt-6-astra',reasoningEffort:'medium'};
 };
 await p.start();const relay=p.compactionRelay;assert.ok(relay);
 const config=calls.find(c=>c.method==='thread/start').params.config;
 assert.match(config.openai_base_url,/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/);
 assert.equal(relay.canRoute(null),true);assert.equal(relay.canRoute('priority'),true);assert.equal(relay.canRoute('flex'),false);
 p.models[0].speedModes=['default'];assert.equal(relay.canRoute('priority'),false);assert.equal(relay.canRoute(null),true);
 p.models[0].efforts=['medium'];assert.equal(relay.canRoute(null),false);
 p.dispose();assert.throws(()=>relay.baseUrl,/关闭/);
 assert.equal(calls.some(c=>c.method==='config/value/write'),false);
});

test('沿用会话、自定义提供方/环境网关、子进程独有代理和读取失败时不覆盖网络配置',async t=>{
 for(const mode of ['session','custom-provider','base-url','env-base','env-proxy','read-failed']){
  const {p}=astraFixture(t);p.opts.env={OPENAI_BASE_URL:''};let config={};
  if(mode==='session')p.opts.compactionMode='session';
  if(mode==='custom-provider')config={model_provider:'custom'};
  if(mode==='base-url')config={openai_base_url:'https://example.invalid'};
  if(mode==='env-base')p.opts.env.OPENAI_BASE_URL='https://example.invalid';
  if(mode==='env-proxy')p.opts.env.HTTPS_PROXY='http://127.0.0.1:9';
  p.rpc.request=async method=>{if(mode==='read-failed')throw Error('失败');return method==='config/read'?{config}:{authMethod:'chatgpt'};};
  await p.prepareCompactionRelay();assert.equal(p.compactionRelay,undefined);
 }
});

test('关闭、启动失败与销毁会释放自动压缩连接，不留后台转发器',async t=>{
 for(const action of ['close','start-failed','disposeAndWait']){
  const {p}=astraFixture(t);let closed=0;p.compactionRelay={close(){closed++;}};
  if(action==='close')p.rpc.emit('close',1,Error('断开'));
  if(action==='start-failed'){p.prepare=async()=>{throw Error('初始化失败');};await assert.rejects(p.start());}
  if(action==='disposeAndWait')await p.disposeAndWait();
  assert.equal(closed,1);assert.equal(p.compactionRelay,undefined);
 }
});
