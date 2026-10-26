const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CodexProcess, ChildThreadRegistry, childToolId } = require('../dist/test/codex/process.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
const metadata = (id, parentThreadId = 'root', sessionId = 'tree') => ({
  id, parentThreadId, sessionId, agentNickname: id, status: { type: 'active' },
});

function fixture(t) {
  const events = [], approvals = [], calls = [], responses = [], rejections = [], threads = new Map();
  const p = new CodexProcess({ codexPath: '/unused', cwd: process.cwd(), permissionMode: 'default' }, {
    emit: event => events.push(event), onPermission: request => approvals.push(request), onSessionId() {}, onClose() {},
  });
  p.sessionId = 'root'; p.turnId = 'root-turn'; p.busy = true;
  p.children.setRoot({ id: 'root', sessionId: 'tree' });
  const note = (method, threadId, params = {}) => p.notification({ method, params: { threadId, ...params } });
  p.rpc.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: threads.get(params.threadId) };
    if (method === 'turn/interrupt') queueMicrotask(() => note('turn/completed', params.threadId, {
      turn: { id: params.turnId, status: 'interrupted' },
    }));
    return {};
  };
  p.rpc.respond = (id, result) => responses.push({ id, result });
  p.rpc.reject = (id, message) => rejections.push({ id, message });
  const add = (id = 'child', parent = 'root') => {
    const thread = metadata(id, parent); threads.set(id, thread);
    p.notification({ method: 'thread/started', params: { thread } });
    note('turn/started', id, { turn: { id: `${id}-turn` } });
  };
  t.after(() => p.dispose());
  return { p, events, approvals, calls, responses, rejections, threads, note, add };
}

test('登记必须同时匹配父线程链和共享 session，昵称及 cwd 不能代替归属', () => {
  const r = new ChildThreadRegistry(); r.setRoot({ id: 'root', sessionId: 'tree' });
  assert.equal(r.register(metadata('external', 'other')), false);
  assert.equal(r.register(metadata('wrong-tree', 'root', 'other-tree')), false);
  assert.equal(r.register(metadata('root')), false);
  assert.equal(r.register(metadata('grandchild', 'child')), false);
  assert.equal(r.register(metadata('child')), true);
  assert.equal(r.register(metadata('grandchild', 'child')), true);
  assert.equal(r.register(metadata('child', 'grandchild')), false);
  r.setRoot({ id: 'other-root', sessionId: 'other-tree' }); assert.equal(r.has('child'), false);
});

test('子线程的文本、思考、用量及结束不覆盖根文流和轮次', t => {
  const f = fixture(t); f.add();
  f.note('item/agentMessage/delta', 'child', { turnId: 'child-turn', itemId: 'msg', delta: '子正文' });
  f.note('item/reasoning/textDelta', 'child', { turnId: 'child-turn', delta: '子思考' });
  f.note('thread/tokenUsage/updated', 'child', { tokenUsage: { last: { outputTokens: 123, totalTokens: 456 }, modelContextWindow: 1000 } });
  f.note('turn/completed', 'child', { turn: { id: 'child-turn', status: 'completed' } });
  assert.equal(f.p.turnId, 'root-turn'); assert.equal(f.p.isBusy, true);
  assert.equal(f.events.some(e => ['text_delta', 'thinking_delta', 'tokens', 'context', 'result'].includes(e.kind)), false);
});

test('同名工具通过复合 ID 隔离，子标签不会加入根正文', t => {
  const f = fixture(t); f.add('one'); f.add('two');
  const item = { id: 'same', type: 'commandExecution', command: 'rg x', cwd: '/tmp', status: 'inProgress' };
  for (const id of ['one', 'two']) f.note('item/started', id, { turnId: `${id}-turn`, item });
  const tools = f.events.filter(e => e.kind === 'tool_input');
  assert.equal(tools.length, 2); assert.notEqual(tools[0].toolId, tools[1].toolId);
  assert.equal(tools[0].toolId, childToolId('one', 'same'));
  assert.match(tools[0].agentLabel, /one/);
  f.note('item/completed', 'one', { turnId: 'one-turn', item: { ...item, status: 'completed', aggregatedOutput: 'ok' } });
  assert.equal(f.events.at(-1).toolUseId, tools[0].toolId);
});

test('子审批用原 RPC 返回，未知外部线程保持拒绝', async t => {
  const f = fixture(t); f.add();
  await f.p.request({ id: 19, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'child', turnId: 'child-turn', itemId: 'cmd', command: 'npm test',
  } });
  assert.match(f.approvals[0].displayName, /child/);
  assert.equal(f.p.respondPermission('19', { behavior: 'allow' }), true);
  assert.deepEqual(f.responses, [{ id: 19, result: { decision: 'accept' } }]);
  f.threads.set('external', metadata('external', 'other'));
  await f.p.request({ id: 20, method: 'item/commandExecution/requestApproval', params: { threadId: 'external', turnId: 'bad', itemId: 'cmd' } });
  assert.equal(f.rejections.length, 1); assert.equal(f.approvals.length, 1);
});

