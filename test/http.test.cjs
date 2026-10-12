const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const https=require('node:https');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return {};return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;

function response(t){
 const get=https.get;
 const res=new PassThrough();res.statusCode=200;
 https.get=(_url,_opts,callback)=>{
  const req=new EventEmitter();req.setTimeout=()=>req;
  queueMicrotask(()=>callback(res));return req;
 };
 t.after(()=>{https.get=get;res.destroy();});
 const provider=Object.create(ChatViewProvider.prototype);
 return {res,promise:provider.httpGetText('https://example.invalid/test')};
}

test('下载响应跨块 UTF-8 和 Unicode 分隔符保持原样',async t=>{
 const {res,promise}=response(t);
 await Promise.resolve();
 const text='中文🙂\u2028\u2029';const data=Buffer.from(text);
 for(let i=0;i<data.length;i++)res.write(data.subarray(i,i+1));
 res.end();assert.equal(await promise,text);
});

test('下载正文中途断开时拒绝等待，后续流错误也被接住',async t=>{
 const {res,promise}=response(t);
 const rejected=assert.rejects(promise,/下载响应提前中断/);
 await Promise.resolve();res.write('半条正文');res.emit('aborted');
 assert.doesNotThrow(()=>res.emit('error',new Error('ECONNRESET')));
 await rejected;
});

test('下载正文读取失败不会抛未捕获的流异常',async t=>{
 const {res,promise}=response(t);
 const rejected=assert.rejects(promise,/读取失败/);
 await Promise.resolve();res.emit('error',new Error('读取失败'));
 await rejected;
});
