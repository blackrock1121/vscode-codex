const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {randomBytes}=require('node:crypto');
const {RemoteBridgeClient}=require('../dist/test/remote/bridgeClient.js');
const {PluginSocket:LegacyBridge}=require('./fixtures/remote-v1/legacy-bridge.cjs');
const registration={windowId:'window',workspaceId:'project',label:'兼容测试'};
const command=operation=>({version:1,commandId:'command',deviceId:'phone',issuedAt:Date.now(),expiresAt:Date.now()+60000,
  target:{windowId:'window',workspaceId:'project',sessionId:'session'},operation});

test('新插件连接冻结的旧桥接：新增能力不破坏注册，流事件降级后基础聊天仍工作',{timeout:8000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-old-bridge-'));let connected;
  const ready=new Promise(resolve=>connected=resolve);
  const bridge=new LegacyBridge(dir,{register:plugin=>{connected(plugin);return()=>{};}});
  const seen=[];
  const client=new RemoteBridgeClient(dir,registration,async c=>{seen.push(c.operation.kind);return{accepted:true,result:{kind:c.operation.kind}};});
  t.after(async()=>{client.dispose();await bridge.close();fs.rmSync(dir,{recursive:true,force:true});});
  await bridge.listen();client.start();const peer=await ready;
  assert.equal((await peer.execute(command({kind:'session.snapshot'}))).accepted,true);
  client.publish('session',{kind:'delta',text:'旧桥接不接受事件'});
  client.publish('session',{kind:'completed',deviceId:'phone',commandId:'done'});
  assert.equal((await peer.execute(command({kind:'message.send',text:'仍能发送',attachmentIds:[]}))).accepted,true);
  assert.deepEqual(seen,['session.snapshot','message.send']);
});

test('未知操作和非法参数只拒绝当前请求，随后基础命令仍走同一连接',{timeout:8000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-new-peer-'));fs.chmodSync(dir,0o700);
  const token=randomBytes(32).toString('hex');fs.writeFileSync(path.join(dir,'bridge.json'),JSON.stringify({version:1,token}),{mode:0o600});
  let ready;const connected=new Promise(resolve=>ready=resolve);const server=net.createServer(socket=>ready(socket));
  await new Promise(resolve=>server.listen(path.join(dir,'bridge.sock'),resolve));fs.chmodSync(path.join(dir,'bridge.sock'),0o600);
  const executed=[];const client=new RemoteBridgeClient(dir,registration,async c=>{executed.push(c.operation.kind);return{accepted:true,result:{}};});
  let socket;t.after(async()=>{client.dispose();socket?.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  client.start();socket=await connected;
  let buffer='';const pending=[],waiting=[];
  socket.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\n'))>=0){const frame=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const next=waiting.shift();if(next)next(frame);else pending.push(frame);}});
  const read=()=>pending.length?Promise.resolve(pending.shift()):new Promise(resolve=>waiting.push(resolve));
  const send=value=>socket.write(JSON.stringify(value)+'\n');
  assert.equal((await read()).capabilities.actions,true);send({kind:'registered',version:1,features:{events:true}});
  for(const [operation,error] of [[{kind:'future.operation'},'UNSUPPORTED_OPERATION'],[{kind:'message.send',text:'非法',attachmentIds:[],extra:true},'INVALID_COMMAND']]){
    send({kind:'execute',id:'invalid',command:command(operation)});assert.equal((await read()).reply.error,error);
  }
  send({kind:'execute',id:'valid',command:command({kind:'session.snapshot'})});assert.equal((await read()).reply.accepted,true);
  client.publish('session',{kind:'delta',text:'新服务支持事件'});assert.equal((await read()).event.text,'新服务支持事件');
  assert.deepEqual(executed,['session.snapshot']);
});

test('异常事件序列化不抛到电脑流程，也不污染完成通知缓存',()=>{
  const client=new RemoteBridgeClient('/unused',registration,async()=>({accepted:true,result:{}}));
  const invalid={kind:'completed',deviceId:'phone',commandId:'bad'};invalid.self=invalid;
  assert.doesNotThrow(()=>client.publish('session',invalid));assert.equal(client.completions.size,0);
  client.publish('session',{kind:'completed',deviceId:'one',commandId:'same'});
  client.publish('session',{kind:'completed',deviceId:'two',commandId:'same'});
  assert.equal(client.completions.size,2);client.dispose();
});
