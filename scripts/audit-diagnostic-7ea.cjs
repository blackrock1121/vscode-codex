// 人工调用链复核的可重建索引；不改变自动规则，也不把静态复核当作运行验证。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..'), report = process.argv[2];
if (!report) throw Error('请提供完整报告路径');
const baseline = '2424ae6da77c506a2ec244b9388e6ec0e7de659f';
const body = fs.readFileSync(report, 'utf8'), hash = v => crypto.createHash('sha256').update(v).digest('hex');
// 每条候选保留原版本位置及上下文，以下说明为实际调用边界，不主张每个分支都已动态执行。
const reviews = {
  'src/checkpoints.ts': ['restore 的 stat/write/delete 拒绝由 panel.restoreCheckpoint/forkRewind 统一报告；rollback 的独立错误已有 operationFailure。成功在面板恢复操作终态记录。', 'core,diagnostic-03eb-fix'],
  'src/codex/compactionInput.ts': ['save 的 ENOENT/EEXIST 是内容寻址归档探测；其他错误进入 optimizeCompactionInput fallback，再经 relay.rewrite/process.compaction_route 落盘。reduce 和 cancelled 是计算或信号检查；预算到期保留原输入，不重复记录每个片段。', 'compaction-input,compaction-relay'],
  'src/codex/compactionRelay.ts': ['请求改写、HTTP、WebSocket 和 report 回调已有统一日志；JSON/URL/错误码解析是容错探测。本次补关闭发起方、关闭码和连接终态；正常客户端/本地关闭竞争记 cancelled，未知 ECANCELED 仍 failed，故障标识复用。', 'diagnostic-7ea-fix,compaction-relay', 'fixed'],
  'src/codex/compactionValidation.ts': ['validateCompactionModel/phase/compacted/answer 委派 RPC 和 relay，runCompactionValidation 统一记录评测失败/取消/结果；清理在 finally。模型评测输入是合成样本，答案解析计评分，不为纯评分重复埋点。', 'compaction-policy,compaction'],
  'src/codex/events.ts': ['三处均为提问回复 JSON 解析、脱敏和工具展示转换；实际交互由 process.request/answerQuestion 与 panel.submitQuestionAnswer 记录。普通文本解析失败不应变成运行故障。', 'core'],
  'src/codex/performanceTrace.ts': ['write 的日志出口异常委派 DiagnosticHealth(performance.sink)，有独立健康反馈与 recovered/lostRecords；不递归写同一个失败出口。', 'diagnostic-03eb-fix,logging'],
  'src/codex/process.ts': ['构造回调异常到 handlerFailed；启动/请求由 RPC 记录；子进程发现/停止、无效提问、压缩及回退有 operation 或 compaction_route 终态。预注册 catch 只抑制提前拒绝，原任务仍由 await/caller 消费。纯回调转发和探测不重复计故障。', 'rpc,compaction,diagnostic-lifecycle,connection-diagnostics-fix'],
  'src/codex/rpc.ts': ['start/initialize/fail/close 与 request start/end 覆盖生命周期；receiveLine 回调抛错会 fail 并拒绝 pending。codexSpawnEnvironment/resolveCodex 是候选环境探测，最终无法启动由 start 统一记录。', 'rpc,connection-diagnostics-fix'],
  'src/codex/session.ts': ['connection/readMetadata/hydrate/readTurnCount 委派 RPC/session.read，断线只重试一次且有 retry/recovered；fork.ready 的防提前拒绝 catch 之后仍 await。本次修复 dispose 对 fork preparation 清理拒绝未观察，独立安全记录，避免未处理 Promise。', 'diagnostic-7ea-fix,session-model,session-selection', 'fixed'],
  'src/codex/telemetry.ts': ['transportDiagnostics 的属性 JSON 是可选格式解析；LocalTelemetry 启动/接收异常经 telemetry_status 和 operationFailure 反馈，导出链由 RPC diagnostic -> process -> panel 写盘，不输出原始属性。', 'telemetry,diagnostic-03eb-fix'],
  'src/diagnosticHealth.ts': ['failed 的 catch 是独立最终出口也失败后的终止，继续调用自己会递归；计数保留并在出口恢复后写 recovered/lostRecords。永久不可写不能保证磁盘记录，已有独立反馈是明确限制。', 'diagnostic-03eb-fix,logging'],
  'src/diagnostics/jobs.ts': ['workerRunner 的 message/error/exit/abort/timeout 汇入唯一终态；execute/save/progress/list/取消/锁释放均有上层操作记录。alive 的 ESRCH/EPERM 为进程探测，队列 catch 不吞原任务；只对 EEXIST 有界等待。', 'diagnostics,diagnostics-scope,diagnostic-lifecycle'],
  'src/diagnostics/ledger.ts': ['本次补 transaction 与回报 validate 的独立落盘；坏回报刷新去重，新修订关联恢复。close 失败也尝试释放锁且不覆盖主异常，临时文件/锁清理非 ENOENT 安全记录。validate 成功仅代表校验，持久成功由 ledger completed 判定。', 'diagnostic-7ea-fix,diagnostic-lifecycle', 'fixed'],
  'src/diagnostics/model.ts': ['已有 diagnostics.model 唯一终态、进度/销毁异常记录；result.catch 只预观察，serverRequest 拒绝后的 fail 汇入同边界。本次保留 RPC 原异常 failureId/requestId/rpcCode，取消与超时用结构化错误，保留本地报告。', 'diagnostic-7ea-fix,diagnostics-review', 'fixed'],
  'src/diagnostics/page.ts': ['show/message/refresh 委派 jobs 或 observeOperation，后台 Promise 有 error 出口；postWebviewMessage 有拒绝/关闭/恢复反馈。折叠、选择、过期请求丢弃为界面状态，不是外部操作失败。', 'diagnostics-page,diagnostic-lifecycle'],
  'src/diagnostics/scan.ts': ['stat/read 错误累计 scanErrors/unreadableFiles，解析错累计 invalidLines；根目录非 ENOENT 传播 worker/jobs。缺失结果以覆盖缺口展示，不等于无问题；consume 为内存汇总。', 'diagnostics-scope,diagnostics-accuracy-fix'],
  'src/diagnostics/wait.ts': ['辅助 Promise 由 configuration/model 统一记录；本次给超时加 ETIMEDOUT/errorOrigin，取消用 AbortError，迟到结果和拒绝被消费，不推进已结束任务。', 'diagnostic-7ea-fix,diagnostics-review', 'fixed'],
  'src/diagnostics/worker.ts': ['线程捕获错误后向父进程发结构化 error；workerRunner/execute 统一落盘，异常退出即失败。在线程内重复使用未注册主线程 sink 不能增加可见性。', 'diagnostics,diagnostic-lifecycle'],
  'src/diagnosticsReport.ts': ['旧版抽样读取容忍坏 JSON；全面诊断使用 scanPluginLogs 的文件/坏行覆盖统计。根目录异常已记录并传播，不伪装空报告；readPerformanceReport 委派同一读取入口。', 'diagnostics-scope,logging'],
  'src/diff.ts': ['readDiffFile 的缺文件/目录/二进制/过大各返回明确展示状态，非预期读取异常已有安全日志；面板不显示为成功读取空正文。', 'core'],
  'src/extension.ts': ['activate start/completed/failed 与固定命令 observeOperation 已存在；事件委派 provider/jobs 的操作终态；deactivate 等待 jobs 与 writer。纯参数转发不额外创建故障记录。', 'diagnostics-page,diagnostic-03eb-fix'],
  'src/imageFile.ts': ['readImageFile 的 open/stat/read/close 拒绝向调用方传播；panel.webview.image.read 与 remote.execute 记录结果。不能在通用文件读取和每个调用方重复埋点。', 'core,remote-history,diagnostic-lifecycle'],
  'src/logging.ts': ['写入失败保留批次并有界退避，分日期成功不重放；prune 非 ENOENT 与 flush 失败通过独立 onHealth/console 反馈。健康快照和 checkLogFlush 向诊断报告未落盘状态；同失败写入器不递归。', 'logging,diagnostic-03eb-fix,diagnostic-lifecycle'],
  'src/notificationRouter.ts': ['server/endpoint 启动异常拒绝到调用方；原生点击 observeOperation，失败返回 HTTP500，成功204；关闭和无效路径为协议拒绝。', 'notification-router,notifications'],
  'src/notifications.ts': ['show/clear/focus 已有统一记录；queue catch 释放队列但调用者仍接收原异常；旧通知清理返回汇总由 panel 记录。0.1.209 的地址解析/非模态修复属于另一会话，本次不重复计功。', 'notifications,notification-native-queue,notification-nonmodal'],
  'src/operations.ts': ['operationLog 的 catch 委派 DiagnosticHealth(operation.sink)，独立失败出口及恢复计数；observeOperation 保留同异常的 failureId，纯日志封装不递归。', 'diagnostic-03eb-fix,diagnostic-7ea-fix'],
  'src/panel/chatViewProvider.ts': ['页面消息到 onPanelMessage/onSidebarMessage 的统一错误出口；发送准备以 stage/syncStage 分段计时，恢复/文件/图片/通知/快照各有边界；Webview 投递由 postWebviewMessage 处理拒绝与恢复。预注册拒绝、队列释放仍 await 原任务，URI/根目录/搜索为可选探测；0.1.209 通知变更不计本次修复。', 'webview,session-selection,diagnostics-page,diagnostic-lifecycle'],
  'src/remote/bridgeClient.ts': ['连接、协议解码、执行和回复拒绝已有 operationFailure；未知写操作异常不伪称未执行；可选配置不存在和关闭为预期分支。', 'remote,remote-compatibility'],
  'src/remote/executionReceipts.ts': ['transact 前序 catch 仅解除队列，原 run 返回执行入口；持久失败传播 remote.execute，先写 unknown 再执行以防重复操作。无需在每次读写重复记录。', 'remote-receipts'],
  'src/remote/sessionAdapter.ts': ['executeOperation 由 remote.execute 统一记录；后台 publish/observe/drain/closed 原全局节流会吞另一阶段首错，本次按阶段及会话分别去重，成功仅关联同会话恢复，保留故障次数并限制摘要内存。', 'diagnostic-7ea-fix,remote,remote-compatibility', 'fixed'],
  'src/remote/timeline.ts': ['imageSources JSON/URI 为格式探测；RemoteImageReader 读取/解码异常传播 remote.execute；缓存命中和分块哈希不产生外部操作，无需重复日志。', 'remote-history'],
  'src/remote/transcript.ts': ['三处为内存分页、哈希 update 和游标，规则把 update 识别为操作；真正历史读取由 SessionStore/remote.execute 统一处理，不新增纯计算日志。', 'remote,remote-history'],
  'src/snapshot.ts': ['walk/read/fingerprint 的跳过/读取错误进入 skipReasons/completeScan/unrestorableChanges；capture 有汇总日志，上层 preparation/final_snapshot 有计时及终态。扫描期间文件消失为生命周期变化，不把跳过当完整成功。', 'core,diagnostic-03eb-fix'],
  'src/webview/diagnostics.ts': ['选择/渲染/折叠/搜索均为界面状态；实际任务 send -> DiagnosticsPage.message -> jobs。全局 error/rejection 经固定脱敏桥接到 diagnostics.webview，避免记录报告正文。', 'diagnostics-page'],
  'src/webview/errors.ts': ['flush 的 send 异常保留有界 pending，并有独立控制台不可用提示；下次宿主消息再传并恢复。窗口 error/rejection 是统一入口；桥本身断开时无法保证宿主落盘，明确保留边界。', 'diagnostic-03eb-fix,webview'],
  'src/webview/main.ts': ['事件通过 send 委派面板；全局 error/rejection 由 installWebviewErrors 汇总上报；图片、剪贴板、拖入已有固定操作名。URL/JSON/base64/高亮解析容错与 DOM 构造是纯展示，不逐函数埋点；无效协议回退不代表页面崩溃。', 'webview,diagnostic-03eb-fix'],
  'src/workdayCalendar.ts': ['URL/年度解析为校验；updateYear 首来源失败尝试镜像，最终成功/全部失败及缓存写入失败由 refresh 统一日志；无有效日历保持照常推送。', 'workday-calendar'],
  'src/workspaceActivity.ts': ['begin/finish/save 的拒绝经 Checkpoints.startWorkspaceActivity/finishWorkspaceActivity 传播到 panel 发送准备、消息或 final_snapshot 边界；原子持久化不吞错，finish 写失败会撤回内存 ended 状态。blockReason 自身有 verify 失败/恢复日志。', 'diagnostic-lifecycle,diagnostic-03eb-fix'],
};
const locations = [...body.matchAll(/^- (src\/[^:]+):(\d+) · ([^：]+)：([^\n]+)/gm)];
if (locations.length !== 773) throw Error(`完整报告候选数量不符：${locations.length}`);
const sources = new Map();
const entries = locations.map(([,file,line,symbol,kind]) => {
  if (!reviews[file]) throw Error('缺少调用链复核：'+file);
  if (!sources.has(file)) sources.set(file, execFileSync('git',['show',`${baseline}:${file}`],{cwd:root,encoding:'utf8'}));
  const n=Number(line), lines=sources.get(file).split('\n');
  if (!lines[n-1]) throw Error(`原版本行号不存在：${file}:${n}`);
  return {file,line:n,symbol,kind,sourceExcerpt:lines.slice(Math.max(0,n-2),n+2).join('\n'),reviewKey:file};
});
const result = {diagnosticId:'7ea81c7b-112c-466c-99d4-b134aada2b74',baseline,sourceVersion:'0.1.208',reportSha256:hash(body),
  buildVersion:require('../package.json').version,
  scope:'完整报告 773 个候选位置及 38 个文件调用边界；candidate 索引不代表逐分支动态覆盖，未隐藏自动候选。',
  files:[...sources].map(([file,source]) => ({file,sourceSha256:hash(source),currentSha256:hash(fs.readFileSync(path.join(root,file))),
    outcome:reviews[file][2]??'not_a_bug',reason:reviews[file][0],tests:reviews[file][1].split(',').map(v=>`test/${v}.test.cjs`)})),entries,
  nativeReview:{file:'native/Notifications.swift',sha256:hash(fs.readFileSync(path.join(root,'native/Notifications.swift'))),outcome:'deferred',
    evidence:'人工核验 finish/result.json、NSLog(result_write_failed)、通知授权/投递/清理回调和点击 URLSession -> NotificationRouter；父接口 show/clear/focus 有统一日志。0.1.209 通知变更由另一会话提交。',
    limitation:'Swift 自动覆盖规则仍不支持；本次原生编译和父调用测试不等于真实授权、点击、最小化/多窗口及磁盘故障全场景复验，保留后续验证。'},
  limitations:['纯计算和已有统一边界不重复埋点；not_a_bug 仅表示列出的静态候选不足以成立缺日志缺陷。',
    '故障注入使用本地隔离目录与模拟传输；不代表安装并启用后完成真实系统通知、远程手机或付费模型的运行复测。',
    '无法补回历史缺失事件；未知命令输出、网络根因与取消意图保持未知。',
    '没有改用户的模型、推理强度、服务档位或权限；未用候选数量下降或测试总耗时证明任务提速。']};
for (const file of result.files) for (const test of file.tests) if (!fs.existsSync(path.join(root,test))) throw Error('测试文件不存在：'+test);
fs.writeFileSync(path.join(root,'benchmarks/diagnostic-7ea-source-review.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({candidates:entries.length,files:sources.size,native:result.nativeReview.outcome}));
