// 执行修改前后的真实队列推进方法，比较排队卡片的提醒调度。
const fs = require('node:fs');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const ts = require('typescript');
const assert = require('node:assert/strict');
async function measure(source) {
  const method = source.slice(source.indexOf('    private resolvePendingPermission('), source.indexOf('    private onSessionId('));
  const start = source.indexOf('    private refreshWaitingNotification(');
  const helper = start < 0 ? '' : source.slice(start, source.indexOf('    private maybeNotifyWaiting(', start));
  const code = ts.transpile(`class Provider { ${method} ${helper} }; Provider;`, {target: ts.ScriptTarget.ES2022});
  const Provider = vm.runInNewContext(code, {Date, queueMicrotask});
  const p = new Provider();let reminders = 0;
  p.alive = () => false;p.maybeNotifyWaiting = () => reminders++;
  const first = {kind:'permission_request',requestId:'first'}, second = {kind:'permission_request',requestId:'second',toolName:'AskUserQuestion'};
  const ctx = {pendingPerm:first,pendingPerms:new Map([['first',first],['second',second]])};
  p.resolvePendingPermission(ctx, 'first');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.pendingPerm, second);
  return {visiblePendingCards:1, remindersScheduled:reminders};
}
(async () => {
  const before = await measure(execFileSync('git',['show','494a3c8:src/panel/chatViewProvider.ts'],{encoding:'utf8'}));
  const after = await measure(fs.readFileSync('src/panel/chatViewProvider.ts','utf8'));
  assert.equal(before.remindersScheduled,0);assert.equal(after.remindersScheduled,1);
  const report = {version:require('../package.json').version,baselineCommit:'494a3c8',at:new Date().toISOString(),
    scenario:'前一审批结束，下一排队问题转为待处理；执行生产队列推进方法，隔离提醒发送',before,after,
    nativeQueue:{before:'系统回调不返回时，同会话队列无内部截止时间，外层30秒超时不能释放队列',
      after:'原生操作20秒期限内结算并释放队列，按请求截止时间拒绝迟到操作，终态只结算一次',
      evidence:'test/notification-native-queue.test.cjs 编译生产Swift实现注入授权/查询/提交回调丢失、迟到、拒绝、过期及后续恢复；测试缩短期限为150ms'},
    limits:['这份对比是源码测试，不等同于历史通知故障已恢复或实际横幅可见','系统已经接受的提交不能可靠撤销，超时后不会盲目重发']};
  fs.writeFileSync('benchmarks/notification-recovery.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
