const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const assert=require('node:assert/strict');
const {CodexProcess}=require('../dist/test/codex/process.js');const {CodexRpc}=require('../dist/test/codex/rpc.js');const {SessionStore}=require('../dist/test/codex/session.js');
(async()=>{const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'codex-adapter-'));let p,id,done,fail;const events=[];const store=new SessionStore(cwd,()=> 'codex');
const hooks={emit:e=>{events.push(e);if(e.kind==='error')console.log('适配层错误：'+e.message);if(e.kind==='result'){e.isError?fail(Error('轮次失败')):done();}},onSessionId:s=>{id=s;},onClose:()=>{},onPermission:r=>{console.log('收到审批：'+r.toolName);p.respondPermission(r.requestId,{behavior:'allow'});}};
async function turn(text){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('测试超时')),120000);done=()=>{clearTimeout(timer);resolve();};fail=e=>{clearTimeout(timer);reject(e);};if(!p.sendUserMessage(text))fail(Error('发送失败'));});}
try{
await fs.writeFile(path.join(cwd,'sample.txt'),'before\n');
p=new CodexProcess({codexPath:'codex',cwd,permissionMode:'default',effort:'low',appendSystemPrompt:'这是隔离目录中的插件测试，只操作当前目录的 sample.txt。'},hooks);await p.start();
await turn('请把当前目录 sample.txt 的内容改成 after，末尾换行。完成后只回复“修改完成”。');
assert.equal(await fs.readFile(path.join(cwd,'sample.txt'),'utf8'),'after\n');assert.ok(events.some(e=>e.kind==='text_delta'));assert.ok(events.some(e=>e.kind==='tool_input'));console.log('真实文件修改、工具卡片及文本流通过');
await p.disposeAndWait();await store.hydrate(id);assert.ok(store.load(id).some(x=>x.type==='user'));console.log('SessionStore 历史映射通过');
p=new CodexProcess({codexPath:'codex',cwd,permissionMode:'plan',resumeSessionId:id,effort:'low'},hooks);await p.start();await turn('刚才修改的是哪个文件？只回复文件名，不调用工具。');console.log('恢复会话并继续对话通过');
}catch(e){console.error(e.message);process.exitCode=1;}finally{await p?.disposeAndWait();if(id)try{await store.delete(id);console.log('测试会话清理通过');}catch(e){console.error(e.message);process.exitCode=1;}store.dispose();await fs.rm(cwd,{recursive:true,force:true});}})();
