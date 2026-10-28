const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return {};return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
const {modelChoices,speedCost,speedGain,configuredSpeedMode,supportsSpeed}=require('../dist/test/shared.js');
function fixture(save=true, state=new Map()){
 const provider=Object.create(ChatViewProvider.prototype),messages=[],applied=[];
 const settings={model:'test-model',effort:'high',speedMode:'default',fastMode:false};
 const session={sessionId:'a',proc:{modelForNextTurn:'test-model',setSpeedMode:async value=>applied.push(['a',value]),setEffort:async value=>applied.push(['effort','a',value])}};
 const other={sessionId:'b',proc:{modelForNextTurn:'test-model',setSpeedMode:async value=>applied.push(['b',value]),setEffort:async value=>applied.push(['effort','b',value])}};
 const hidden={sessionId:'hidden',proc:{setSpeedMode:async value=>applied.push(['hidden',value]),setEffort:async value=>applied.push(['effort','hidden',value])}};
 Object.assign(provider,{modelCatalog:[{id:'test-model',efforts:['low','medium','high'],speedModes:['default','fast','ultrafast']}],sessions:new Set([session,other]),detached:new Map([['hidden',hidden]]),
 context:{workspaceState:{get:key=>state.get(key),update:async(key,value)=>{if(!save)throw new Error('save failed');state.set(key,value);}}},output:{appendLine:()=>{}},
 config:()=>({get:(key,fallback)=>settings[key]??fallback,inspect:key=>({workspaceValue:settings[key]})}),post:(ctx,m)=>messages.push({...m,target:ctx.sessionId}),updateConfig:async()=>{throw new Error('会话速度不应写入公共配置');}});
 return {provider,session,other,hidden,settings,messages,applied,state};
}
test('一个会话保存快速模式未完成时，另一个会话仍能独立保存推理强度',async()=>{
 const f=fixture();let release,completed=false;
 const update=f.provider.context.workspaceState.update;
 f.provider.context.workspaceState.update=async(key,value)=>{
  if(key==='codexChat.sessionSpeed.a')await new Promise(resolve=>{release=resolve;});
  await update(key,value);
 };
 const first=f.provider.setSpeedMode(f.session,'fast');
 await new Promise(resolve=>setImmediate(resolve));
 const second=f.provider.setEffort(f.other,'low').then(()=>{completed=true;});
 await new Promise(resolve=>setImmediate(resolve));
 try {
  assert.equal(completed,true,'B 不应等待 A 保存设置');
  assert.equal(f.state.get('codexChat.sessionEffort.b'),'low');
 } finally {release();await Promise.all([first,second]);}
});
test('切换档位保存期间重连，恢复流程不能把旧速度或旧推理强度写回',async()=>{
 for(const kind of ['speed','effort']){
  const f=fixture();let release;
  f.provider.speedMode(f.session);f.provider.sessionEffort(f.session);
  f.session.checkpoints={setSession:()=>{}};f.provider.refreshSessions=()=>{};f.provider.store={findFile:()=>undefined};
  const key=kind==='speed'?'codexChat.sessionSpeed.a':'codexChat.sessionEffort.a';
  const value=kind==='speed'?'fast':'low';
  const update=f.provider.context.workspaceState.update;
  f.provider.context.workspaceState.update=async(k,v)=>{
   await update(k,v);
   if(k===key&&v===value&&!release)await new Promise(resolve=>{release=resolve;});
  };
  const selecting=kind==='speed'?f.provider.setSpeedMode(f.session,value):f.provider.setEffort(f.session,value);
  await new Promise(resolve=>setImmediate(resolve));
  f.provider.onSessionId(f.session,'a',true);
  release();await selecting;await f.session.settingsQueue;
  assert.equal(f.state.get(key),value,'重连保存不能覆盖已确认的新档位');
 }
});
test('A 保持普通，B 切快速只更新 B，后台会话和公共默认值不变',async()=>{
 const f=fixture();
 assert.equal(f.provider.speedMode(f.session),'default');
 assert.equal(f.provider.speedMode(f.hidden),'default');
 await f.provider.setSpeedMode(f.other,'fast');
 assert.deepEqual(f.applied,[['b','fast']]);
 assert.equal(f.provider.speedMode(f.session),'default');
 assert.equal(f.provider.speedMode(f.other),'fast');
 assert.equal(f.provider.speedMode(f.hidden),'default');
 assert.equal(f.provider.speedMode({}),'default');
 assert.deepEqual(f.settings,{model:'test-model',effort:'high',speedMode:'default',fastMode:false});
 assert.ok(f.messages.every(m=>m.target==='b'));
 // 模型/权限等公共配置刷新不能再次覆盖会话速度。
 f.messages.length=0;f.provider.broadcastModelConfig();
 assert.deepEqual(f.messages.map(m=>[m.target,m.speedMode]),[['a','default'],['b','fast']]);
});
test('各会话连续切换独立保存，重建 provider 后仍能按会话 ID 恢复',async()=>{
 const f=fixture();await Promise.all([f.provider.setSpeedMode(f.session,'fast'),f.provider.setSpeedMode(f.other,'fast'),f.provider.setSpeedMode(f.session,'default')]);
 assert.deepEqual(f.applied,[['a','fast'],['b','fast'],['a','default']]);
 const restored=fixture(true,f.state);
 assert.equal(restored.provider.speedMode(restored.session),'default');
 assert.equal(restored.provider.speedMode(restored.other),'fast');
 // 修改默认设置也不应覆盖已初始化的会话。
 restored.settings.speedMode='fast';
 assert.equal(restored.provider.speedMode(restored.session),'default');
 assert.equal(restored.provider.speedMode({}),'fast');
});
test('速度保存成功先同步开关再通知短暂反馈，不向聊天追加成功通知',async()=>{
 const f=fixture();
 for(const mode of ['fast','default','fast']){
  f.messages.length=0;
  await f.provider.setSpeedMode(f.session,mode);
  assert.deepEqual(f.messages.map(m=>m.kind),['config','speed_mode_saved']);
  assert.equal(f.messages[0].speedMode,mode);
  assert.deepEqual(f.messages[1],{kind:'speed_mode_saved',mode,target:'a'});
 }
});
test('修改权限时广播配置仍保留每个会话自己的速度',async()=>{
 const f=fixture();await f.provider.setSpeedMode(f.other,'fast');
 f.provider.modeSeq=0;f.provider.updateConfig=async()=>true;
 for(const ctx of [f.session,f.other,f.hidden])ctx.proc.setPermissionMode=async()=>{};
 f.messages.length=0;await f.provider.setPermissionMode(f.session,'plan');
 assert.deepEqual(f.messages.map(m=>[m.target,m.speedMode,m.permissionMode]),[['a','default','plan'],['b','fast','plan']]);
});
test('空白会话发送前独立选择，服务端分配 ID 后保留并保存速度',async()=>{
 const f=fixture();delete f.session.sessionId;
 await f.provider.setSpeedMode(f.session,'fast');
 assert.equal(f.state.size,0);assert.equal(f.provider.speedMode(f.other),'default');
 f.session.checkpoints={setSession:()=>{}};f.provider.refreshSessions=()=>{};f.provider.store={findFile:()=>undefined};
 f.provider.onSessionId(f.session,'server-id',false);
 await f.session.settingsQueue;
 assert.equal(f.state.get('codexChat.sessionSpeed.server-id'),'fast');
 assert.equal(f.provider.speedMode({sessionId:'server-id'}),'fast');
});
test('派生会话继承速度，之后调整不改变原会话',async()=>{
 const f=fixture();await f.provider.setSpeedMode(f.session,'fast');
 const fork={sessionId:'fork',speedMode:f.provider.speedMode(f.session)};
 await f.provider.saveSessionSpeed(fork,fork.speedMode);
 await f.provider.setSpeedMode(fork,'default');
 assert.equal(f.provider.speedMode({sessionId:'a'}),'fast');
 assert.equal(f.provider.speedMode({sessionId:'fork'}),'default');
});
test('保存失败、能力缺失或无效档位都不能把加速设置应用到进程',async()=>{
 for(const condition of ['save-failed','unsupported','unknown','invalid']) {
  const f=fixture(condition!=='save-failed');
  if(condition==='unsupported')f.provider.modelCatalog[0].speedModes=['default'];
  if(condition==='unknown')f.provider.modelCatalog=[];
  await f.provider.setSpeedMode(f.session,condition==='invalid'?'bogus':'fast');
  assert.deepEqual(f.applied,[]);assert.equal(f.settings.speedMode,'default');
  assert.equal(f.messages.at(-1).speedMode,'default');
  assert.equal(f.messages.some(m=>m.kind==='speed_mode_saved'),false);
  assert.ok(f.messages.some(m=>m.kind==='error'));
  assert.ok(f.messages.every(m=>m.target==='a'));
 }
});
test('默认模型依据已连接会话的实际模型，不能猜目录默认模型',async()=>{
 const f=fixture();f.settings.model='';
 await f.provider.setSpeedMode(f.session,'fast');assert.equal(f.provider.speedMode(f.session),'fast');
 f.session.proc.modelForNextTurn='unknown';
 await f.provider.setSpeedMode(f.session,'fast');assert.equal(f.provider.speedMode(f.session),'fast');
 f.session.proc=undefined;
 await f.provider.setSpeedMode(f.session,'default');assert.equal(f.provider.speedMode(f.session),'default');
 await f.provider.setSpeedMode(f.session,'fast');assert.equal(f.provider.speedMode(f.session),'default');
});
test('旧快速布尔值继续生效，显式普通设置覆盖旧 true，无效设置不升级消费',()=>{
 assert.equal(configuredSpeedMode(undefined,true),'fast');assert.equal(configuredSpeedMode(undefined,false),'default');
 assert.equal(configuredSpeedMode('default',true),'default');assert.equal(configuredSpeedMode('ultrafast',false),'ultrafast');
 assert.equal(configuredSpeedMode('invalid',true),'default');
 const f=fixture();delete f.settings.speedMode;f.settings.fastMode=true;assert.equal(f.provider.defaultSpeedMode(),'fast');
 f.settings.speedMode='default';assert.equal(f.provider.defaultSpeedMode(),'default');
});
test('能力取自服务档位，兼容旧字段且区分未提供和未知，不按模型名猜权限',()=>{
 const entries=modelChoices([
  {model:'gpt-6-astra',serviceTiers:[{id:'priority'}]},
  {model:'new-model',serviceTiers:[{id:'fast'},{id:'ultrafast'}]},
  {model:'legacy',additionalSpeedTiers:['fast','ultrafast']},
  {model:'empty',serviceTiers:[],additionalSpeedTiers:['fast']},
  {model:'unknown'}, {model:'hidden',hidden:true,serviceTiers:[{id:'ultrafast'}]},
 ]);
 assert.deepEqual(entries.map(m=>m.speedModes),[['default','fast'],['default','fast','ultrafast'],['default','fast','ultrafast'],['default'],undefined]);
 assert.equal(supportsSpeed(entries[0],'ultrafast'),false);
 assert.equal(supportsSpeed(entries[1],'ultrafast'),true);
 assert.equal(supportsSpeed(undefined,'default'),true);
});
test('额度倍率按档位和计费方式说明，未知模型不得捏造倍率',()=>{
 assert.equal(speedCost('default','gpt-6-astra','chatgpt').badge,'1×');
 assert.equal(speedCost('fast','gpt-6.1-sol','chatgpt').badge,'2.5×');
 assert.equal(speedCost('ultrafast','gpt-6-astra','chatgpt').badge,'8×');
 assert.equal(speedCost('ultrafast','gpt-6.1-sol','chatgpt').badge,'8×');
 assert.equal(speedCost('ultrafast','gpt-6.1-sol-2026-09-28','chatgpt').badge,'8×');
 assert.equal(speedCost('ultrafast','new-model','chatgpt').badge,'倍率待确认');
 assert.equal(speedCost('fast','new-model','chatgpt').badge,'倍率待确认');
 assert.equal(speedCost('fast','gpt-6.1-luna','chatgpt').badge,'倍率待确认');
 assert.equal(speedCost('ultrafast','gpt-6-astra','api').badge,'API 定价');
 assert.match(speedCost('fast','gpt-6-sol','unknown').text,/若使用 ChatGPT/);
});
test('生成速度按模型和计费方式区分，保留最高限定且不把额度当提速',()=>{
 assert.equal(speedGain('default','new-model','unknown').badge,'1×');
 assert.equal(speedGain('fast','gpt-5.6','chatgpt').badge,'1.5×');
 assert.equal(speedGain('ultrafast','gpt-6-astra','chatgpt').badge,'最高 8×');
 assert.equal(speedGain('fast','gpt-5.6-sol','api').badge,'最高 2.5×');
 assert.equal(speedGain('ultrafast','gpt-6-astra-2026-09-28','chatgpt').badge,'最高 8×');
 for(const [mode,model,billing] of [
  ['fast','gpt-6.1-sol','chatgpt'],['ultrafast','gpt-6.1-sol','chatgpt'],
  ['fast','gpt-5.6-sol','chatgpt'],['ultrafast','gpt-6-astra','api'],
  ['ultrafast','gpt-6-astra','unknown'],['fast','new-model','api'],
 ]) assert.equal(speedGain(mode,model,billing).badge,'未公布');
});

