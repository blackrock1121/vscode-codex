const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CodexProcess } = require('../dist/test/codex/process.js');

(async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-question-'));
  let p, id;
  const until = async (fn, ms = 120000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw Error('等待超时');
      await new Promise(r => setTimeout(r, 100));
    }
  };
  try {
    for (const resumed of [false, true]) {
      const events = [], questions = [], raw = [];
      p = new CodexProcess({ codexPath: 'codex', cwd, model: 'gpt-6-astra', permissionMode: 'bypassPermissions', effort: 'medium', resumeSessionId: resumed ? id : undefined }, {
        emit: e => events.push(e), onPermission: q => questions.push(q), onSessionId: s => id = s, onClose: () => {},
      });
      await p.start();
      p.rpc.on('notification', m => raw.push(m));
      const marker = resumed ? 'resumed-answer.txt' : 'new-answer.txt';
      console.log(`${resumed ? '恢复旧' : '新建'}会话：gpt-6-astra / medium / bypassPermissions`);
      p.sendUserMessage(`这是插件等待输入的集成测试。先调用 AskUserQuestion，问题 ID 为 choice，问题为“请选择测试结果”，选项 A 和 B；用户回答后，把答案写入当前目录的 ${marker}，最后回复完成。不要提前创建文件。`);
      await until(() => questions.length || events.some(e => e.kind === 'result'));
      assert.equal(questions.length, 1, '必须收到可回答的问题');
      assert.ok(raw.some(m => m.method === 'turn/completed' && m.params.turn.status === 'interrupted'), '展示问题前服务端必须确认中断');
      const from = raw.length;
      console.log('后端已中断，保持 65 秒不应答');
      await new Promise(r => setTimeout(r, 65000));
      assert.equal(p.isBusy, true);
      assert.equal(events.some(e => e.kind === 'result'), false);
      assert.equal(raw.slice(from).some(m => /^item\//.test(m.method) || m.method === 'turn/started'), false, '后端不能在等待期间执行任何工具或继续推理');
      await assert.rejects(fs.access(path.join(cwd, marker)));
      const waiting = await p.rpc.request('thread/read', { threadId: id, includeTurns: true });
      assert.equal(waiting.thread.turns.at(-1).status, 'interrupted');
      assert.equal(p.answerQuestion(questions[0].requestId, { choice: 'A' }), true);
      console.log('提交测试答案，检查新轮次恢复执行');
      await until(() => events.some(e => e.kind === 'result'));
      assert.equal(events.find(e => e.kind === 'result').isError, false);
      assert.match(await fs.readFile(path.join(cwd, marker), 'utf8'), /A/);
      console.log('等待期间无执行、回答后写入文件：通过');
      if (!resumed) await p.disposeAndWait();
    }
  } finally {
    if (p?.isBusy) await p.interrupt();
    if (id && p && !p.isExited) {
      try {
        await p.rpc.request('thread/archive', { threadId: id });
        await p.rpc.request('thread/delete', { threadId: id });
      } catch (e) { console.error('清理测试会话失败：' + e.message); process.exitCode = 1; }
    }
    await p?.disposeAndWait();
    await fs.rm(cwd, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
