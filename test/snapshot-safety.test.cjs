const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const git = (cwd, ...args) => promisify(execFile)('git', args, { cwd });
const { WorkspaceSnapshot } = require('../dist/test/snapshot.js');
const limit = 2 * 1024 * 1024;

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-snapshot-safety-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('Git 忽略的缓存不占快照名额，已跟踪文件和反向规则仍备份，新文件仍可回滚', async t => {
  const dir = await fixture(t);
  await git(dir, 'init', '-q');
  await fs.mkdir(path.join(dir, 'cache'));
  await fs.writeFile(path.join(dir, '.gitignore'), 'cache/\n*.log\n!keep.log\n');
  await fs.writeFile(path.join(dir, 'source.ts'), '源码');
  await fs.writeFile(path.join(dir, 'keep.log'), '需要备份');
  await fs.writeFile(path.join(dir, 'cache/tracked.ts'), '已跟踪源码');
  await git(dir, 'add', '-f', '.gitignore', 'source.ts', 'cache/tracked.ts');
  for (let i = 0; i < 30; i++) await fs.writeFile(path.join(dir, `cache/${i}.txt`), '缓存');
  await fs.writeFile(path.join(dir, 'debug.log'), '日志');
  const snapshot = new WorkspaceSnapshot([dir], 4);
  await snapshot.capture();
  assert.deepEqual([...snapshot.files.keys()].map(p => path.relative(dir, p)).sort(),
    ['.gitignore', 'cache/tracked.ts', 'keep.log', 'source.ts']);
  assert.equal(snapshot.skipped.size, 0);
  await fs.unlink(path.join(dir, 'source.ts'));
  await fs.writeFile(path.join(dir, 'new.ts'), '新增源码');
  await fs.writeFile(path.join(dir, 'debug.log'), '新日志');
  const changes = await snapshot.changed();
  assert.equal(changes.get(path.join(dir, 'source.ts')), '源码');
  assert.equal(changes.get(path.join(dir, 'new.ts')), null);
  assert.equal(changes.has(path.join(dir, 'debug.log')), false);
  assert.equal(snapshot.unrestorableChanges.size, 0);
});

test('仓库子目录及换行中文文件名遵循 Git 忽略规则，不扫描仓库外文件', async t => {
  const dir = await fixture(t), root = path.join(dir, 'sub');
  await git(dir, 'init', '-q');
  await fs.mkdir(root);
  await fs.writeFile(path.join(dir, '.gitignore'), '/sub/cache/\n');
  await fs.mkdir(path.join(root, 'cache'));
  await fs.writeFile(path.join(root, 'cache/large.txt'), '缓存');
  const file = path.join(root, '中文\n源文件.ts');
  await fs.writeFile(file, '源码');
  await fs.writeFile(path.join(dir, 'outside.ts'), '外部源码');
  const snapshot = new WorkspaceSnapshot([root + path.sep], 1);
  await snapshot.capture();
  assert.deepEqual([...snapshot.files.keys()], [file]);
  assert.equal(snapshot.skipped.size, 0);
});

test('Git 不可用时退回目录扫描，保留源码备份而不是假装扫描成功', async t => {
  const dir = await fixture(t);
  await git(dir, 'init', '-q');
  const file = path.join(dir, 'source.ts');
  await fs.writeFile(file, '源码');
  const previous = process.env.PATH;
  process.env.PATH = path.join(dir, 'missing-tools');
  t.after(() => { process.env.PATH = previous; });
  const snapshot = new WorkspaceSnapshot([dir]);
  await snapshot.capture();
  assert.equal(snapshot.files.get(file), '源码');
  assert.equal(snapshot.skipped.size, 0);
});

