const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CheckpointManager } = require('../dist/test/checkpoints.js');
const { WorkspaceSnapshot } = require('../dist/test/snapshot.js');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-concurrent-restore-'));
  const root = path.join(dir, 'project'), storage = path.join(dir, 'state');
  await fs.mkdir(root);
  const file = path.join(root, 'source.txt');
  await fs.writeFile(file, '原文');
  const managers = [];
  const manager = id => {
    const cp = new CheckpointManager(storage); cp.setSession(id); managers.push(cp); return cp;
  };
  const start = async (cp, text, roots = [root]) => {
    cp.startWorkspaceActivity(roots);
    const snapshot = new WorkspaceSnapshot(roots); await snapshot.capture();
    const id = cp.beginTurn(text, cp.list().length, true);
    return { cp, snapshot, id };
  };
  const finish = async turn => {
    for (const [file, content] of await turn.snapshot.changed()) turn.cp.recordSnapshot(file, content);
    turn.cp.completeSnapshot(); turn.cp.flush();
  };
  t.after(async () => {
    for (const cp of managers) { cp.finishWorkspaceActivity(); cp.flush(); }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { root, storage, file, manager, start, finish };
}

test('A/B 并行修改，停止 B 后还原到第一条消息前不会删除 A 的适配代码、版本和新增预览', async t => {
  const f = await fixture(t), a = f.manager('a'), b = f.manager('b');
  const first = await f.start(a, '手机适配'), second = await f.start(b, '另一项工作');
  const version = path.join(f.root, 'package.json'), preview = path.join(f.root, 'preview.html');
  await fs.writeFile(f.file, 'A 的手机适配代码');
  await fs.writeFile(version, '{"version":"2.5.11"}'); await fs.writeFile(preview, 'A 的预览');
  const own = path.join(f.root, 'b.txt'); await fs.writeFile(own, 'B 的修改');
  await f.finish(second);
  assert.throws(() => b.restore(second.id), /还有会话正在执行|其他会话同时/);
  await f.finish(first);
  CheckpointManager.deleteFor(f.storage, 'a');
  const reopened = f.manager('b');
  assert.throws(() => reopened.restore(second.id), /其他会话同时/);
  assert.match(reopened.fileRestoreBlockReason(undefined, f.file), /其他会话同时/);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'A 的手机适配代码');
  assert.equal(await fs.readFile(version, 'utf8'), '{"version":"2.5.11"}');
  assert.equal(await fs.readFile(preview, 'utf8'), 'A 的预览');
  assert.equal(await fs.readFile(own, 'utf8'), 'B 的修改');
  assert.equal(reopened.list()[0].id, second.id);
});

test('顺序执行且没有外部改动时，仍支持修改、删除、新建及已保留文件的完整还原', async t => {
  const f = await fixture(t), cp = f.manager('single');
  const removed = path.join(f.root, 'deleted.txt'), added = path.join(f.root, 'new.bin');
  await fs.writeFile(removed, '删除前');
  const first = await f.start(cp, '第一轮');
  await fs.writeFile(f.file, '第一轮完成'); await fs.unlink(removed); await fs.writeFile(added, Buffer.from([0, 1]));
  await f.finish(first); cp.accept(f.file);
  const second = await f.start(cp, '第二轮');
  await fs.writeFile(f.file, '第二轮完成'); await f.finish(second);
  assert.equal(cp.restore(first.id).restoredFiles, 3);
  assert.equal(await fs.readFile(f.file, 'utf8'), '原文');
  assert.equal(await fs.readFile(removed, 'utf8'), '删除前');
  await assert.rejects(fs.access(added), { code: 'ENOENT' });
});

test('同一轮保留文件后再次编辑，不把重复备份误判为轮次之间的外部修改', async t => {
  const f = await fixture(t), cp = f.manager('single'), turn = await f.start(cp, '修改');
  cp.recordSnapshot(f.file, '原文'); cp.accept(f.file);
  await fs.writeFile(f.file, '再次修改'); await f.finish(turn);
  assert.equal(cp.restore(turn.id).restoredFiles, 1);
  assert.equal(await fs.readFile(f.file, 'utf8'), '原文');
});

for (const change of ['修改', '删除', '重建']) {
  test(`结束后外部${change}目标文件，整次还原拒绝且不先覆盖其他文件`, async t => {
    const f = await fixture(t), cp = f.manager('single'), turn = await f.start(cp, '修改');
    const another = path.join(f.root, 'another.txt');
    await fs.writeFile(f.file, '本会话完成'); await fs.writeFile(another, '应保留');
    await f.finish(turn);
    if (change === '删除') await fs.unlink(f.file);
    else if (change === '重建') { await fs.unlink(f.file); await fs.writeFile(f.file, '外部重新创建'); }
    else await fs.writeFile(f.file, '外部新修改');
    assert.throws(() => cp.restore(turn.id), /文件又被修改/);
    assert.equal(await fs.readFile(another, 'utf8'), '应保留');
    assert.equal(cp.list()[0].id, turn.id);
  });
}

