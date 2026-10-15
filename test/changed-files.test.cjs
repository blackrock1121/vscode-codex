const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { readDiffFile } = require('../dist/test/diff.js');
const { CheckpointManager } = require('../dist/test/checkpoints.js');
const originalLoad = Module._load;
Module._load = function(id, ...args) {
  if (id === 'vscode') return { workspace: { asRelativePath: file => path.basename(file) }, Uri: { from: value => value } };
  return originalLoad.call(this, id, ...args);
};
const { ChatViewProvider } = require('../dist/test/panel/chatViewProvider.js');
Module._load = originalLoad;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-changed-files-'));
  const checkpoints = new CheckpointManager(path.join(dir, 'state'));
  checkpoints.setSession('session'); checkpoints.beginTurn('修改文件', 0, true);
  t.after(async () => { checkpoints.flush(); await fs.rm(dir, { recursive: true, force: true }); });
  const ctx = { sessionId: 'session', checkpoints };
  const messages = [], logs = [];
  const provider = Object.create(ChatViewProvider.prototype);
  Object.assign(provider, {
    sessions: new Set([ctx]), output: { appendLine: value => logs.push(value) },
    post: (_, message) => messages.push(message), origChanged: { fire: () => {} },
  });
  return { dir, ctx, checkpoints, provider, messages, logs };
}

test('GB 级新增镜像不读取正文，二进制和空文件保留在回滚列表且不虚报行数', async t => {
  const f = await fixture(t);
  const files = Object.fromEntries(['disk.img', 'binary.dat', 'invalid.dat', 'new.txt', 'empty.txt', 'gone.txt'].map(name => [name, path.join(f.dir, name)]));
  const disk = await fs.open(files['disk.img'], 'w');
  await disk.truncate(1173159936); await disk.close();
  await fs.writeFile(files['binary.dat'], Buffer.from([1, 0, 2, 10, 3]));
  await fs.writeFile(files['invalid.dat'], Buffer.from([0xff, 0xfe, 0x61]));
  await fs.writeFile(files['new.txt'], '第一行\n第二行\n');
  await fs.writeFile(files['empty.txt'], '');
  for (const file of Object.values(files)) f.checkpoints.recordSnapshot(file, null);
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (file, ...args) => {
    assert.notEqual(file, files['disk.img'], '大文件只检查元数据，不打开读取正文');
    return open(file, ...args);
  });
  const { files: changed, totalAdded, totalRemoved } = await f.provider.getChangedFiles(f.ctx);
  assert.equal(changed.length, 5); assert.equal(totalAdded, 2); assert.equal(totalRemoved, 0);
  assert.equal(changed.find(x => x.rel === 'disk.img').diffUnavailable, 'large');
  for (const name of ['binary.dat', 'invalid.dat']) assert.equal(changed.find(x => x.rel === name).diffUnavailable, 'binary');
  assert.equal(changed.find(x => x.rel === 'empty.txt').status, 'added');
  assert.equal(changed.some(x => x.rel === 'gone.txt'), false);
});

test('文件在 stat 后增长时仍只读取至 2 MiB 上限，不泄漏文件句柄', async t => {
  const f = await fixture(t), file = path.join(f.dir, 'growing.txt');
  const limit = 2 * 1024 * 1024;
  await fs.writeFile(file, 'x'.repeat(limit + 4096));
  const stat = fs.stat.bind(fs), open = fs.open.bind(fs);
  let bytes = 0, closed = false;
  t.mock.method(fs, 'stat', async target => target === file ? { size: 4, isFile: () => true } : stat(target));
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = async (...readArgs) => { const result = await read(...readArgs); bytes += result.bytesRead; return result; };
    handle.close = async () => { closed = true; return close(); };
    return handle;
  });
  assert.deepEqual(await readDiffFile(file), { exists: true, unavailable: 'large' });
  assert.equal(bytes, limit + 1); assert.equal(closed, true);
});

