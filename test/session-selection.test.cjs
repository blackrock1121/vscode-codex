const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const Module = require('node:module');
const { SessionStore } = require('../dist/test/codex/session.js');
const vscode = { window: {} };
const originalLoad = Module._load;
Module._load = function(id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); };
const { ChatViewProvider } = require('../dist/test/panel/chatViewProvider.js');
Module._load = originalLoad;

function sidebar(t) {
  const sent = [], errors = [];
  const provider = Object.create(ChatViewProvider.prototype);
  const dom = new JSDOM(provider.sidebarHtml(), { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.acquireVsCodeApi = () => ({ postMessage: m => sent.push(JSON.parse(JSON.stringify(m))) });
  w.addEventListener('error', e => errors.push(e.message));
  w.eval(w.document.querySelector('script').textContent);
  const $ = id => w.document.getElementById(id);
  const emit = data => w.dispatchEvent(new w.MessageEvent('message', { data }));
  const row = id => w.document.querySelector(`.row[data-id="${id}"]`);
  const click = (id, options = {}, checkbox = false) => (checkbox ? row(id).querySelector('.chk') : row(id))
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ...options }));
  const selected = () => [...w.document.querySelectorAll('.chk:checked')].map(chk => chk.closest('.row').dataset.id);
  const sessions = [
    { id: 'a', title: '最近 A', updatedAt: 500 },
    { id: 'b', title: '置顶 B', pinned: true, updatedAt: 400 },
    { id: 'c', title: '最近 C', updatedAt: 300 },
    { id: 'd', title: '置顶 D', pinned: true, updatedAt: 200 },
    { id: 'e', title: '最近 E', updatedAt: 100 },
  ];
  emit({ kind: 'sessions', list: sessions });
  t.after(() => assert.deepEqual(errors, []));
  return { w, $, emit, sent, row, click, selected, sessions };
}

test('重命名允许复制粘贴快捷键冒泡，中文选词不提交，后台更新保留草稿与选区',t=>{
 const f=sidebar(t);f.row('a').querySelector('.edit').click();const input=f.row('a').querySelector('.rename');
 input.value='正在修改中文标题';input.setSelectionRange(2,5);
 const bubbled=[];f.w.addEventListener('keydown',e=>bubbled.push(e.key));
 for(const key of ['c','v','x','a'])input.dispatchEvent(new f.w.KeyboardEvent('keydown',{key,metaKey:true,bubbles:true,cancelable:true}));
 assert.deepEqual(bubbled,['c','v','x','a']);
 input.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
 assert.equal(f.sent.some(m=>m.type==='renameSession'),false);
 f.emit({kind:'running',sessionIds:['b']});f.emit({kind:'sessions',list:f.sessions});
 assert.equal(f.row('a').querySelector('.rename'),input);assert.equal(input.value,'正在修改中文标题');assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,5);
 input.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 assert.equal(f.sent.filter(m=>m.type==='renameSession').length,1);assert.equal(f.sent.at(-1).title,'正在修改中文标题');
 assert.equal(f.w.document.querySelector('.rename'),null);assert.ok(f.row('b').querySelector('.run-dot'));
});

test('Shift 按实际显示顺序跨置顶分组选取，支持反向和复选框，原地更新保留焦点', t => {
  const f = sidebar(t);
  f.$('multi').click();
  const first = f.row('d'), checkbox = first.querySelector('.chk');
  checkbox.focus(); f.click('d', {}, true);
  f.click('c', { shiftKey: true });
  assert.deepEqual(f.selected(), ['d', 'a', 'c']);
  assert.equal(f.w.document.activeElement, checkbox);
  assert.equal(f.row('d'), first);
  f.click('b', { shiftKey: true }, true);
  assert.deepEqual(f.selected(), ['b', 'd', 'a', 'c']);
  f.click('a', { shiftKey: true }, true);
  assert.deepEqual(f.selected(), ['c'], 'Shift 取消选中同样作用于连续范围');
  assert.equal(f.$('selection-count').textContent, '已选 1 项');
  assert.equal(f.sent.some(m => m.type === 'openSession'), false);
});

test('普通点击仍打开会话，Shift 或 Ctrl/⌘ 点击可直接进入多选；刷新按 ID 保留锚点', t => {
  const f = sidebar(t);
  f.click('d'); assert.equal(f.sent.at(-1).type, 'openSession');
  f.emit({ kind: 'running', sessionIds: ['a'] });
  f.click('c', { shiftKey: true });
  assert.deepEqual(f.selected(), ['d', 'a', 'c']);
  f.$('multi').click();
  f.click('e', { metaKey: true });
  assert.deepEqual(f.selected(), ['e']);
  f.emit({ kind: 'sessions', list: f.sessions.filter(s => s.id !== 'e') });
  f.click('b', { shiftKey: true });
  assert.deepEqual(f.selected(), ['b'], '锚点被移除后只选择当前项');
});