test('默认 high，各会话推理强度独立保存，重载和公共配置广播保持各自选择',async()=>{
 const f=fixture();delete f.settings.effort;
 assert.equal(f.provider.sessionEffort(f.session),'high');
 assert.equal(f.provider.sessionEffort(f.hidden),'high');
 await f.provider.setEffort(f.other,'low');
 assert.deepEqual(f.applied,[['effort','b','low']]);
 assert.equal(f.provider.sessionEffort(f.session),'high');
 assert.equal(f.provider.sessionEffort(f.other),'low');
 assert.equal(f.provider.sessionEffort(f.hidden),'high');
 f.messages.length=0;f.provider.broadcastModelConfig();
 assert.deepEqual(f.messages.map(m=>[m.target,m.effort]),[['a','high'],['b','low']]);
 const restored=fixture(true,f.state);delete restored.settings.effort;
 assert.equal(restored.provider.sessionEffort(restored.other),'low');
 restored.settings.effort='medium';assert.equal(restored.provider.sessionEffort(restored.other),'low');
 assert.equal(restored.provider.sessionEffort({}),'medium');
});
test('推理设置保存失败或不支持时不能改变进程，错误只发给当前会话',async()=>{
 for(const condition of ['save-failed','unsupported']){
  const f=fixture(condition!=='save-failed');
  await f.provider.setEffort(f.other,condition==='unsupported'?'max':'low');
  assert.deepEqual(f.applied,[]);assert.equal(f.provider.sessionEffort(f.other),'high');
  assert.ok(f.messages.every(m=>m.target==='b'));
  assert.equal(f.messages.at(-1).effort,'high');
 }
});
test('空白会话保留所选推理强度，分配 ID 后写入；派生继承后独立修改',async()=>{
 const f=fixture();delete f.session.sessionId;
 await f.provider.setEffort(f.session,'low');assert.equal(f.state.size,0);
 f.session.checkpoints={setSession:()=>{}};f.provider.refreshSessions=()=>{};f.provider.store={findFile:()=>undefined};
 f.provider.onSessionId(f.session,'created',false);
 await f.session.settingsQueue;
 assert.equal(f.state.get('codexChat.sessionEffort.created'),'low');
 await f.provider.saveSessionEffort({sessionId:'fork'},f.provider.sessionEffort(f.session));
 const fork={sessionId:'fork'};assert.equal(f.provider.sessionEffort(fork),'low');
 await f.provider.setEffort(fork,'medium');
 assert.equal(f.provider.sessionEffort(f.session),'low');assert.equal(f.provider.sessionEffort({sessionId:'fork'}),'medium');
});
test('模型默认值空字符串也能持久化，后台会话不被其他会话的推理切换覆盖',async()=>{
 const f=fixture();await f.provider.setEffort(f.hidden,'');
 await f.provider.setEffort(f.session,'medium');
 assert.equal(f.provider.sessionEffort(f.hidden),'');
 assert.equal(f.provider.sessionEffort({sessionId:'hidden'}),'');
 assert.equal(f.provider.sessionEffort(f.other),'high');
 assert.deepEqual(f.applied,[['effort','hidden',''],['effort','a','medium']]);
});
test('旧超高速设置回到普通，新界面与设置不再允许启用超高速',async()=>{
 const f=fixture();f.state.set('codexChat.sessionSpeed.a','ultrafast');
 assert.equal(f.provider.speedMode(f.session),'default');
 f.settings.speedMode='ultrafast';assert.equal(f.provider.defaultSpeedMode(),'default');
 await f.provider.setSpeedMode(f.other,'ultrafast');assert.equal(f.applied.length,0);
 const pkg=require('../package.json');assert.equal(pkg.contributes.configuration.properties['codexChat.effort'].default,'high');
 assert.deepEqual(pkg.contributes.configuration.properties['codexChat.speedMode'].enum,['default','fast']);
});