test('恢复后并发未知子请求合并一次元数据读取，父链也必须核验', async t => {
  const f = fixture(t);
  f.threads.set('child', metadata('child')); f.threads.set('grandchild', metadata('grandchild', 'child'));
  const params = { threadId: 'grandchild', turnId: 'g-turn', itemId: 'cmd', command: 'ls' };
  await Promise.all([1, 2].map(id => f.p.request({ id, method: 'item/commandExecution/requestApproval', params })));
  assert.deepEqual(f.calls.filter(c => c.method === 'thread/read').map(c => c.params.threadId), ['grandchild', 'child']);
  assert.equal(f.approvals.length, 2);
});

test('同时核验互为父节点的非法线程不会形成 Promise 死锁', async t => {
  const f = fixture(t); f.threads.set('a', metadata('a', 'b')); f.threads.set('b', metadata('b', 'a'));
  assert.deepEqual(await Promise.all([f.p.ensureChild('a'), f.p.ensureChild('b')]), [false, false]);
  assert.equal(f.p.childChecks.size, 0);
});

test('两个子问题各自等待并答原 RPC，图片或空答案不解除等待，不创建根轮次', async t => {
  const f = fixture(t); f.add('one'); f.add('two');
  const questions = [{ id: 'choice', question: '选择什么？', options: [{ label: 'A' }] }];
  await f.p.request({ id: 10, method: 'item/tool/call', params: { threadId: 'one', turnId: 'one-turn', callId: 'q1', tool: 'AskUserQuestion', arguments: { questions } } });
  await f.p.request({ id: 11, method: 'item/tool/requestUserInput', params: { threadId: 'two', turnId: 'two-turn', itemId: 'q2', questions, isBlocking: true } });
  assert.equal(f.p.isChildQuestion('10'), true); assert.equal(f.p.isChildQuestion('11'), true);
  assert.equal(f.p.answerChildQuestion('10', { choice: '' }), false);
  assert.throws(() => f.p.answerChildQuestion('10', { choice: 'A' }, { choice: [{ mediaType: 'image/png', data: 'YQ==' }] }), /不支持图片/);
  assert.equal(f.p.isChildQuestion('10'), true);
  assert.equal(f.p.answerChildQuestion('11', { choice: 'A' }), true);
  assert.deepEqual(f.responses[0], { id: 11, result: { answers: { choice: { answers: ['A'] } } } });
  assert.equal(f.p.answerChildQuestion('10', { choice: 'A' }), true);
  assert.deepEqual(JSON.parse(f.responses[1].result.contentItems[0].text), { answers: { choice: { answers: ['A'] } } });
  assert.equal(f.p.turnId, 'root-turn'); assert.equal(f.p.pausedQuestion, undefined);
  assert.equal(f.calls.some(c => ['turn/start', 'turn/interrupt'].includes(c.method)), false);
});

test('子任务私密问题的回答来源写入工具结果，历史只遮蔽私密输入',async t=>{
 const {timeline}=require('../dist/test/codex/events.js');
 for(const mode of ['custom','option','secret',undefined]){
  const f=fixture(t);f.add('child');
  const questions=[{id:'q',question:'生产支付配置',isSecret:true,options:[]}];
  await f.p.request({id:10,method:'item/tool/call',params:{threadId:'child',turnId:'child-turn',callId:'q',tool:'AskUserQuestion',arguments:{questions}}});
  assert.equal(f.p.answerChildQuestion('10',{q:'稍后提供'},undefined,mode?{q:mode}:undefined),true);
  const result=f.responses[0].result;
  const view=timeline([{items:[{id:'q',type:'dynamicToolCall',tool:'AskUserQuestion',arguments:{questions},...result}]}]);
  assert.equal(view[0].result,`"生产支付配置" = "${mode==='custom'||mode==='option'?'稍后提供':'（已填写）'}"`);
 }
});

test('子非致命错误保留根 busy，异步问题只停止发问子线程', async t => {
  const f = fixture(t); f.add();
  f.note('error', 'child', { turnId: 'child-turn', error: { message: 'child failed' } });
  assert.equal(f.events.at(-1).keepBusy, true);
  f.note('item/completed', 'child', { turnId: 'child-turn', item: {
    id: 'async-q', type: 'agentMessage', delivery: 'async', questions: [{ title: '选什么', options: ['A'] }],
  } });
  await flush();
  assert.deepEqual(f.calls.filter(c => c.method === 'turn/interrupt').map(c => c.params.threadId), ['child']);
  assert.equal(f.p.turnId, 'root-turn'); assert.equal(f.p.isBusy, true);
  assert.equal(f.events.some(e => e.kind === 'result'), false);
});