test('全选按钮可取消全选，快捷键重复执行仍全选，重命名输入不被劫持，空列表不可删除', t => {
  const f = sidebar(t);
  f.$('multi').click(); f.$('selectall').click();
  assert.deepEqual(f.selected(), ['b', 'd', 'a', 'c', 'e']);
  assert.equal(f.$('selectall').textContent, '取消全选');
  f.$('selectall').click(); assert.deepEqual(f.selected(), []);
  assert.equal(f.$('delsel').disabled, true);
  const key = (target, options) => target.dispatchEvent(new f.w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options }));
  key(f.row('b').querySelector('.chk'), { key: 'a', metaKey: true });
  key(f.w.document.body, { key: 'a', ctrlKey: true });
  assert.equal(f.selected().length, 5);
  key(f.w.document.body, { key: 'Escape' });
  assert.equal(f.w.document.body.classList.contains('multi'), false);
  f.row('a').querySelector('.edit').click();
  const input = f.row('a').querySelector('.rename');
  assert.equal(key(input, { key: 'a', metaKey: true }), true);
  assert.equal(f.w.document.body.classList.contains('multi'), false);
  f.emit({ kind: 'sessions', list: [] });
  f.$('multi').click();
  assert.equal(f.$('selectall').disabled, true); assert.equal(f.$('delsel').disabled, true);
});

test('删除请求防重复，取消保留选择，部分失败显示原因并保留失败项，成功后退出多选', t => {
  const f = sidebar(t);
  f.$('multi').click(); f.click('a'); f.click('c');
  f.$('delsel').click(); f.$('delsel').click(); f.click('e');
  assert.deepEqual(f.sent.filter(m => m.type === 'deleteSessions'), [{ type: 'deleteSessions', sessionIds: ['a', 'c'] }]);
  assert.equal(f.$('multi').disabled, true);
  assert.match(f.$('delete-status').textContent, /确认/);
  f.emit({ kind: 'sessions_delete_status', busy: false, message: '已取消删除。', deletedIds: [] });
  assert.deepEqual(f.selected(), ['a', 'c']); assert.equal(f.$('delsel').disabled, false);
  f.$('delsel').click();
  f.emit({ kind: 'sessions_delete_status', busy: true, message: '正在删除 1/2…' });
  assert.match(f.$('delete-status').textContent, /1\/2/);
  f.emit({ kind: 'sessions', list: f.sessions.filter(s => s.id !== 'a') });
  f.emit({ kind: 'sessions_delete_status', busy: false, message: '仍被派生会话引用', error: true, deletedIds: ['a'], failedIds: ['c'] });
  assert.deepEqual(f.selected(), ['c']); assert.equal(f.$('delete-status').getAttribute('role'), 'alert');
  f.$('delsel').click();
  f.emit({ kind: 'sessions', list: f.sessions.filter(s => !['a', 'c'].includes(s.id)) });
  assert.equal(f.w.document.body.classList.contains('multi'), true, '列表更新不等同于删除完成');
  f.emit({ kind: 'sessions_delete_status', busy: false, message: '已删除 1 个会话。', deletedIds: ['c'] });
  assert.equal(f.w.document.body.classList.contains('multi'), false);
  assert.equal(f.$('multi').disabled, false);
});

test('永久删除直接调用 delete；失败不归档且缓存不丢，缺失 rollout 不再被归档阶段阻断', async () => {
  for (const fail of [true, false]) {
    const store = new SessionStore('/tmp', () => '/unused'), calls = [];
    store.threads.set('a', { id: 'a', preview: '记录', updatedAt: 1 });
    store.notePending('a', '草稿');
    store.connection = async () => ({ request: async method => {
      calls.push(method);
      assert.equal(method, 'thread/delete', '归档会因缺失 rollout 提前报错');
      if (fail) throw new Error('cannot delete thread a: forked history still references it (-32600)');
      return {};
    } });
    if (fail) await assert.rejects(store.delete('a'), /forked history/);
    else assert.equal(await store.delete('a'), true);
    assert.deepEqual(calls, ['thread/delete']);
    assert.equal(store.list().length, fail ? 1 : 0);
    assert.equal(store.pending.has('a'), fail);
  }
});