test('切换模型只重置当前会话的不兼容档位，其他会话及公共默认值保持不变',async()=>{
 const f=fixture();await f.provider.setEffort(f.other,'low');f.applied.length=0;
 f.provider.modelCatalog.push({id:'low-only',efforts:['low'],speedModes:['default']});
 for(const session of [f.session,f.other,f.hidden])session.proc.setModel=async()=>{};
 await f.provider.setModel(f.session,'low-only');
 assert.equal(f.settings.effort,'high');assert.equal(f.provider.sessionEffort(f.session),'');
 assert.equal(f.provider.sessionEffort(f.other),'low');assert.equal(f.provider.sessionEffort(f.hidden),'high');
 assert.deepEqual(f.applied,[['effort','a','']]);
});
test('模型切换途中推理强度保存失败会撤回模型选择，不改变任一会话的运行设置',async()=>{
 const f=fixture();f.state.set('codexChat.sessionEffort.a','high');
 f.provider.modelCatalog.push({id:'low-only',efforts:['low']});
 for(const session of [f.session,f.other,f.hidden])session.proc.setModel=async()=>assert.fail('不能切换模型');
 f.provider.saveSessionEffort=async()=>{throw Error('保存失败');};
 await f.provider.setModel(f.session,'low-only');
 assert.equal(f.settings.model,'test-model');assert.equal(f.provider.sessionEffort(f.session),'high');
 assert.equal(f.state.get('codexChat.sessionModel.a'),'test-model');
 assert.equal(f.state.get('codexChat.sessionEffort.a'),'high');assert.deepEqual(f.applied,[]);
});
