const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return {};return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
const {modelChoices,speedCost,configuredSpeedMode,supportsSpeed}=require('../dist/test/shared.js');
function fixture(save=true){
 const provider=Object.create(ChatViewProvider.prototype),messages=[],applied=[];
 const settings={model:'test-model',effort:'high',speedMode:'default',fastMode:false};
 const session={proc:{modelForNextTurn:'test-model',setSpeedMode:async value=>applied.push(['visible',value])}};
 Object.assign(provider,{modelSelectionQueue:Promise.resolve(),modelCatalog:[{id:'test-model',speedModes:['default','fast','ultrafast']}],sessions:new Set([session]),detached:new Map([['hidden',{proc:{setSpeedMode:async value=>applied.push(['detached',value])}}]]),
 config:()=>({get:(key,fallback)=>settings[key]??fallback,inspect:key=>({workspaceValue:settings[key]})}),post:(_,m)=>messages.push(m),updateConfig:async(key,value)=>{if(save)settings[key]=value;return save;}});
 return {provider,session,settings,messages,applied};
}
test('三档设置串行保存并同步可见及后台会话，不改变模型和推理强度',async()=>{
 const f=fixture();await Promise.all(['ultrafast','fast','default'].map(mode=>f.provider.setSpeedMode(f.session,mode)));
 assert.deepEqual(f.applied,[['visible','ultrafast'],['detached','ultrafast'],['visible','fast'],['detached','fast'],['visible','default'],['detached','default']]);
 assert.deepEqual(f.settings,{model:'test-model',effort:'high',speedMode:'default',fastMode:false});
 assert.deepEqual(f.messages.filter(m=>m.kind==='config').map(m=>m.speedMode),['ultrafast','fast','default']);
});
test('保存失败、能力缺失或无效档位都不能把加速设置应用到进程',async()=>{
 for(const condition of ['save-failed','unsupported','unknown','invalid']) {
  const f=fixture(condition!=='save-failed');
  if(condition==='unsupported')f.provider.modelCatalog[0].speedModes=['default','fast'];
  if(condition==='unknown')f.provider.modelCatalog=[];
  await f.provider.setSpeedMode(f.session,condition==='invalid'?'bogus':'ultrafast');
  assert.deepEqual(f.applied,[]);assert.equal(f.settings.speedMode,'default');
  assert.equal(f.messages.at(-1).speedMode,'default');
 }
});
test('默认模型依据已连接会话的实际模型，不能猜目录默认模型',async()=>{
 const f=fixture();f.settings.model='';
 await f.provider.setSpeedMode(f.session,'ultrafast');assert.equal(f.settings.speedMode,'ultrafast');
 f.session.proc.modelForNextTurn='unknown';
 await f.provider.setSpeedMode(f.session,'fast');assert.equal(f.settings.speedMode,'ultrafast');
 f.session.proc=undefined;
 await f.provider.setSpeedMode(f.session,'default');assert.equal(f.settings.speedMode,'default');
 await f.provider.setSpeedMode(f.session,'fast');assert.equal(f.settings.speedMode,'default');
});
test('旧快速布尔值继续生效，显式普通设置覆盖旧 true，无效设置不升级消费',()=>{
 assert.equal(configuredSpeedMode(undefined,true),'fast');assert.equal(configuredSpeedMode(undefined,false),'default');
 assert.equal(configuredSpeedMode('default',true),'default');assert.equal(configuredSpeedMode('ultrafast',false),'ultrafast');
 assert.equal(configuredSpeedMode('invalid',true),'default');
 const f=fixture();delete f.settings.speedMode;f.settings.fastMode=true;assert.equal(f.provider.speedMode(),'fast');
 f.settings.speedMode='default';assert.equal(f.provider.speedMode(),'default');
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
 assert.equal(speedCost('fast','gpt-6.1-sol','chatgpt').badge,'2.5×／2×');
 assert.equal(speedCost('ultrafast','gpt-6-astra','chatgpt').badge,'8×／6×');
 assert.equal(speedCost('ultrafast','new-model','chatgpt').badge,'倍率待确认');
 assert.equal(speedCost('fast','new-model','chatgpt').badge,'倍率待确认');
 assert.equal(speedCost('fast','gpt-6.1-luna','chatgpt').badge,'倍率待确认');
 assert.equal(speedCost('ultrafast','gpt-6-astra','api').badge,'API 定价');
 assert.match(speedCost('fast','gpt-6-sol','unknown').text,/若使用 ChatGPT/);
});