test('删除顺序由派生依赖决定而不是时间或点击顺序，不扩大选择，重复和异常环不死循环', () => {
  const store = new SessionStore('/tmp', () => '/unused');
  store.threads.set('b', { id: 'b', forkedFromId: 'a' });
  store.threads.set('c', { id: 'c', forkedFromId: 'b' });
  store.threads.set('unselected', { id: 'unselected', forkedFromId: 'a' });
  assert.deepEqual(store.deletionOrder(['a', 'b', 'c', 'a']), ['c', 'b', 'a']);
  assert.deepEqual(store.deletionOrder(['a']), ['a']);
  store.threads.set('a', { id: 'a', forkedFromId: 'c' });
  assert.deepEqual(new Set(store.deletionOrder(['a', 'b', 'c'])), new Set(['a', 'b', 'c']));
});

test('删除期间旧分页晚到也不能把已删除会话放回列表', async () => {
  const store = new SessionStore('/tmp', () => '/unused');
  const releases = [];
  store.read = async () => new Promise(resolve => { releases.push(resolve); });
  store.connection = async () => ({ request: async () => ({}) });
  const refreshing = store.refresh();
  await store.delete('a');
  for (const release of releases) release({ data: [{ id: 'a', preview: '旧列表', updatedAt: 1 }], nextCursor: null });
  await refreshing;
  assert.deepEqual(store.list(), []);
});

test('归档与未归档列表各自完整分页，保持项目范围、去重并按时间合并', async () => {
  const store = new SessionStore('/project', () => '/unused'), calls = [];
  store.read = async (method, params) => {
    assert.equal(method, 'thread/list');
    assert.equal(params.cwd, '/project');
    assert.deepEqual(params.modelProviders, []);
    calls.push([params.archived, params.cursor]);
    const id = params.archived ? (params.cursor ? 'old-2' : 'old-1') : (params.cursor ? 'new-2' : 'new-1');
    return { data: [{ id, preview: id, updatedAt: params.archived ? 3 : 2 },
      ...(params.archived && params.cursor ? [{ id: 'new-1', preview: 'new-1', updatedAt: 4 }] : [])],
      nextCursor: params.cursor ? null : 'same-cursor' };
  };
  await store.refresh();
  assert.deepEqual(calls.filter(c => c[0]), [[true, null], [true, 'same-cursor']]);
  assert.deepEqual(calls.filter(c => !c[0]), [[false, null], [false, 'same-cursor']]);
  assert.deepEqual(store.list().map(s => [s.id, s.archived]), [
    ['new-1', true], ['old-1', true], ['old-2', true], ['new-2', false],
  ]);
});

test('归档列表读取失败保留完整旧列表及待显示记录，下次刷新可恢复', async () => {
  const store = new SessionStore('/project', () => '/unused');
  store.threads.set('old', { id: 'old', preview: '旧归档', updatedAt: 1, archived: true });
  store.notePending('new', '新记录');
  store.read = async (_, params) => {
    if (params.archived) throw new Error('归档查询失败');
    return { data: [{ id: 'new', preview: '新记录', updatedAt: 2 }], nextCursor: null };
  };
  await assert.rejects(store.refresh(), /归档查询失败/);
  assert.equal(store.list().some(s => s.id === 'old' && s.archived), true);
  assert.equal(store.pending.has('new'), true);
  store.read = async (_, params) => ({ data: params.archived ? [] : [{ id: 'new', preview: '新记录', updatedAt: 2 }], nextCursor: null });
  await store.refresh();
  assert.deepEqual(store.list().map(s => s.id), ['new']);
  assert.equal(store.pending.has('new'), false);
});

test('读取归档会话历史与叠加待显示标题后仍保留归档标记，删除仍调用永久删除接口', async () => {
  const store = new SessionStore('/project', () => '/unused'), calls = [];
  store.threads.set('old', { id: 'old', preview: '', updatedAt: 1, archived: true });
  store.connection = async () => ({ request: async (method, params) => {
    calls.push([method, params.threadId]);
    return { thread: { id: 'old', preview: '', updatedAt: 1, turns: [] } };
  } });
  await store.hydrate('old');
  store.notePending('old', '归档标题');
  assert.equal(store.list()[0].archived, true);
  assert.equal(store.list()[0].title, '归档标题');
  await store.delete('old');
  assert.deepEqual(calls.at(-1), ['thread/delete', 'old']);
  assert.deepEqual(store.list(), []);
});