test('Git worktree 的 .git 文件可识别，已跟踪但未提交的内容和删除状态按磁盘备份', async t => {
  const dir = await fixture(t), repo = path.join(dir, 'repo'), worktree = path.join(dir, 'worktree');
  await fs.mkdir(repo);
  await git(repo, 'init', '-q');
  await fs.writeFile(path.join(repo, '.gitignore'), 'cache/\n');
  await fs.writeFile(path.join(repo, 'source.ts'), '提交内容');
  await fs.writeFile(path.join(repo, 'deleted.ts'), '已删除内容');
  await git(repo, 'add', '.');
  await git(repo, '-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  await git(repo, 'worktree', 'add', '--detach', worktree);
  await fs.writeFile(path.join(worktree, 'source.ts'), '未提交内容');
  await fs.unlink(path.join(worktree, 'deleted.ts'));
  await fs.mkdir(path.join(worktree, 'cache'));
  await fs.writeFile(path.join(worktree, 'cache/generated.txt'), '缓存');
  const snapshot = new WorkspaceSnapshot([worktree]);
  await snapshot.capture();
  assert.equal(snapshot.files.get(path.join(worktree, 'source.ts')), '未提交内容');
  assert.equal(snapshot.files.has(path.join(worktree, 'deleted.ts')), false);
  assert.equal(snapshot.files.has(path.join(worktree, 'cache/generated.txt')), false);
  assert.equal(snapshot.skipped.size, 0);
  await fs.writeFile(path.join(worktree, 'deleted.ts'), '本轮重新创建');
  assert.equal((await snapshot.changed()).get(path.join(worktree, 'deleted.ts')), null);
});

test('嵌套 Git 仓库作为目录列出时仍备份其源码，不跟随工作区外符号链接', async t => {
  const dir = await fixture(t), root = path.join(dir, 'repo'), nested = path.join(root, 'nested');
  await fs.mkdir(root); await git(root, 'init', '-q');
  await fs.mkdir(nested); await git(nested, 'init', '-q');
  const file = path.join(nested, 'source.ts'), outside = path.join(dir, 'outside.ts');
  await fs.writeFile(file, '嵌套源码'); await fs.writeFile(outside, '外部内容');
  await git(nested, 'add', '.');
  await git(nested, '-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  await git(root, 'add', 'nested');
  await fs.symlink(outside, path.join(root, 'linked.ts'));
  const snapshot = new WorkspaceSnapshot([root]);
  await snapshot.capture();
  assert.equal(snapshot.files.get(file), '嵌套源码');
  assert.equal(snapshot.files.has(outside), false);
  assert.equal(snapshot.skipReasons.get(path.join(root, 'linked.ts')), 'symlink');
});

test('重叠工作区不会重复计算同一个文件的容量，33 MiB 不误报超过 64 MiB', async t => {
  const dir = await fixture(t), nested = path.join(dir, 'nested');
  await fs.mkdir(nested);
  const text = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 33; i++) await fs.writeFile(path.join(nested, `${i}.txt`), text);
  const snapshot = new WorkspaceSnapshot([dir, nested]);
  await snapshot.capture();
  assert.equal(snapshot.files.size, 33);
  assert.equal(snapshot.skipped.size, 0);
});

test('文件在检查大小后继续增长，快照读取仍有硬上限且释放句柄', async t => {
  const dir = await fixture(t), file = path.join(dir, 'growing.txt');
  await fs.writeFile(file, 'x'.repeat(limit + 10000));
  const lstat = fs.lstat.bind(fs), stat = fs.stat.bind(fs), open = fs.open.bind(fs);
  const small = { size: 1, isFile: () => true, isSymbolicLink: () => false };
  t.mock.method(fs, 'stat', async (p, ...args) => p === file && !args[0]?.bigint ? small : stat(p, ...args));
  t.mock.method(fs, 'lstat', async (p, ...args) => p === file && !args[0]?.bigint ? small : lstat(p, ...args));
  let bytes = 0, closed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.stat = async () => small;
    handle.read = async (...input) => { const result = await read(...input); bytes += result.bytesRead; return result; };
    handle.close = async () => { closed = true; return close(); };
    return handle;
  });
  const snapshot = new WorkspaceSnapshot([dir]);
  await snapshot.capture();
  assert.equal(snapshot.files.has(file), false);
  assert.equal(snapshot.skipReasons.get(file), 'large');
  assert.ok(bytes <= limit + 1);
  assert.equal(closed, true);
});

test('收尾读取失败不伪造文件删除或改动，保留明确的回滚不完整标记', async t => {
  const dir = await fixture(t), file = path.join(dir, 'source.ts');
  await fs.writeFile(file, '原文');
  const snapshot = new WorkspaceSnapshot([dir]);
  await snapshot.capture();
  for (const method of ['readFile', 'open']) {
    const original = fs[method].bind(fs);
    t.mock.method(fs, method, async (p, ...args) => {
      if (p === file) throw Object.assign(new Error('读取被拒绝'), { code: 'EACCES' });
      return original(p, ...args);
    });
  }
  assert.equal((await snapshot.changed()).size, 0);
  assert.equal(snapshot.unrestorableChanges.has(file), true);
});

test('扫描后文件被替换成符号链接时，不读取链接指向的工作区外正文', async t => {
  const dir = await fixture(t), root = path.join(dir, 'project');
  await fs.mkdir(root);
  const file = path.join(root, 'source.ts'), outside = path.join(dir, 'outside.ts');
  await fs.writeFile(file, '原文'); await fs.writeFile(outside, '外部内容');
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (p, ...args) => {
    if (p === file) { await fs.unlink(file); await fs.symlink(outside, file); }
    return open(p, ...args);
  });
  const snapshot = new WorkspaceSnapshot([root]);
  await snapshot.capture();
  assert.equal(snapshot.files.has(file), false);
  assert.equal(snapshot.skipReasons.get(file), 'symlink');
});
