const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const path=require('node:path');
const {CodexRpc}=require('../dist/test/codex/rpc.js');

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
