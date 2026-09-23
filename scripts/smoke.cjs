const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {CodexRpc} = require('../dist/test/codex/rpc.js');
(async () => {
 const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-plugin-smoke-'));
 const rpc = new CodexRpc('codex', cwd); const created = [];
 try {
  await rpc.start(); console.log('协议握手通过');
  const account = await rpc.request('account/read', {}); console.log('账号类型：' + (account.account?.type ?? '未登录'));
  const models = await rpc.request('model/list', {}); console.log('模型列表：' + models.data.length);
  const r = await rpc.request('thread/start', {cwd, sandbox:'read-only', approvalPolicy:'never', approvalsReviewer:'user'});
  const id = r.thread.id; created.push(id); console.log('新建会话通过');
  rpc.on('request', m => rpc.reject(m.id));
  if (process.argv.includes('--turn')) {
   const completion = new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(Error('轮次超时')),120000);
    rpc.on('notification', m => {
     if(m.method === 'turn/completed') {clearTimeout(timer); console.log('轮次状态：'+m.params.turn.status); m.params.turn.status === 'failed' ? reject(Error(m.params.turn.error?.message ?? '轮次失败')) : resolve();}
    });
   });
   await rpc.request('turn/start', { threadId:id,input:[{type:'text',text:'这是插件集成测试。请仅回复“连接成功”，不要调用工具。',text_elements:[]}],effort:'low' });
   await completion;
   const meta = await rpc.request('thread/read',{threadId:id});
   console.log('历史模式：'+meta.thread.historyMode);
   let turns;
   if(meta.thread.historyMode === 'paginated') turns=(await rpc.request('thread/turns/list',{threadId:id,itemsView:'full',sortDirection:'asc'})).data;
   else turns=(await rpc.request('thread/read',{threadId:id,includeTurns:true})).thread.turns;
   console.log('读取历史轮次：'+turns.length);
   const fork=await rpc.request('thread/fork',{threadId:id,lastTurnId:turns[0].id});created.push(fork.thread.id);console.log('派生会话通过');
   await rpc.request('thread/name/set',{threadId:fork.thread.id,name:'插件自动化测试'});console.log('重命名通过');
  }
 } catch(e) { console.error(e.message); process.exitCode=1; }
 finally {
  for(const id of created.reverse()) {try {await rpc.request('thread/archive',{threadId:id});await rpc.request('thread/delete',{threadId:id});console.log('测试会话清理通过');} catch(e){console.error('测试会话清理失败：'+e.message);process.exitCode=1;}}
  await rpc.disposeAndWait(); await fs.rm(cwd,{recursive:true,force:true});
 }
})();