test('侧边栏标注归档状态，不修改标题，归档会话可单独及批量选择删除', t => {
  const f = sidebar(t);
  f.emit({ kind: 'sessions', list: f.sessions.map(s => ({ ...s, archived: s.id === 'c' })) });
  assert.match(f.row('c').querySelector('.meta').textContent, /^已归档/);
  assert.equal(f.row('c').querySelector('.t').textContent, '最近 C');
  assert.doesNotMatch(f.row('a').querySelector('.meta').textContent, /已归档/);
  f.row('c').querySelector('.del').click();
  assert.deepEqual(f.sent.at(-1), { type: 'deleteSessions', sessionIds: ['c'] });
  f.emit({ kind: 'sessions_delete_status', busy: false, message: '已取消删除。', deletedIds: [] });
  f.$('multi').click(); f.$('selectall').click(); f.$('delsel').click();
  assert.equal(f.sent.at(-1).sessionIds.includes('c'), true);
});

test('打开归档历史不预热恢复，后端拒绝继续时保留原会话与历史', async () => {
  const provider = Object.create(ChatViewProvider.prototype), events = [];
  const ctx = { sessionId: 'old', blank: false };
  provider.store = new SessionStore('/project', () => '/unused');
  provider.store.threads.set('old', { id: 'old', archived: true });
  provider.maybePrespawn(ctx); // 不应访问配置或启动进程。
  assert.equal(ctx.proc, undefined);
  let disposed = false;
  provider.speedMode = () => 'default';
  provider.createProcess = () => ({ start: async () => { throw new Error('session old is archived'); }, dispose: () => { disposed = true; } });
  provider.output = { appendLine() {} };
  provider.post = (_, event) => events.push(event);
  provider.refreshSessions = () => {};
  assert.equal(await provider.spawnProcess(ctx), undefined);
  assert.equal(disposed, true);
  assert.equal(ctx.sessionId, 'old'); assert.equal(ctx.blank, false);
  assert.equal(events.some(e => e.kind === 'load_history'), false);
  assert.match(events.at(-1).message, /历史和输入内容已保留/);
});

function host(t, { confirm = async () => '删除', remove = async () => true } = {}) {
  const provider = Object.create(ChatViewProvider.prototype), events = [], logs = [], errors = [], removed = [];
  const store = new SessionStore('/tmp', () => '/unused');
  for (const id of ['a', 'b', 'c']) store.threads.set(id, { id, preview: id, updatedAt: 1 });
  store.threads.get('b').forkedFromId = 'a';
  store.delete = async id => { removed.push(id); await remove(id); store.threads.delete(id); return true; };
  store.refresh = async () => {};
  Object.assign(provider, {
    store, sessions: new Set(), detached: new Map(), output: { appendLine: line => logs.push(line) },
    view: { webview: { postMessage: event => events.push(event) } },
    context: { workspaceState: { get: () => undefined, update: async () => {} } },
    broadcastRunning() {}, withPinned: list => list,
    storageDir: () => { throw new Error('测试清理失败，不得把已删除误报为失败'); },
  });
  vscode.window.showWarningMessage = confirm;
  vscode.window.showErrorMessage = message => { errors.push(message); return Promise.resolve(); };
  return { provider, store, events, logs, errors, removed };
}

test('宿主删除先处理派生会话，单项失败仍继续，刷新列表并明确报告成功和失败', async t => {
  const f = host(t, { remove: async id => { if (id === 'a') throw new Error('forked history still references it (-32600)'); } });
  await f.provider.onSidebarMessage({ type: 'deleteSessions', sessionIds: ['a', 'b', 'c', 'a'] });
  assert.deepEqual(f.removed, ['b', 'a', 'c']);
  const result = f.events.at(-1);
  assert.equal(result.busy, false); assert.equal(result.error, true);
  assert.deepEqual(result.deletedIds, ['b', 'c']); assert.deepEqual(result.failedIds, ['a']);
  assert.match(result.message, /已删除 2 个会话/); assert.match(result.message, /派生会话/);
  assert.equal(f.errors.length, 1); assert.equal(f.provider.deletingSessions, false);
  assert.deepEqual(f.events.findLast(e => e.kind === 'sessions').list.map(s => s.id), ['a']);
});

test('宿主确认期间防重复；取消和异常都结束等待且不删除', async t => {
  let resolve;
  const f = host(t, { confirm: () => new Promise(r => { resolve = r; }) });
  const pending = f.provider.deleteSessions(['a']);
  await f.provider.deleteSessions(['a']);
  assert.equal(f.events.filter(e => e.kind === 'sessions_delete_status').length, 1);
  resolve(undefined); await pending;
  assert.deepEqual(f.removed, []); assert.equal(f.events.at(-1).busy, false);
  assert.match(f.events.at(-1).message, /取消/);
  vscode.window.showWarningMessage = async () => { throw new Error('确认窗口失败'); };
  await f.provider.deleteSessions(['a']);
  assert.equal(f.events.at(-1).error, true); assert.equal(f.events.at(-1).busy, false);
  assert.deepEqual(f.removed, []); assert.equal(f.provider.deletingSessions, false);
});