test('普通文本修改、删除、UTF-8 边界和 BOM 保持准确', async t => {
  const f = await fixture(t), modified = path.join(f.dir, 'modified.txt'), deleted = path.join(f.dir, 'deleted.txt');
  await fs.writeFile(modified, 'A\n新内容\nC');
  f.checkpoints.recordSnapshot(modified, 'A\n旧内容\nC');
  f.checkpoints.recordSnapshot(deleted, '被删内容\n');
  f.checkpoints.recordSnapshot(path.join(f.dir, 'empty-deleted.txt'), '');
  const changes = await f.provider.getChangedFiles(f.ctx);
  assert.equal(changes.totalAdded, 1); assert.equal(changes.totalRemoved, 2);
  assert.equal(changes.files.find(x => x.path === deleted).status, 'deleted');
  assert.equal(changes.files.find(x => x.rel === 'empty-deleted.txt').status, 'deleted');
  const boundary = path.join(f.dir, 'boundary.txt'), text = '\uFEFF' + 'x'.repeat(65532) + '中文';
  await fs.writeFile(boundary, text);
  assert.deepEqual(await readDiffFile(boundary), { exists: true, text });
});

test('连续文件刷新合并执行；读取未结束时仍可处理停止，旧结果不覆盖新结果', async t => {
  const f = await fixture(t), releases = [];
  let reads = 0, interrupted = false;
  f.provider.getChangedFiles = () => { reads++; return new Promise(resolve => releases.push(resolve)); };
  f.ctx.proc = { isBusy: true, interrupt: async () => { interrupted = true; } };
  f.provider.refreshChangedFiles(f.ctx); await tick();
  for (let i = 0; i < 20; i++) f.provider.refreshChangedFiles(f.ctx);
  await f.provider.stopContext(f.ctx);
  assert.equal(interrupted, true); assert.equal(reads, 1);
  releases.shift()({ files: [], totalAdded: 99, totalRemoved: 0 }); await tick();
  assert.equal(reads, 2); assert.equal(f.messages.some(m => m.kind === 'changed_files'), false);
  releases.shift()({ files: [], totalAdded: 1, totalRemoved: 0 });
  await f.ctx.changedFilesRefresh;
  assert.equal(f.messages.filter(m => m.kind === 'changed_files').length, 1);
  assert.equal(f.messages.at(-1).totalAdded, 1);
});

test('切换或关闭会话后，迟到的文件列表不写入当前界面', async t => {
  for (const close of [false, true]) {
    const f = await fixture(t); let release;
    f.provider.getChangedFiles = () => new Promise(resolve => { release = resolve; });
    f.provider.refreshChangedFiles(f.ctx); await tick();
    if (close) f.provider.sessions.delete(f.ctx); else f.ctx.sessionId = 'other';
    release({ files: [], totalAdded: 1, totalRemoved: 0 }); await f.ctx.changedFilesRefresh;
    assert.equal(f.messages.length, 0);
  }
});

test('批量保留或回滚读取期间切换会话，不操作新会话的文件', async t => {
  for (const type of ['acceptAll', 'revertAll']) {
    const f = await fixture(t); let release;
    f.provider.getChangedFiles = () => new Promise(resolve => { release = resolve; });
    const pending = f.provider.onPanelMessage(f.ctx, { type });
    await tick();
    f.ctx.sessionId = 'other';
    f.ctx.checkpoints = { accept: () => assert.fail('不能接受新会话改动') };
    f.provider.revertFile = () => assert.fail('不能回滚新会话文件');
    release({ files: [{ path: '/tmp/old-file.txt' }], totalAdded: 0, totalRemoved: 0 });
    await pending;
    assert.equal(f.messages.length, 0);
  }
});

test('后台结束先显示整理还原点，停止完成不再等待文件列表刷新', async t => {
  const f = await fixture(t); let release;
  f.ctx.mayHaveModifiedWorkspace = true;
  f.ctx.snapshot = { changed: async () => new Map(), unrestorableChanges: new Set() };
  f.provider.notificationVersion = () => 0;
  f.provider.handleEmitInner = (_, event) => f.messages.push(event);
  f.provider.getChangedFiles = () => new Promise(resolve => { release = resolve; });
  const result = { kind: 'result', isError: false };
  f.provider.handleEmit(f.ctx, result);
  assert.deepEqual(f.messages, [{ kind: 'finalizing' }]);
  await f.ctx.finalizing; await tick();
  assert.equal(typeof release, 'function');
  assert.deepEqual(f.messages, [{ kind: 'finalizing' }, { kind: 'busy', busy: false }, result]);
  assert.equal(f.ctx.snapshot, undefined);
  release({ files: [], totalAdded: 0, totalRemoved: 0 }); await f.ctx.changedFilesRefresh;
});
