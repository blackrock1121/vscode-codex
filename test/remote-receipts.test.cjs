const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ExecutionReceipts}=require('../dist/test/remote/executionReceipts.js');
const command={version:1,commandId:'send',deviceId:'phone',target:{windowId:'window',workspaceId:'project',sessionId:'session'},operation:{kind:'message.send',text:'私密正文',attachmentIds:[]}};
test('交接状态持久保存，重启后查询和重复请求均不会再次发送',async()=>{
  let saved={},calls=0;const storage={read:()=>saved,write:async value=>{saved=structuredClone(value);}};
  const first=new ExecutionReceipts(storage);
  await first.run(command,async()=>{calls++;return {accepted:true,result:{sessionId:'session'}};});
  assert.ok(!JSON.stringify(saved).includes('私密正文'));
  const next=new ExecutionReceipts(storage);assert.equal(next.status(command,'send').state,'accepted');
  assert.equal(next.status({...command,deviceId:'other'},'send').state,'unknown');
  await next.run(command,async()=>{calls++;throw Error('不能重发');});assert.equal(calls,1);
});
test('交接中抛错或状态落盘失败保留未知，不将异常伪装为未执行',async()=>{
  let saved={},fail=false,calls=0;const storage={read:()=>saved,write:async value=>{if(fail)throw Error('DISK');saved=structuredClone(value);}};
  const ledger=new ExecutionReceipts(storage);
  await assert.rejects(ledger.run(command,async()=>{calls++;throw Error('执行后丢失结果');}));
  assert.equal(ledger.status(command,'send').state,'unknown');
  await assert.rejects(new ExecutionReceipts(storage).run(command,async()=>{calls++;return {accepted:true,result:{}};}),/PLUGIN_RESULT_UNKNOWN/);assert.equal(calls,1);
  fail=true;await assert.rejects(ledger.run({...command,commandId:'next'},async()=>{calls++;return {accepted:true,result:{}};}));assert.equal(calls,1);
});
