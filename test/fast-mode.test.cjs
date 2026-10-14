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
 const session={sessionId:'a',proc:{modelForNextTurn:'test-model',setSpeedMode:async value=>applied.push(['a',value])}};
 const other={sessionId:'b',proc:{modelForNextTurn:'test-model',setSpeedMode:async value=>applied.push(['b',value])}};
 const hidden={sessionId:'hidden',proc:{setSpeedMode:async value=>applied.push(['hidden',value])}};
 Object.assign(provider,{modelSelectionQueue:Promise.resolve(),modelCatalog:[{id:'test-model',speedModes:['default','fast','ultrafast']}],sessions:new Set([session,other]),detached:new Map([['hidden',hidden]]),
 context:{workspaceState:{get:key=>state.get(key),update:async(key,value)=>{if(!save)throw new Error('save failed');state.set(key,value);}}},output:{appendLine:()=>{}},
 config:()=>({get:(key,fallback)=>settings[key]??fallback,inspect:key=>({workspaceValue:settings[key]})}),post:(ctx,m)=>messages.push({...m,target:ctx.sessionId}),updateConfig:async()=>{throw new Error('会话速度不应写入公共配置');}});
 return {provider,session,other,hidden,settings,messages,applied,state};
}
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
 const f=fixture();await Promise.all([f.provider.setSpeedMode(f.session,'ultrafast'),f.provider.setSpeedMode(f.other,'fast'),f.provider.setSpeedMode(f.session,'default')]);
 assert.deepEqual(f.applied,[['a','ultrafast'],['b','fast'],['a','default']]);
 const restored=fixture(true,f.state);
 assert.equal(restored.provider.speedMode(restored.session),'default');
 assert.equal(restored.provider.speedMode(restored.other),'fast');
 // 修改默认设置也不应覆盖已初始化的会话。
 restored.settings.speedMode='ultrafast';
 assert.equal(restored.provider.speedMode(restored.session),'default');
 assert.equal(restored.provider.speedMode({}),'ultrafast');
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
 assert.equal(f.state.get('codexChat.sessionSpeed.server-id'),'fast');
 assert.equal(f.provider.speedMode({sessionId:'server-id'}),'fast');
});
test('派生会话继承速度，之后调整不改变原会话',async()=>{
 const f=fixture();await f.provider.setSpeedMode(f.session,'fast');
 const fork={sessionId:'fork',speedMode:f.provider.speedMode(f.session)};
 await f.provider.saveSessionSpeed(fork,fork.speedMode);
 await f.provider.setSpeedMode(fork,'ultrafast');
 assert.equal(f.provider.speedMode({sessionId:'a'}),'fast');
 assert.equal(f.provider.speedMode({sessionId:'fork'}),'ultrafast');
});
test('保存失败、能力缺失或无效档位都不能把加速设置应用到进程',async()=>{
 for(const condition of ['save-failed','unsupported','unknown','invalid']) {
  const f=fixture(condition!=='save-failed');
  if(condition==='unsupported')f.provider.modelCatalog[0].speedModes=['default','fast'];
  if(condition==='unknown')f.provider.modelCatalog=[];
  await f.provider.setSpeedMode(f.session,condition==='invalid'?'bogus':'ultrafast');
  assert.deepEqual(f.applied,[]);assert.equal(f.settings.speedMode,'default');
  assert.equal(f.messages.at(-1).speedMode,'default');
  assert.ok(f.messages.every(m=>m.target==='a'));
 }
});
test('默认模型依据已连接会话的实际模型，不能猜目录默认模型',async()=>{
 const f=fixture();f.settings.model='';
 await f.provider.setSpeedMode(f.session,'ultrafast');assert.equal(f.provider.speedMode(f.session),'ultrafast');
 f.session.proc.modelForNextTurn='unknown';
 await f.provider.setSpeedMode(f.session,'fast');assert.equal(f.provider.speedMode(f.session),'ultrafast');
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
