#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const lock = path.join(process.cwd(), 'writer.pid');
const reply = (id, result, error) => process.stdout.write(JSON.stringify(error ? { id, error } : { id, result }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'thread/fork') {
    fs.writeFileSync(lock, String(process.pid));
    return reply(m.id, { thread: { id: 'forked-thread' } });
  }
  if (m.method === 'thread/list') return reply(m.id, { data: [], nextCursor: null });
  if (m.method === 'thread/read') return reply(m.id, { thread: { id: 'forked-thread', historyMode: 'full', turns: [{ id: 'turn-1', items: [] }] } });
  if (m.method === 'thread/resume') {
    try {
      process.kill(Number(fs.readFileSync(lock, 'utf8')), 0);
      return reply(m.id, undefined, { code: -32600, message: 'already has an active writer' });
    } catch { return reply(m.id, { thread: { id: 'forked-thread' } }); }
  }
  reply(m.id, {});
});
