const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DailyLogWriter, pruneLogs } = require('../dist/test/logging.js');

test('只保留最近七个本地日历日，过期日志即使 mtime 很新也清理', async t => {
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
  await pruneLogs(dir, now);
  const kept = fs.readdirSync(dir).filter(name => name.endsWith('.log') && !fs.lstatSync(path.join(dir, name)).isSymbolicLink());
  assert.equal(kept.length, 7);
  assert.ok(kept.includes('codex-chat-2026-10-08.log'));
  assert.ok(!kept.includes('codex-chat-2026-10-07.log'));
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'keep');
  assert.ok(fs.lstatSync(path.join(dir, 'codex-chat-2026-10-01.log')).isSymbolicLink());
});

test('长时间运行时跨天写新文件并清理第八天的旧日志', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const writer = new DailyLogWriter(dir);
  for (let day = 1; day <= 8; day++) writer.write(`line-${day}`, new Date(2026, 9, day, 23, 59));
  await writer.dispose();
  assert.ok(!fs.existsSync(path.join(dir, 'codex-chat-2026-10-01.log')));
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.log')).length, 7);
  assert.match(fs.readFileSync(path.join(dir, 'codex-chat-2026-10-08.log'), 'utf8'), /\[23:59:00\] line-8/);
});

test('大量日志异步批量追加，连续 flush 保持顺序，关闭前排空', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-batch-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const writer=new DailyLogWriter(dir);let writes=0;
  const append=fs.promises.appendFile;
  fs.promises.appendFile=async(...args)=>{writes++;return append(...args);};
  t.after(()=>fs.promises.appendFile=append);
  const now=new Date(2026,9,15,12);
  for(let i=0;i<1000;i++)writer.write('line-'+i,now);
  assert.equal(writes,0);
  const first=writer.flush();writer.write('last',now);
  await Promise.all([first,writer.flush(),writer.dispose()]);
  const text=fs.readFileSync(path.join(dir,'codex-chat-2026-10-15.log'),'utf8');
  assert.equal(text.trim().split('\n').length,1001);assert.match(text,/line-999\n\[12:00:00\] last\n$/);
  assert.ok(writes<=2);writer.write('after-close',now);await writer.flush();
  assert.doesNotMatch(fs.readFileSync(path.join(dir,'codex-chat-2026-10-15.log'),'utf8'),/after-close/);
});

test('日志缓冲有上限并标记丢弃，磁盘错误不影响调用方', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-log-cap-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const writer=new DailyLogWriter(dir),now=new Date(2026,9,15,12);
  for(let i=0;i<1000;i++)writer.write('x'.repeat(2000),now);
  await writer.dispose();const text=fs.readFileSync(path.join(dir,'codex-chat-2026-10-15.log'),'utf8');
  assert.ok(Buffer.byteLength(text)<1024*1024+200);assert.match(text,/droppedLines=\d+/);
  const file=path.join(dir,'not-a-directory');fs.writeFileSync(file,'x');
  const broken=new DailyLogWriter(file);broken.write('test');await assert.doesNotReject(broken.dispose());
});

test('日志构造、写入和过期清理均不调用同步文件 API，输出通道也按批更新',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-async-only-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const names=['mkdirSync','readdirSync','lstatSync','unlinkSync','appendFileSync'];
  const originals=Object.fromEntries(names.map(name=>[name,fs[name]]));
  const batches=[];
  try {
    for(const name of names)fs[name]=()=>{throw new Error('禁止同步日志 I/O: '+name);};
    const writer=new DailyLogWriter(dir,{pluginVersion:'0.1.124',windowId:'window-a',hostId:'123'},text=>batches.push(text));
    for(let i=0;i<1000;i++)writer.write('row-'+i,new Date(2026,9,15,12));
    assert.equal(batches.length,0);
    await writer.dispose();assert.equal(batches.length,1);await writer.prune(new Date(2026,9,15));
  } finally {for(const name of names)fs[name]=originals[name];}
  const text=fs.readFileSync(path.join(dir,'codex-chat-2026-10-15.log'),'utf8');
  assert.equal(text.trim().split('\n').length,1000);
  assert.match(text,/pluginVersion=0\.1\.124 windowId=window-a hostId=123/);
});

test('慢磁盘追加期间事件循环和日志入队继续运行',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-slow-log-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const append=fs.promises.appendFile;let release,started;
  const waiting=new Promise(resolve=>started=resolve);
  fs.promises.appendFile=async(...args)=>{if(!release){await new Promise(resolve=>{release=resolve;started();});}return append(...args);};
  t.after(()=>fs.promises.appendFile=append);
  const writer=new DailyLogWriter(dir);writer.write('first');const flushing=writer.flush();
  await waiting;
  let responsive=false;await new Promise(resolve=>setImmediate(()=>{responsive=true;resolve();}));
  for(let i=0;i<100;i++)writer.write('while-disk-pending-'+i);
  assert.equal(responsive,true);release();await flushing;await writer.dispose();
  const text=fs.readFileSync(path.join(dir,fs.readdirSync(dir).find(name=>name.endsWith('.log'))),'utf8');
  assert.equal(text.trim().split('\n').length,101);
});

test('多窗口共享日志文件时保留各自加载版本，报告逐任务识别版本和来源',async t=>{
  const {readPerformanceReport}=require('../dist/test/diagnosticsReport.js');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-window-log-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const identity={pluginVersion:'0.1.123',windowId:'old-window',hostId:'11'};
  const old=new DailyLogWriter(dir,identity);identity.pluginVersion='0.1.124';
  const fresh=new DailyLogWriter(dir,{pluginVersion:'0.1.124',windowId:'new-window',hostId:'22'});
  const row=id=>'[perf] '+JSON.stringify({schema:1,event:'turn_summary',traceId:id,elapsedMs:10,toolCount:0,failures:0,phasesMs:{}});
  old.write(row('trace-old'));fresh.write(row('trace-new'));old.write(row('trace-old-second'));
  await Promise.all([old.dispose(),fresh.dispose()]);
  const report=await readPerformanceReport(dir);
  assert.match(report,/0\.1\.123 \| old-window \| 11 \| 2/);
  assert.match(report,/0\.1\.124 \| new-window \| 22 \| 1/);
  assert.match(report,/trace-old \| 0\.1\.123 \/ old-wind/);
  assert.match(report,/trace-new \| 0\.1\.124 \/ new-wind/);
});
