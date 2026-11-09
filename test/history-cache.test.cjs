const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionStore } = require('../dist/test/codex/session.js');
const thread = id => ({ id, name: '保留标题', updatedAt: 123, archived: true,
  turns: [{ id: 'turn', items: [{ type: 'userMessage', content: [{ type: 'text', text: '保留历史' }] }] }] });

test('闲置正文过期释放，列表、轮数及归档属性保留，重新读取恢复完整历史', async () => {
  const store = new SessionStore('/tmp', () => '/unused');
  store.threads.set('idle', thread('idle'));
  store.pruneHistory(new Set(), 0); store.pruneHistory(new Set(), 299_999);
  assert.equal(store.load('idle')[0].text, '保留历史');
  store.pruneHistory(new Set(), 300_000);
  assert.equal(store.threads.get('idle').turns, undefined);
  assert.equal(store.list()[0].messageCount, 1); assert.equal(store.list()[0].title, '保留标题');
  assert.equal(store.isArchived('idle'), true); assert.equal(store.countLines('idle'), 1);
  store.read = async (_, params) => ({ data: params.archived ? [{ ...thread('idle'), turns: [] }] : [], nextCursor: null });
  await store.refresh(); assert.equal(store.countLines('idle'), 1);
  assert.equal(store.threads.get('idle').turns, undefined);
  store.connection = async () => ({ request: async () => ({ thread: thread('idle') }) });
  await store.hydrate('idle'); assert.equal(store.load('idle')[0].text, '保留历史');
  assert.equal(store.rewindLeafFor('idle', 1), 'turn');
  store.dispose();
});

test('活动、正在读取及派生的正文受保护，重新使用后空闲期限重算', () => {
  const store = new SessionStore('/tmp', () => '/unused');
  for (const id of ['active', 'reading', 'reused']) store.threads.set(id, thread(id));
  store.pruneHistory(new Set(), 0);
  store.hydrating.set('reading', Promise.resolve());
  store.pruneHistory(new Set(['active', 'reused']), 300_000);
  for (const id of ['active', 'reading', 'reused']) assert.ok(store.threads.get(id).turns);
  store.pruneHistory(new Set(['active']), 300_001);
  store.pruneHistory(new Set(['active']), 600_000); assert.ok(store.threads.get('reused').turns);
  store.pruneHistory(new Set(['active']), 600_001); assert.equal(store.threads.get('reused').turns, undefined);
  store.preparations.add({ dispose: async () => {} });
  store.pruneHistory(new Set(), 900_001); assert.ok(store.threads.get('active').turns);
  store.dispose();
});
