const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {CodexProcess}=require('../dist/test/codex/process.js');
(async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'codex-question-'));
 const events=[],questions=[];let id;
 const p=new CodexProcess({codexPath:'codex',cwd,permissionMode:'plan',effort:'low'}, {emit:e=>events.push(e),onPermission:q=>questions.push(q),onSessionId:s=>id=s,onClose:()=>{}});
 const until=async(fn,ms=120000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('等待超时');await new Promise(r=>setTimeout(r,100));}};
 try{
  await p.start();console.log('真实 CLI 连接成功');
  p.sendUserMessage('这是插件等待输入的集成测试，不要读写任何文件。请立即调用 AskUserQuestion，问题 ID 为 choice，内容为“请选择测试结果”，选项 A 和 B。必须等工具返回用户答案后才能给出最终回复。');
  await until(()=>questions.length||events.some(e=>e.kind==='result'));
  assert.equal(questions.length,1,'必须实际收到提问');console.log('收到提问，保持 65 秒不应答');
  const from=events.length;
  await new Promise(r=>setTimeout(r,65000));
  assert.equal(p.isBusy,true);assert.equal(events.slice(from).some(e=>['result','text_delta','thinking_delta','permission_resolved'].includes(e.kind)),false,'等待时模型不能继续或取消');
  assert.equal(p.answerQuestion(questions[0].requestId,{choice:'A'}),true);console.log('65 秒内保持阻塞，提交测试答案');
  await until(()=>events.some(e=>e.kind==='result'));
  assert.equal(events.find(e=>e.kind==='result').isError,false);
  const history=await p.rpc.request('thread/read',{threadId:id,includeTurns:true});
  const types=history.thread.turns.flatMap(t=>t.items).map(i=>i.type);
  assert.ok(types.includes('dynamicToolCall'));
  console.log('应答后完成，直接工具调用验证通过');
 }finally{
  if(p.isBusy)await p.interrupt();
  if(id){try{await p.rpc.request('thread/archive',{threadId:id});await p.rpc.request('thread/delete',{threadId:id});}catch(e){console.error('清理测试会话失败：'+e.message);}}
  await p.disposeAndWait();await fs.rm(cwd,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
