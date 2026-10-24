const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileUriToPath, hasUriScheme, isWindowsAbsolutePath, parseFileRef } = require('../dist/test/fileRef.js');
const { findWindowsOfflineCodex } = require('../dist/test/codex/rpc.js');

test('Windows 盘符路径不会被误判成 URI，文件 URI 可还原盘符和 UNC 路径', () => {
  assert.equal(isWindowsAbsolutePath('C:\\Users\\lin\\repo\\src\\main.ts'), true);
  assert.equal(isWindowsAbsolutePath('D:/work/repo/src/app.ts'), true);
  assert.equal(hasUriScheme('C:\\Users\\lin\\repo\\src\\main.ts'), false);
  assert.equal(hasUriScheme('D:/work/repo/src/app.ts'), false);
  assert.equal(hasUriScheme('https://example.com/file.ts'), true);
  assert.equal(fileUriToPath('file:///C:/Users/lin/My%20Repo/main.ts'), 'C:/Users/lin/My Repo/main.ts');
  assert.equal(fileUriToPath('file://server/share/My%20Repo/main.ts'), '//server/share/My Repo/main.ts');
  assert.deepEqual(parseFileRef('C:\\Users\\lin\\repo\\src\\main.ts:42'), {
    path: 'C:\\Users\\lin\\repo\\src\\main.ts', line: 42, endLine: undefined,
  });
});

test('自动发现 USERPROFILE 下 CodexCLI 版本目录中的离线 codex.exe', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cli-offline-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  for (const version of ['0.163.9', '0.164.0']) {
    const bin = path.join(profile, `CodexCLI-${version}`, 'bin');
    await fs.mkdir(bin, { recursive: true });
    const executable = path.join(bin, 'codex.exe');
    await fs.writeFile(executable, 'offline test executable');
    await fs.chmod(executable, 0o755);
  }
  assert.equal(findWindowsOfflineCodex(profile), path.join(profile, 'CodexCLI-0.164.0', 'bin', 'codex.exe'));
  assert.equal(findWindowsOfflineCodex(path.join(profile, 'missing')), undefined);
});
