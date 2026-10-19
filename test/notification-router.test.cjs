const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { NotificationRouter } = require('../dist/test/notificationRouter.js');

test('点击端点只接受持有完整随机地址的本机 POST，不接受网页来源和任意会话', async t => {
  const router = new NotificationRouter(), opened = [];
  t.after(() => router.dispose());
  const url = await router.endpoint('known-session', async () => opened.push('known-session'));
  for (const [target, options] of [
    [url, {}], [url, { method: 'POST', headers: { Origin: 'https://example.com' } }],
    [url + '?session=other', { method: 'POST' }],
    [url.replace(/[^/]+$/, randomUUID()), { method: 'POST' }],
  ]) assert.equal((await fetch(target, options)).status, 404);
  assert.deepEqual(opened, []);
  assert.equal((await fetch(url, { method: 'POST' })).status, 204);
  assert.deepEqual(opened, ['known-session']);
});

test('并发生成地址复用本窗监听，打开失败可再次点击，重载后旧地址失效且不转给新窗', async t => {
  const old = new NotificationRouter(), reloaded = new NotificationRouter();
  t.after(() => { old.dispose(); reloaded.dispose(); });
  let fail = true, attempts = 0;
  const action = async () => { attempts++; if (fail) throw new Error('打开失败'); };
  const [url, same, other] = await Promise.all([
    old.endpoint('session', action), old.endpoint('session', action), old.endpoint('branch', async () => {}),
  ]);
  assert.equal(url, same);
  assert.notEqual(url, other);
  assert.equal(new URL(url).origin, new URL(other).origin);
  assert.equal((await fetch(url, { method: 'POST' })).status, 500);
  fail = false;
  assert.equal((await fetch(url, { method: 'POST' })).status, 204);
  assert.equal(attempts, 2);
  old.dispose();
  const fresh = await reloaded.endpoint('session', async () => assert.fail('旧通知不能进入新窗口'));
  assert.notEqual(url, fresh);
  try { assert.equal((await fetch(url, { method: 'POST' })).status, 404); }
  catch (error) { assert.equal(error.name, 'TypeError'); }
  await assert.rejects(old.endpoint('session', action), /已关闭/);
});

test('窗口在点击监听启动期间关闭，启动不能留下可用的旧地址', async () => {
  const router = new NotificationRouter();
  const pending = router.endpoint('session', async () => assert.fail('已关闭窗口不能打开'));
  router.dispose();
  await assert.rejects(pending, /已关闭/);
});

test('激活预检返回来源主进程但不打开会话；拒绝无效进程、网页、未知操作和已关闭窗口', async t => {
  const router = new NotificationRouter(12345), invalid = new NotificationRouter(NaN);
  t.after(() => { router.dispose(); invalid.dispose(); });
  let opened = 0;
  const url = await router.endpoint('session', async () => opened++);
  const prepare = { method: 'POST', headers: { 'X-Codex-Notification-Action': 'prepare' } };
  const response = await fetch(url, prepare);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { pid: 12345 });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(opened, 0);
  assert.equal((await fetch(url, { ...prepare, headers: { ...prepare.headers, Origin: 'https://example.com' } })).status, 404);
  assert.equal((await fetch(url, { ...prepare, headers: { 'X-Codex-Notification-Action': 'unknown' } })).status, 404);
  const bad = await invalid.endpoint('session', async () => assert.fail('预检不能打开会话'));
  assert.equal((await fetch(bad, prepare)).status, 503);
  assert.equal((await fetch(url, { method: 'POST' })).status, 204);
  assert.equal(opened, 1);
  router.dispose();
  await assert.rejects(fetch(url, prepare), { name: 'TypeError' });
});
