// 显式传入已安装目录才执行；仅创建并清理本次测试会话的通知。
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const exec = require('node:util').promisify(require('node:child_process').execFile);
async function main() {
  const extension = process.argv[2], reportPath = process.argv[3];
  assert.ok(extension && reportPath, '需要已安装目录和测试报告输出路径');
  const pkg = JSON.parse(await fs.readFile(path.join(extension, 'package.json'), 'utf8'));
  assert.equal(path.basename(extension), `blackrock1121.vscode-codex-${pkg.version}`);
  const app = path.join(extension, 'dist', 'Codex Copilot Notifications.app');
  const binary = await fs.readFile(path.join(app,'Contents','MacOS','codex-notifications'));
  const sessionId = 'notification-selftest-' + crypto.randomUUID();
  const rows = [];
  let lastAt = Date.now();
  async function request(operation, expired = false) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),'codex-chat-notify-'));
    try {
      await fs.chmod(dir, 0o700);
      const createdAt = lastAt = Math.max(Date.now(), lastAt + 1);
      const file = path.join(dir, 'request.codex-notification');
      await fs.writeFile(file, JSON.stringify({id:'codex-session:'+sessionId, sessionId, operation, createdAt,
        expiresAt:expired ? Date.now()-1 : Date.now()+30000,
        title:'Codex 通知修复验证',body:'这是本机验证通知，测试结束后会自动清理。',
        url:`vscode://blackrock1121.vscode-codex/notification?session=${sessionId}`}),{mode:0o600});
      const started = performance.now();
      await exec('/usr/bin/open',['-g','-a',app,file],{timeout:10000});
      const deadline = performance.now()+35000;
      while (performance.now()<deadline) {
        try {
          const result=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));
          rows.push({operation,expired,elapsedMs:Math.round(performance.now()-started),...result});
          return result;
        } catch (error) { if(error.code!=='ENOENT')throw error; }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw Error('原生通知未在期限内确认');
    } finally { await fs.rm(dir,{recursive:true,force:true}); }
  }
  let failure;
  try {
    const expired=await request('show',true);
    assert.equal(expired.ok,false);assert.equal(expired.code,'ETIMEDOUT');assert.equal(expired.phase,'queued');
    for(let i=0;i<2;i++){
      const sent=await request('show');assert.equal(sent.ok,true);assert.equal(sent.accepted,true);assert.equal(sent.phase,'submit');
    }
  } catch(error) { failure=error; }
  try {const cleared=await request('clear');assert.equal(cleared.ok,true);assert.equal(cleared.phase,'cleared');}
  catch(error){failure ??= error;}
  const report={version:pkg.version,at:Date.now(),extension,binarySha256:crypto.createHash('sha256').update(binary).digest('hex'),
    outcome:failure?'failed':'passed',rows,
    scope:'真实已安装原生辅助程序：过期请求失败、后续两次系统提交确认及限定会话清理；未自动操作用户通知权限，未证明横幅可见或所有旧故障恢复'};
  await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report));
  if(failure)throw failure;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
