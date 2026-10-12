const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const path=require('node:path');
const {CodexRpc}=require('../dist/test/codex/rpc.js');
const {CodexProcess}=require('../dist/test/codex/process.js');
const executable=path.resolve('test/fake-codex.cjs');

async function client(t){
 const rpc=new CodexRpc(executable,process.cwd());
 t.after(()=>rpc.disposeAndWait());
 await rpc.start();return rpc;
}

test('JSONL 在初始化、大型工具输出和通知中保留 Unicode 分隔符及跨块 UTF-8',async t=>{
 const rpc=new CodexRpc(path.resolve('test/fake-codex.cjs'),process.cwd(),{TEST_UNICODE_INITIALIZE:'1'});
 t.after(()=>rpc.disposeAndWait());
 await rpc.start();
 const notification=once(rpc,'notification');
 const result=await rpc.request('unicode-output');
 assert.equal(result.text,'中文🙂\u2028行分隔符\u2029段分隔符\r\n'.repeat(8000));
 const [message]=await notification;
 assert.equal(message.method,'unicode/notification');
 assert.equal(message.params.text,'完整\u2028通知\u2029');
 assert.equal(rpc.isClosed,false);
 assert.equal((await rpc.request('model/list')).data[0].model,'test-model');
});

test('Unicode、控制字符和超长消息往返保持原样，空结果也能正常返回',{timeout:5000},async t=>{
 const rpc=await client(t);
 const text='中文🙂\u0085\u2028\u2029\r\n\t\u0000\\"'.repeat(10000);
 assert.deepEqual(await rpc.request('echo',{text}),{text});
 assert.equal(await rpc.request('echo',null),null);
 assert.equal(await rpc.request('echo',false),false);
});

test('测试假服务的输入按 LF 分帧，Unicode 字符不改变消息边界',()=>{
 const {PassThrough}=require('node:stream');
 const {readJsonl}=require('./jsonl.cjs');
 const stream=new PassThrough();const messages=[];
 readJsonl(stream,m=>messages.push(m));
 const value={text:'中文🙂\u2028\u2029\r\n'};
 const data=Buffer.from(JSON.stringify(value)+'\n'+JSON.stringify({id:2})+'\r\n');
 for(let i=0;i<data.length;i++)stream.write(data.subarray(i,i+1));
 stream.end();
 assert.deepEqual(messages,[value,{id:2}]);
});

test('非法 JSON 消息结构安全断开，不抛未捕获异常或接受后续响应',{timeout:10000},async t=>{
 const invalid=[null,[],false,123,'文字',{},
  {id:2},{id:null,result:{}},{id:{},result:{}},{id:2,result:{},error:{code:1,message:'错误'}},
  {method:123},{method:''},{id:2,error:null},{id:2,error:{code:'1',message:'错误'}},
  {id:2,error:{code:1,message:null}}, {method:'notice',result:{}}];
 for(const value of invalid){
  const rpc=await client(t);
  await assert.rejects(rpc.request('invalid-envelope',{value},1000),/无效协议消息结构/);
  assert.equal(rpc.isClosed,true);
  await rpc.disposeAndWait();
 }
});

test('输出提前结束或残留半条 JSON 时立即拒绝请求并释放进程',{timeout:5000},async t=>{
 for(const [method,pattern] of [['closed-output',/输出通道已关闭/],['truncated-output',/无效协议数据/]]){
  const rpc=await client(t);
  const closed=once(rpc,'close');
  await assert.rejects(rpc.request(method,{},1000),pattern);
  const [,reason]=await closed;
  assert.match(reason.message,pattern);assert.equal(rpc.isClosed,true);
 }
});

test('输出结束前无换行的完整 JSON 仍可正常接收',{timeout:5000},async t=>{
 const rpc=await client(t);
 assert.deepEqual(await rpc.request('unterminated-output'),{text:'末尾\u2028🙂'});
 assert.equal(rpc.isClosed,true);
});

test('损坏协议后即使子进程忽略 SIGTERM 也会限时退出',{timeout:5000},async t=>{
 const rpc=await client(t);const closed=once(rpc,'close');
 await assert.rejects(rpc.request('stubborn-output'),/无效协议数据/);
 await closed;assert.equal(rpc.isClosed,true);
});

test('后台异常断开显示具体原因；主动关闭不会误报错误',{timeout:5000},async t=>{
 for(const abnormal of [true,false]){
  const events=[];let onClose;
  const closed=new Promise(resolve=>{onClose=resolve;});
  const p=new CodexProcess({codexPath:executable,cwd:process.cwd(),permissionMode:'default'},
   {emit:e=>events.push(e),onPermission:()=>{},onSessionId:()=>{},onClose});
  t.after(()=>p.disposeAndWait());await p.start();
  p.sendUserMessage('wait');await p.startingTurn;
  if(abnormal)await p.rpc.request('corrupt-background');else p.dispose();
  await closed;
  const errors=events.filter(e=>e.kind==='error');
  assert.equal(errors.length,abnormal?1:0);
  if(abnormal)assert.match(errors[0].message,/无效协议消息结构/);
  assert.equal(p.isBusy,false);assert.equal(p.isExited,true);
 }
});
