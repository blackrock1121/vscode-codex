const {test}=require('node:test');
const assert=require('node:assert/strict');
const {CodexProcess}=require('../dist/test/codex/process.js');

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
 usage(80000);p.compact();await Promise.resolve();
 assert.equal(p.isBusy,true);
 assert.deepEqual(logs().map(x=>x.stage),['start','request_accepted']);
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
 p.compact();await Promise.resolve();note('item/completed',{item});
 assert.equal(logs().at(-1).serverElapsedMs,null);
 assert.equal(logs().at(-1).preTokens,null);
 p.compact();await Promise.resolve();
 note('turn/completed',{turn:{id:'skipped',status:'completed'}});
 assert.equal(logs().at(-1).outcome,'turn_ended_without_compaction_completed');
 assert.equal(logs().filter(x=>x.stage==='end').length,2);
 assert.equal(p.compactionTimer,undefined);
});

test('请求失败记录超时分类，关闭计时器，不把错误正文写入埋点',async t=>{
 const {p,logs}=fixture(t);
 p.rpc.request=async()=>{throw Error('Codex 请求超时：敏感数据');};
 p.compact();await Promise.resolve();await Promise.resolve();
 assert.equal(logs().find(x=>x.stage==='request_failed').timeout,true);
 assert.equal(logs().at(-1).outcome,'request_failed');
 assert.equal(p.isBusy,false);assert.equal(p.compactionTimer,undefined);
 assert.doesNotMatch(JSON.stringify(logs()),/敏感数据/);
});

test('完成后的迟到请求失败关联原压缩，不终止下一轮',async t=>{
 const {p,note,item,logs}=fixture(t);
 let reject;p.rpc.request=()=>new Promise((_,r)=>{reject=r;});
 p.compact();note('item/completed',{item});
 p.busy=true;
 reject(Error('晚到错误'));await Promise.resolve();await Promise.resolve();
 assert.equal(p.isBusy,true);
 assert.equal(logs().at(-1).stage,'request_failed');
 assert.equal(logs().at(-1).id,logs()[0].id);
 assert.equal(logs().filter(x=>x.stage==='end').length,1);
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
