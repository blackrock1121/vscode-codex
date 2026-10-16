const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SessionStore}=require('../dist/test/codex/session.js');
const turn=(id)=>({id,items:[{type:'userMessage',content:[{type:'text',text:id}]}]});
function preparation(thread,readThread,pages=[]){
 const calls=[];let disposed=0;
 const ready=Promise.resolve({request:async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/fork')return {thread:structuredClone(thread)};
  if(method==='thread/read')return {thread:structuredClone(readThread)};
  if(method==='thread/turns/list')return pages.shift();
  assert.fail(method);
 }});
 return {ready,dispose:async()=>{disposed++;},calls,disposed:()=>disposed};
}
test('完整派生响应省掉 thread/read；分页响应直接拉分页，无重复元数据读取',async()=>{
 for(const mode of ['legacy','paginated','missing']){
  const store=new SessionStore('/tmp',()=>'/unused');
  const thread={id:'branch',historyMode:mode==='missing'?undefined:mode,turns:mode==='legacy'?[turn('leaf')]:undefined};
  const p=preparation(thread,{id:'branch',turns:[turn('leaf')]},[{data:[turn('earlier')],nextCursor:'page2'},{data:[turn('leaf')],nextCursor:null}]);
  assert.equal(await store.fork('source','leaf',p),'branch');
  assert.deepEqual(p.calls.map(c=>c.method),mode==='legacy'?['thread/fork']:mode==='paginated'?['thread/fork','thread/turns/list','thread/turns/list']:['thread/fork','thread/read','thread/read']);
  assert.equal(store.rewindLeafFor('branch',store.countLines('branch')),'leaf');
  assert.equal(p.disposed(),1);
 }
});
test('原会话、已存在及并发重复 ID 在写入前被拒绝，不删除任何会话',async()=>{
 const store=new SessionStore('/tmp',()=>'/unused');
 store.threads.set('existing',{id:'existing',turns:[turn('old')]});
 for(const id of ['source','existing','../invalid','']){
  const p=preparation({id,turns:[turn('leaf')]});
  await assert.rejects(store.fork('source','leaf',p),/重复|无效/);
  assert.deepEqual(p.calls.map(c=>c.method),['thread/fork']);assert.equal(p.disposed(),1);
 }
 const a=preparation({id:'branch',historyMode:'legacy',turns:[turn('leaf')]}),b=preparation({id:'branch',historyMode:'legacy',turns:[turn('leaf')]});
 const results=await Promise.allSettled([store.fork('source','leaf',a),store.fork('source','leaf',b)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal(store.threads.get('existing').turns[0].id,'old');
});
test('派生后读取返回其他会话 ID 时拒绝覆盖，且释放连接',async()=>{
 const store=new SessionStore('/tmp',()=>'/unused');
 store.threads.set('existing',{id:'existing',turns:[turn('old')]});
 const p=preparation({id:'branch'},{id:'existing',turns:[turn('leaf')]});
 await assert.rejects(store.fork('source','leaf',p),/不同的会话 ID/);
 assert.equal(store.threads.get('existing').turns[0].id,'old');
 assert.equal(store.findFile('branch'),undefined);
 assert.equal(p.disposed(),1);
});

test('会话列表跨页读取不能覆盖期间更新的完整历史',async()=>{
 const store=new SessionStore('/tmp',()=>'/unused');
 store.threads.set('source',{id:'source',turns:[turn('old')]});let calls=0;
 store.read=async()=>{
  if(++calls===1)return {data:[{id:'source',preview:'标题',turns:[]}],nextCursor:'page2'};
  store.threads.set('source',{id:'source',turns:[turn('old'),turn('new')]});
  return {data:[],nextCursor:null};
 };
 await store.refresh();assert.equal(store.countLines('source'),2);
 assert.equal(store.threads.get('source').preview,'标题');
});

test('列表与历史重复分页游标快速失败，保留已有缓存而不是无限读取',async()=>{
 const store=new SessionStore('/tmp',()=>'/unused');
 store.threads.set('source',{id:'source',turns:[turn('old')]});let reads=0;
 store.read=async()=>{assert.ok(++reads<=2);return {data:[],nextCursor:'repeat'};};
 await assert.rejects(store.refresh(),/分页游标重复/);assert.equal(store.countLines('source'),1);
 const p=preparation({id:'branch',historyMode:'paginated'},undefined,[{data:[turn('one')],nextCursor:'repeat'},{data:[turn('two')],nextCursor:'repeat'}]);
 await assert.rejects(store.fork('source','leaf',p),/分页游标重复/);
 assert.equal(p.disposed(),1);assert.equal(store.findFile('branch'),undefined);
});
