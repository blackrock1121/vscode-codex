// 对原报告每一个位置保留基线源码与调用链判断，不修改自动审查规则或隐藏候选。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),baseline='2eeb5e57bec2955656b5a31de7a52362af452689';
const report=fs.readFileSync(process.argv[2]||'/Users/duodian/.codex-chat/diagnostics/afefb855-38d6-4ff4-9400-b75242324b63.report.md','utf8');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const boundaries={
 'src/checkpoints.ts':{
  restore:'restore → panel.restoreCheckpoint/forkRewind。356 的 ENOENT 仅为不存在的目标；其它预检错误经 372 包装后上抛。395 记录失败并回滚 touched 文件，回滚失败有 checkpoint.restore.recovery；最终抛出并保留还原点，非假成功。外层统一记录，不在每个文件重复记日志。',
 },
 'src/diagnosticHealth.ts':{failed:'独立 console/output 健康出口限流到一次；最终出口自身也失败时不递归。recovered 携带 lostRecords。磁盘永久不可写不承诺落盘。'},
 'src/diagnostics/jobs.ts':{
  alive:'process.kill(pid,0) 为存活探测，EPERM 视为存活，非故障吞没。',
  workerRunner:'本次修复：worker error/exit/timeout/progress 异常统一唯一终态，错误对象穿过 execute 不再丢弃 failureId/errorCode；取消是 cancelled，成功是 completed。',
  then:'mutations 的 previous.catch 只释放失败队列，原 next 返回调用方；save、execute、page 各自记录真正失败。',
  lock:'EEXIST 是有界锁竞争；所有权检查失败后只按陈旧时间判定，不删除存活进程有效锁；非 EEXIST 传播。清理失败单独 diagnostics.lock.cleanup。',
  dispose:'关闭时中止 controllers，await allSettled(tasks)；每个 execute 自带失败或取消终态，task.catch 记录剩余异常。',
  batch:'get 失败为 diagnostics.record.read 并增加 listWarning；过期进程记录锁内再次核验，不覆盖其它窗口刚写的完成状态。',
  finally:'starting.finally/task.finally 仅释放引用；原异步返回值保留拒绝，实际 execute/save/page 出口已记录。',
  execute:'开始、结果原子保存、完成/失败/取消日志齐全；损坏/丢弃/flush 失败显示部分完成。工作线程错误现在保留同一 failureId；不把工具失败算插件故障。',
  repair:'双检 workspace/sessionId 与 repair.lock 防重复创建；create/open 失败向页面/命令 observeOperation 传播；failed repair 保存失败另记。长报告重复正文移除，但完整 findings 和全部源码位置读取要求保留。',
  get:'JSON/文件读取原样传播；list → diagnostics.record.read，page → diagnostics.page，execute/update → diagnostics.execute。',
  update:'队列与跨窗口锁保证原子更新；失败返回原 next，调用链记录。EEXIST 最多40次/25ms，不改变退避与权限。',
  next:'同 update；save 统一 diagnostics.save。',
  list:'目录非 ENOENT 记录并上抛；按20项并发读，单记录错误保留部分列表警告。',
  report:'get 后 readFile → page.message.error 或 repair → 宿主统一操作出口，无吞错。',
  catch:'进度保存失败 → diagnostics.progress.save；过时进度丢弃是明确合并策略，不重放用户操作。',
  retryNotification:'notify 失败记 diagnostics.notification；锁竞争是已在发送的正常情况，状态持久化和 sent 双检防重复。',
 },
 'src/diagnostics/model.ts':{
  analyzeWithModel:'独立诊断线程，fail/abort/close/notification → 唯一 result；result.catch 仅防迟到拒绝。整个函数记录 start/completed/failed/cancelled，失败保留本地结果。finally.disposeAndWait 有独立失败记录。',
  serverRequest:'reject 的错误不会绕过紧接的 fail；禁止执行工具后关闭临时进程，最终 diagnostics.model 记录失败。',
  configured:'config/read 经 diagnosticWait → analyzeWithModel catch；模型和 effort 显式验证，未降级。',
  session:'thread/start 经 diagnosticWait → analyzeWithModel catch；保留用户所选模型与 effort。',
 },
 'src/diagnostics/page.ts':{
  show:'消息回调/begin catch → error → operationFailure；panel 关闭清状态，不取消已启动后台诊断。',
  message:'异步操作交 jobs/configuration/repair；onDidReceiveMessage.catch → error。select/collapse 属本地选择状态；postWebviewMessage 记录投递失败。本次修复诊断页 webviewError 类别丢失，保留白名单 phase/errorType。',
  DiagnosticsPage:'changed 回调合并刷新，refresh 自带失败/恢复出口，纯订阅无需逐次日志。',
  begin:'configuration.save/jobs.start/refresh 原异常返回 show/message 统一捕获；未吞没。',
 },
 'src/diagnostics/scan.ts':{
  snapshots:'stat 错误计 scanErrors/unreadableFiles，不当空文件；后续报告显示证据缺口。',
  consume:'JSON parse 失败计 invalidLines；区间外/无时间行独立计数；并非默认正常。',
  scanPluginLogs:'read 故障、短读计 unreadableFiles；worker/jobs 为最终出口。开始长度固定，扫描时新增行留下一次。',
  filter:'根目录非 ENOENT 传播到 worker/jobs，ENOENT 代表尚无日志；源码审查仍独立执行。',
 },
 'src/diagnostics/wait.ts':{
  diagnosticWait:'计时/abort/原 Promise 拒绝通过 finish 单一结算；迟到回调被忽略避免重复。错误由 model/configuration 边界记录，不取消共享管理连接。',
 },
 'src/diagnostics/worker.ts':{
  '匿名回调':'本次改为单条 error 消息携带安全 errorCode/errorType/failureId，父 workerRunner 和 jobs.execute 共享失败链，原错误正文不传输。',
  result:'scanPluginLogs 的异常统一进入 catch，再到父线程写盘；正常结果唯一终态。',
 },
 'src/diagnosticsReport.ts':{
  readPerformanceData:'目录非 ENOENT 记录；open/read 传播。JSON 损坏累加 invalidLines 并在 sourceNote 明示；抽样旧接口不作为全量证据。',
  readPerformanceReport:'委派 readPerformanceData，不重复底层日志；主诊断采用 scanPluginLogs 全量扫描。',
 },
 'src/diff.ts':{readDiffFile:'UTF8 解码失败是 binary 展示状态；missing/unreadable 区分，磁盘错误 operationFailure(diff.read)，不伪造空内容。'},
 'src/extension.ts':{
  activate:'registerCommand 统一 observeOperation；serializer 面板恢复同样有操作边界；activate 自带 start/completed/failed。URI 处理实际 provider.handleNotificationUri 捕获。',
  diagnosticsPage:'repair/open/create 委派 jobs/provider；页面顶层捕获并落盘，不重复记底层操作。',
  save:'globalState.update 拒绝传播到 DiagnosticsPage.message/begin.error；保存失败不显示已配置。',
  deactivate:'jobs.dispose 已记录取消/失败，writer.flush 自带独立健康出口，等待清理完毕。',
 },
 'src/imageFile.ts':{readImageFile:'有界文件读取原异常向 panel.loadLocalImage/remote.execute 传播，边界记录 missing/unreadable/too_large；不记录正文与路径。'},
 'src/logging.ts':{
  pruneLogs:'文件不存在是跨窗口删除竞争；其它错误走 failure → writer.health 独立反馈。',
  health:'不递归调用 operation sink，失败限流、恢复通知；最终输出自身不可用时明确无法保证留痕。',
  prune:'mkdir/readdir/unlink 异常走 health，成功才记录 recovered。',
  write:'队列超限累加 dropped，flush 写带时间汇总；enqueue 异常走独立 onHealth，不递归。',
  flush:'串行批次、已成功日期删除避免重放；失败批次保留且最多3次退避重试，独立健康记录，恢复后落盘。onBatch 失败不撤销已写磁盘。',
  flushLogWriters:'有界刷新预算；返回 pending/failed/drop 状态，超时不冒充完成；checkLogFlush 将其放入诊断。',
  dispose:'先 closed 阻止新入队，仍 await flush；最终磁盘失败由健康通道报告，不承诺丢失数据已恢复。',
 },
 'src/operations.ts':{operationLog:'sink 异常走 DiagnosticHealth 独立输出；固定类别/标识白名单，不记录错误正文。'},
 'src/snapshot.ts':{
  listed:'目录读取失败返回 undefined 后标 unreadable/completeScan=false；capture 汇总 partial/unavailable，changed 阻止不可靠新增判断。',
  current:'读取后路径核对失败算 changedDuringRead/unreadable，不能当文件删除或还原成功。',
  read:'binary/large/symlink 为可见 skipReasons；ENOENT 与不稳定读取区分，真正采集汇总 capture；不逐文件记重复日志。',
  fingerprint:'读取失败用 undefined 保守标 unrestorableChanges，不呈现完整恢复。',
  walk:'Git失败已有 snapshot.inventory 并回退遍历；目录读取部分失败汇总。',
  fingerprints:'16并发有界纯汇总，异常安全状态由 capture/changed 上层表示。',
  readBatch:'16并发有界且按原序处理；read 返回 skipReasons，外层汇总，不重复埋点。',
  changed:'读取/清单并发，完整性不足标 unrestorableChanges；panel.finalizeCheckpoint 与 latency.finalization 记录终态。',
 },
 'src/workdayCalendar.ts':{
  isFeishuWebhook:'纯 URL 校验；非法配置返回 false，真正发送边界由 notification.webhook 处理，不记录 webhook 地址。',
  parseHolidayYear:'纯结构校验；invalid 抛出到 updateYear，非日志缺口。',
  updateYear:'首源失败尝试镜像是有界回退；本次修复原始异常正文日志，增加结构化 start/failed/cancelled/completed、缓存写入错误及 previousFailureId 恢复关联。',
 },
 'src/workspaceActivity.ts':{
  begin:'ENOENT 等真实文件错误、非 ESRCH 存活检查错误传播至 panel.handleSendInner 阶段失败；不把未知并发状态当安全。',
  finish:'save 失败把 ended 撤回后原样抛出，panel.finishActivity/checkpoint 调用方有失败出口。',
  save:'原子写入失败传播；临时清理失败不吞没，归属调用方活动记录阶段。',
 },
};
const all=[...report.matchAll(/^- (src\/[^:]+):(\d+) · ([^：]+)：([^\n]+)/gm)];
if(all.length!==736)throw new Error('报告候选总数不符：'+all.length);
const sources=new Map();
const entries=all.filter(m=>boundaries[m[1]]).map(([,file,line,symbol,kind])=>{
 const boundary=boundaries[file][symbol];if(!boundary)throw new Error(`缺少逐符号审查：${file}:${symbol}`);
 if(!sources.has(file))sources.set(file,execFileSync('git',['show',`${baseline}:${file}`],{cwd:root,encoding:'utf8'}));
 const n=Number(line),lines=sources.get(file).split('\n');
 return {file,line:n,symbol,kind,sourceExcerpt:lines.slice(Math.max(0,n-2),n+2).join('\n'),boundary,
  disposition:boundary.includes('本次修复')||boundary.includes('本次改为')?'已修复所属调用链缺口':'已有操作边界或可见安全回退，不重复埋点'};
});
if(entries.length!==148)throw new Error('主审范围数量不符：'+entries.length);
const result={diagnosticId:'afefb855-38d6-4ff4-9400-b75242324b63',baseline,sourceVersion:'0.1.187',sourceHash:'73235527b5aaa2c8c97c6a51994a65537783fd43db77cdffdd70382954f6dfe7',reportSha256:hash(report),totalCandidates:736,reviewed:entries.length,
 scope:'主审范围148条；codex148条及界面/远程440条见另外两份审查索引。全部基线位置固定在0.1.187，不用新行号覆盖旧证据。',
 files:[...sources].map(([file,source])=>({file,baselineSha256:hash(source),currentSha256:hash(fs.readFileSync(path.join(root,file)))})),entries,
 verification:['test/diagnostic-afefb855-fix.test.cjs','test/logging.test.cjs','test/diagnostic-87cc-fix.test.cjs','test/diagnostic-3a1-fix.test.cjs','test/diagnostics.test.cjs','test/snapshot-safety.test.cjs','test/restore.test.cjs','test/concurrent-restore.test.cjs','test/workday-calendar.test.cjs'],
 limitations:['736是静态候选数，不是缺陷数；逐项调用链审查不等于每个分支均动态注入。','旧日志缺失的服务名、工具输出和后端timing无法恢复；未归因等待仍未知。','不以注入用例证明远端403恢复、真实Webhook送达或系统焦点切换成功。']};
fs.writeFileSync(path.join(root,'benchmarks/afefb855-core-review.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({reviewed:entries.length,files:sources.size,totalCandidates:all.length}));