test('另一会话夹在两轮之间改同一文件，即使当前指纹匹配也不能回滚掉它', async t => {
  const f = await fixture(t), cp = f.manager('b');
  const first = await f.start(cp, 'B 第一轮'); await fs.writeFile(f.file, 'B1'); await f.finish(first);
  await fs.writeFile(f.file, 'A 的中间修改');
  const second = await f.start(cp, 'B 第二轮'); await fs.writeFile(f.file, 'B2'); await f.finish(second);
  assert.throws(() => cp.restore(first.id), /轮次之间存在其他来源的修改/);
  assert.equal(cp.restore(second.id).restoredFiles, 1);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'A 的中间修改');
});

test('关闭快照的并行任务和基线扫描期间启动的任务也会被识别', async t => {
  const f = await fixture(t), a = f.manager('a'), b = f.manager('b');
  a.startWorkspaceActivity([f.root]);
  const turn = await f.start(b, 'B'); await fs.writeFile(f.file, 'A/B 混合改动');
  a.beginTurn('A 关闭快照', 0, false); a.finishWorkspaceActivity();
  await f.finish(turn);
  assert.throws(() => b.restore(turn.id), /其他会话同时/);
});

test('不同工作区同时执行可以各自还原，嵌套工作区仍视为重叠', async t => {
  const f = await fixture(t), other = path.join(f.root, '..', 'other'); await fs.mkdir(other);
  const a = f.manager('a'), b = f.manager('b');
  const first = await f.start(a, 'A'); b.startWorkspaceActivity([other]);
  await fs.writeFile(f.file, 'A 修改'); await f.finish(first);
  assert.equal(a.restore(first.id).restoredFiles, 1);
  b.finishWorkspaceActivity();
  const nested = path.join(f.root, 'nested'); await fs.mkdir(nested);
  const second = await f.start(a, 'A2'); b.startWorkspaceActivity([nested]);
  await fs.writeFile(f.file, 'A2 修改'); b.finishWorkspaceActivity(); await f.finish(second);
  assert.throws(() => a.restore(second.id), /其他会话同时/);
});

test('旧还原点及丢失并行记录的还原点均拒绝覆盖，不伪装成功', async t => {
  for (const legacy of [true, false]) {
    const f = await fixture(t), cp = f.manager('source'), turn = await f.start(cp, '修改');
    await fs.writeFile(f.file, '保留成果'); await f.finish(turn);
    if (legacy) {
      const file = path.join(f.storage, 'checkpoints-source.json');
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      delete data.checkpoints[0].activityId;
      await fs.writeFile(file, JSON.stringify(data));
    } else await fs.rm(path.join(f.storage, 'workspace-activity'), { recursive: true });
    assert.throws(() => f.manager('source').restore(turn.id), /缺少并行保护|无法验证/);
    assert.equal(await fs.readFile(f.file, 'utf8'), '保留成果');
  }
});

test('另一个扩展宿主进程完成或异常退出后，并行证据仍可检测；新任务可继续', async t => {
  for (const crash of [false, true]) {
    const f = await fixture(t), cp = f.manager('a'), turn = await f.start(cp, 'A');
    const modulePath = path.resolve('dist/test/checkpoints.js');
    execFileSync(process.execPath, ['-e', `
      const { CheckpointManager } = require(${JSON.stringify(modulePath)});
      const cp = new CheckpointManager(process.argv[1]); cp.setSession('child');
      cp.startWorkspaceActivity([process.argv[2]]); cp.beginTurn('B', 0, true);
      require('node:fs').writeFileSync(require('node:path').join(process.argv[2], 'source.txt'), 'B 的成果');
      if (process.argv[3] === 'false') cp.completeSnapshot();
      cp.flush();
    `, f.storage, f.root, String(crash)], { timeout: 5000 });
    await f.finish(turn);
    assert.throws(() => cp.restore(turn.id), /其他会话同时|还有会话正在执行/);
    const next = await f.start(cp, '新任务');
    await fs.writeFile(f.file, '新任务改动'); await f.finish(next);
    assert.equal(cp.restore(next.id).restoredFiles, 1);
    assert.equal(await fs.readFile(f.file, 'utf8'), 'B 的成果');
  }
});

test('收尾不重新采纳后续修改为结束指纹，工作区别名仍能识别正在执行的会话', async t => {
  const f = await fixture(t), cp = f.manager('a'), turn = await f.start(cp, 'A');
  await fs.writeFile(f.file, 'A 修改'); await f.finish(turn);
  await fs.writeFile(f.file, '用户后续编辑'); cp.completeSnapshot();
  assert.throws(() => cp.restore(turn.id), /文件又被修改/);
  await fs.writeFile(f.file, 'A 修改');
  const alias = path.join(f.root, '..', 'alias'); await fs.symlink(f.root, alias);
  f.manager('b').startWorkspaceActivity([alias]);
  assert.throws(() => cp.restore(turn.id), /还有会话正在执行/);
});
