const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WorkdayCalendar, parseHolidayYear, parseQuietHours, isFeishuWebhook, chinaDate } = require('../dist/test/workdayCalendar.js');

const DAY = 86400000;
const hours = { enabled: true, start: '08:30', end: '18:00' };
const at = text => new Date(`${text}+08:00`);
const annual = year => ({ year, papers: [`https://www.gov.cn/calendar/${year}`], days: [
  { date: `${year}-10-01`, name: '国庆节', isOffDay: true },
  { date: `${year}-10-10`, name: '国庆节', isOffDay: false },
] });
const json = data => ({ ok: true, text: async () => JSON.stringify(data) });
async function setup(t, fetcher) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-calendar-test-'));
  const calls = [], logs = [];
  const calendar = new WorkdayCalendar(dir, line => logs.push(line), () => {}, async (url, options) => {
    calls.push(url);
    return fetcher ? fetcher(url, options) : json(annual(Number(url.match(/(\d{4})\.json$/)[1])));
  });
  t.after(async () => { calendar.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  return { calendar, calls, logs, dir };
}

test('同日时间校验、开关默认关闭和飞书主机严格识别', () => {
  assert.deepEqual(parseQuietHours(hours), hours);
  for (const value of [undefined, {}, { ...hours, start: '8:30' }, { ...hours, start: '25:00' },
    { ...hours, end: '08:30' }, { ...hours, end: '07:00' }, { ...hours, enabled: 'true' }]) assert.equal(parseQuietHours(value), undefined);
  assert.equal(isFeishuWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/x'), true);
  assert.equal(isFeishuWebhook('https://open.larksuite.com/open-apis/bot/v2/hook/x'), true);
  for (const url of ['https://open.feishu.cn.evil.invalid', 'https://example.invalid/open.feishu.cn', 'bad']) assert.equal(isFeishuWebhook(url), false);
});

test('北京时间的日期与分钟不依赖进程所在时区', () => {
  assert.deepEqual(chinaDate(new Date('2026-10-11T16:30:00Z')), { date: '2026-10-12', time: '00:30', year: 2026, month: 10, weekday: 1 });
});

test('普通工作日静默、法定假期和普通周末推送、周六补班静默', async t => {
  const { calendar } = await setup(t);
  await calendar.refresh(false, at('2026-10-01T08:00:00'));
  assert.equal(calendar.shouldMute(hours, at('2026-10-01T09:00:00')), false);
  await calendar.refresh(false, at('2026-10-10T08:00:00'));
  assert.equal(calendar.shouldMute(hours, at('2026-10-10T09:00:00')), true);
  assert.equal(calendar.shouldMute(hours, at('2026-10-11T09:00:00')), false);
  assert.equal(calendar.shouldMute(hours, at('2026-10-12T09:00:00')), true);
  assert.equal(calendar.shouldMute({ ...hours, enabled: false }, at('2026-10-12T09:00:00')), false);
});

test('08:30 起静默，18:00 整恢复，自定义时段生效', async t => {
  const { calendar } = await setup(t);
  await calendar.refresh(false, at('2026-10-12T00:00:00'));
  for (const [time, expected] of [['08:29:59', false], ['08:30:00', true], ['17:59:59', true], ['18:00:00', false]]) {
    assert.equal(calendar.shouldMute(hours, at(`2026-10-12T${time}`)), expected, time);
  }
  assert.equal(calendar.shouldMute({ ...hours, start: '10:00', end: '12:00' }, at('2026-10-12T09:00:00')), false);
});

test('日历每日更新，通知并发复用请求，下一年度提前下载', async t => {
  const { calendar, calls } = await setup(t);
  const now = at('2026-10-12T08:00:00');
  await Promise.all([calendar.refresh(false, now), calendar.refresh(false, now)]);
  assert.equal(calls.length, 2);
  assert.ok(calls.some(url => url.endsWith('/2027.json')));
  await calendar.refresh(false, new Date(+now + DAY - 1));
  assert.equal(calls.length, 2);
  await calendar.refresh(false, new Date(+now + DAY));
  assert.equal(calls.length, 4);
  await calendar.refresh(true, new Date(+now + DAY + 1));
  assert.equal(calls.length, 6);
});

test('重启加载磁盘缓存；断网用七天内缓存，过期和无数据不静默', async t => {
  const { calendar, dir } = await setup(t);
  const start = at('2026-10-12T08:00:00');
  await calendar.refresh(false, start);
  const calls = [];
  const offline = new WorkdayCalendar(dir, () => {}, () => {}, async url => { calls.push(url); throw new Error('离线'); });
  t.after(() => offline.dispose());
  await offline.refresh(false, new Date(+start + 3600000));
  assert.equal(calls.length, 0);
  assert.equal(offline.shouldMute(hours, new Date(+start + 3600000)), true);
  await offline.refresh(false, new Date(+start + 2 * DAY));
  assert.equal(calls.length, 4, '两个年度都尝试主源与镜像');
  assert.equal(offline.shouldMute(hours, at('2026-10-14T09:00:00')), true);
  await offline.refresh(false, new Date(+start + 2 * DAY + 1000));
  assert.equal(calls.length, 4, '失败后一小时内不重复请求');
  assert.equal(offline.shouldMute(hours, at('2026-10-19T09:00:00')), false);
  const empty = await setup(t, async () => { throw new Error('离线'); });
  await empty.calendar.refresh(false, start);
  assert.equal(empty.calendar.shouldMute(hours, at('2026-10-12T09:00:00')), false);
});

test('主源不可用时使用公开镜像，并拒绝错误年份、损坏日期、重复日期和未发布数据', async t => {
  const { calendar, calls } = await setup(t, async url => {
    if (url.includes('raw.githubusercontent')) throw new Error('无法连接');
    return json(annual(Number(url.match(/(\d{4})\.json$/)[1])));
  });
  await calendar.refresh(false, at('2026-10-12T08:00:00'));
  assert.equal(calls.length, 4);
  assert.equal(calendar.shouldMute(hours, at('2026-10-12T09:00:00')), true);
  assert.throws(() => parseHolidayYear(annual(2025), 2026));
  assert.throws(() => parseHolidayYear({ ...annual(2026), days: [{ date: '2026-02-30', name: '无效', isOffDay: false }] }, 2026));
  assert.throws(() => parseHolidayYear({ ...annual(2026), days: [annual(2026).days[0], annual(2026).days[0]] }, 2026));
  assert.throws(() => parseHolidayYear({ ...annual(2026), papers: [] }, 2026));
  const unpublished = await setup(t, async url => json({ year: Number(url.match(/(\d{4})\.json$/)[1]), papers: [], days: [] }));
  await unpublished.calendar.refresh(false, at('2026-10-12T08:00:00'));
  assert.equal(unpublished.calendar.shouldMute(hours, at('2026-10-12T09:00:00')), false);
});

test('12 月检查次年安排，跨年补班/放假覆盖普通星期规则，缺次年数据不静默', async t => {
  const { calendar } = await setup(t, async url => {
    const year = Number(url.match(/(\d{4})\.json$/)[1]), data = annual(year);
    if (year === 2027) data.days.push({ date: '2026-12-27', name: '元旦', isOffDay: false }, { date: '2026-12-31', name: '元旦', isOffDay: true });
    return json(data);
  });
  await calendar.refresh(false, at('2026-12-27T08:00:00'));
  assert.equal(calendar.shouldMute(hours, at('2026-12-27T09:00:00')), true);
  assert.equal(calendar.shouldMute(hours, at('2026-12-31T09:00:00')), false);
  const missing = await setup(t, async url => json(url.endsWith('/2027.json') ? { year: 2027, days: [], papers: [] } : annual(2026)));
  await missing.calendar.refresh(false, at('2026-12-28T08:00:00'));
  assert.equal(missing.calendar.shouldMute(hours, at('2026-12-28T09:00:00')), false);
});

test('关闭开关不安排联网，启用后定期刷新，销毁清理定时器', async t => {
  const { calendar } = await setup(t);
  let checks = 0;
  calendar.refresh = async () => { checks++; };
  t.mock.timers.enable({ apis: ['setInterval'] });
  calendar.configure(false);
  t.mock.timers.tick(DAY);
  assert.equal(checks, 0);
  calendar.configure(true);
  assert.equal(checks, 1);
  t.mock.timers.tick(3600000);
  assert.equal(checks, 2);
  calendar.configure(false);
  t.mock.timers.tick(DAY);
  assert.equal(checks, 2);
  calendar.configure(true);
  calendar.dispose();
  t.mock.timers.tick(DAY);
  assert.equal(checks, 3);
});
