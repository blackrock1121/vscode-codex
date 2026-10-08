const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return {};return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
function fixture(save=true){
 const provider=Object.create(ChatViewProvider.prototype),messages=[],applied=[];
 const settings={model:'test-model',effort:'high',fastMode:false};
 const session={proc:{setFastMode:async value=>applied.push(['visible',value])}};
 Object.assign(provider,{modelSelectionQueue:Promise.resolve(),modelCatalog:[{id:'test-model',fastModeSupported:true}],sessions:new Set([session]),detached:new Map([['hidden',{proc:{setFastMode:async value=>applied.push(['detached',value])}}]]),
 config:()=>({get:(key,fallback)=>settings[key]??fallback}),post:(_,m)=>messages.push(m),updateConfig:async(key,value)=>{if(save)settings[key]=value;return save;}});
 return {provider,session,settings,messages,applied};
}
test('快速设置串行保存并同步可见及后台会话，不改变模型和推理强度',async()=>{
 const f=fixture();await Promise.all([f.provider.setFastMode(f.session,true),f.provider.setFastMode(f.session,false)]);
 assert.deepEqual(f.applied,[['visible',true],['detached',true],['visible',false],['detached',false]]);
 assert.deepEqual(f.settings,{model:'test-model',effort:'high',fastMode:false});
 assert.deepEqual(f.messages.filter(m=>m.kind==='config').map(m=>m.fastMode),[true,false]);
});
test('保存失败或模型不支持时，快速模式不得应用到进程',async()=>{
 for(const supported of [true,false]){
  const f=fixture(!supported);f.provider.modelCatalog[0].fastModeSupported=supported;
  await f.provider.setFastMode(f.session,true);
  assert.deepEqual(f.applied,[]);assert.equal(f.settings.fastMode,false);
  assert.equal(f.messages.at(-1).fastMode,false);
  if(!supported)assert.match(f.messages.find(m=>m.kind==='error').message,/不支持快速模式/);
 }
});