test('根问题恢复保留仍在等待的子问题，不清空其他线程的 RPC', async t => {
  const f = fixture(t); f.add();
  const questions = [{ id: 'q', question: '子问题', options: [{ label: 'A' }] }];
  await f.p.request({ id: 55, method: 'item/tool/requestUserInput', params: { threadId: 'child', turnId: 'child-turn', itemId: 'q', questions, isBlocking: true } });
  f.p.pending.set('root-question', { id: 56, method: 'item/tool/call', params: { threadId: 'root', arguments: { questions } } });
  f.p.pausedQuestion = { ready: true, turnId: 'root-turn', request: { requestId: 'root-question', input: { questions } } };
  f.p.sendUserMessage = () => true;
  assert.equal(f.p.answerQuestion('root-question', { q: 'A' }), true);
  assert.equal(f.p.pending.has('root-question'), false);
  assert.equal(f.p.pending.has('55'), true);
  assert.equal(f.p.answerChildQuestion('55', { q: 'A' }), true);
  assert.equal(f.responses[0].id, 55);
});

test('根结束先到时保留子任务，旧子 turn 完成不能结束新 turn', t => {
  const f = fixture(t); f.add();
  f.note('turn/started', 'child', { turn: { id: 'child-next' } });
  f.note('turn/completed', 'child', { turn: { id: 'child-turn', status: 'completed' } });
  f.note('turn/completed', 'root', { turn: { id: 'root-turn', status: 'completed' } });
  assert.equal(f.p.isBusy, true); assert.equal(f.events.some(e => e.kind === 'result'), false);
  f.note('turn/completed', 'child', { turn: { id: 'child-next', status: 'completed' } });
  assert.equal(f.p.isBusy, false); assert.equal(f.events.filter(e => e.kind === 'result').length, 1);
});

test('子线程关闭可解除等待，不要求缺失的 turn/completed', t => {
  const f = fixture(t); f.add();
  f.note('turn/completed', 'root', { turn: { id: 'root-turn', status: 'completed' } });
  f.note('thread/closed', 'child'); assert.equal(f.p.isBusy, false);
});

test('停止并发取消根和所有子线程，根先确认不会漏掉后来登记的子线程', async t => {
  const f = fixture(t); f.add('one'); f.add('two');
  const waiting = new Map();
  f.p.rpc.request = (method, params) => {
    f.calls.push({ method, params });
    return new Promise(resolve => waiting.set(params.threadId, { resolve, params }));
  };
  const stopping = f.p.interrupt(); await flush();
  assert.deepEqual(new Set(waiting.keys()), new Set(['one', 'two', 'root']));
  f.note('turn/completed', 'root', { turn: { id: 'root-turn', status: 'interrupted' } }); waiting.get('root').resolve({});
  assert.equal(f.p.isBusy, true);
  f.add('late'); await flush(); assert.ok(waiting.has('late'));
  for (const id of ['one', 'two', 'late']) {
    const row = waiting.get(id); f.note('turn/completed', id, { turn: { id: row.params.turnId || `${id}-turn`, status: 'interrupted' } }); row.resolve({});
  }
  await stopping; await flush();
  assert.equal(f.p.isBusy, false); assert.equal(f.events.filter(e => e.kind === 'result').length, 1);
});

test('输出 delta 每秒最多触发一次活动，不保存输出正文', t => {
  const f = fixture(t); f.p.lastActivityAt = 0;
  f.note('item/commandExecution/outputDelta', 'root', { delta: '' });
  assert.equal(f.events.length, 0);
  for (let i = 0; i < 100; i++) f.note('item/commandExecution/outputDelta', 'root', { delta: '不应保存的日志内容', itemId: 'log' });
  const activity = f.events.filter(e => e.kind === 'activity');
  assert.equal(activity.length, 1); assert.doesNotMatch(JSON.stringify(f.events), /不应保存/);
  assert.equal(f.p.tools.size, 0);
});

test('启动取消确认早于真实轮次完成时，再次取消新轮次而不误报停止', async t => {
  const f = fixture(t), waiting = [];
  f.p.stoppingTree = true;
  f.p.rpc.request = (method, params) => new Promise(resolve => waiting.push({ method, params, resolve }));
  f.p.notification({ method: 'thread/started', params: { thread: metadata('startup') } });
  assert.equal(waiting[0].params.turnId, '');
  f.note('turn/started', 'startup', { turn: { id: 'real-turn' } });
  waiting[0].resolve({}); await flush();
  assert.equal(waiting.length, 2); assert.equal(waiting[1].params.turnId, 'real-turn');
  assert.equal(f.p.children.get('startup').active, true);
  f.note('turn/completed', 'startup', { turn: { id: 'real-turn', status: 'interrupted' } });
  waiting[1].resolve({}); await flush(); assert.equal(f.p.children.get('startup').active, false);
});
