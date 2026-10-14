const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DailyLogWriter, pruneLogs } = require('../dist/test/logging.js');

test('只保留最近七个本地日历日，过期日志即使 mtime 很新也清理', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date(2026, 9, 14, 12);
  for (let age = 0; age < 9; age++) {
    const date = new Date(2026, 9, 14 - age);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const file = path.join(dir, `codex-chat-${day}.log`);
    fs.writeFileSync(file, 'test');
    fs.utimesSync(file, now, now);
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  fs.symlinkSync(path.join(dir, 'notes.txt'), path.join(dir, 'codex-chat-2026-10-01.log'));
  pruneLogs(dir, now);
  const kept = fs.readdirSync(dir).filter(name => name.endsWith('.log') && !fs.lstatSync(path.join(dir, name)).isSymbolicLink());
  assert.equal(kept.length, 7);
  assert.ok(kept.includes('codex-chat-2026-10-08.log'));
  assert.ok(!kept.includes('codex-chat-2026-10-07.log'));
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'keep');
  assert.ok(fs.lstatSync(path.join(dir, 'codex-chat-2026-10-01.log')).isSymbolicLink());
});

test('长时间运行时跨天写新文件并清理第八天的旧日志', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const writer = new DailyLogWriter(dir);
  for (let day = 1; day <= 8; day++) writer.write(`line-${day}`, new Date(2026, 9, day, 23, 59));
  assert.ok(!fs.existsSync(path.join(dir, 'codex-chat-2026-10-01.log')));
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.log')).length, 7);
  assert.match(fs.readFileSync(path.join(dir, 'codex-chat-2026-10-08.log'), 'utf8'), /\[23:59:00\] line-8/);
});
