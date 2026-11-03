// 按完整报告固定版本登记全部候选及调用链边界；不修改静态审查规则。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),report=process.argv[2];
if(!report)throw new Error('请提供完整报告路径');
const baseline='35daf5c05f215ef6c8e718f8931d9061888eab01';
const boundaries={
  "src/checkpoints.ts": "restore 的预检与写入失败由 panel.restoreCheckpoint/forkRewind 捕获；失败回滚后的 failure 最终抛出，rollback/临时清理已有独立日志。ENOENT 预检仅表示尚不存在。",
  "src/codex/compactionInput.ts": "save 的 ENOENT/EEXIST 是内容寻址归档探测；其它错误传播至 optimizeCompactionInput.prepare 的 fallback。预算/取消已记录；纯 reduce 不单独埋点。归档失败保留输入，不能当成压缩失败。",
  "src/codex/compactionRelay.ts": "路由 JSON/URL 非匹配属于预期回退；WS 握手、终态、关闭、取消已有日志。HTTP 新增默认 30 秒响应头等待心跳和首响应事件；响应头到达、取消及关闭时清理心跳。非流式压缩可能延迟响应头，不新增强制超时、不截断生成流。routeCompaction 返回副本，普通请求原样转发，未修改会话设置。",
  "src/codex/compactionValidation.ts": "validateCompactionModel/phase 错误向 runCompactionValidation 的 failed/cancelled 终态传播；通知、close、拒绝工具汇入 phase，finally 清理临时 RPC/目录。评测纯答案解析失败转换为评测失败。未运行真实收费评测。",
  "src/codex/events.ts": "parseQuestionReply/maskQuestionReply/toolView 是纯格式解析和脱敏，非 JSON 按普通文本/安全掩码处理；真正提交由 process.request/answerQuestion 和 panel.submitQuestionAnswer 记录。",
  "src/codex/performanceTrace.ts": "write 的最终出口由 DiagnosticHealth 独立反馈；阶段 start/end/heartbeat/finish 已存在。补丁不匹配和不存在的工具会话新增分类；未归因等待继续保留未知，不将观测跨度当作持续计算。",
  "src/codex/process.ts": "请求、通知、子线程、停止、压缩由 RPC、handlerFailed、PerformanceTrace 和 panel.handleEmitInner 统一记录。模型目录失败新增 5～60 秒冷却、保留旧目录、同进程 failureId 恢复关联；不改变模型/effort/权限。压缩 relay 只修改请求副本；兼容路径已有 compaction.restore finally 和下一轮 turn.configuration。",
  "src/codex/rpc.ts": "initialize/start/fail 和 rpc.request 记录握手与挂起请求终态。receiveLine 畸形响应使连接失败，resolveCodex/环境目录是可选探测，最终启动失败统一记录。动态工具取消保留 unknown 来源，诊断不再当作已证实插件故障；历史缺少 requestId 的 MCP 正文不按时间拼接。",
  "src/codex/session.ts": "read/hydrate 已有 observeOperation；断线仅对读取重建一次，恢复日志关联前后进程，窗口关闭不重试。readTurnCount 的协议兼容回退只匹配已知错误；prepareFork.ready 提前观察拒绝但使用者仍 await。setCustomTitle/archive/delete 直接走 RPC，管理 RPC 边界补齐成功和失败。",
  "src/codex/telemetry.ts": "OTLP 属性解析失败保留 timingStatus；接收/解码/观察者已有安全日志，已有 listen 后持续 server.error 边界。仅证明本机采集器，CLI 内部导出重试/丢弃不可从一次 ExportError 推断。",
  "src/diagnosticHealth.ts": "最终健康反馈不递归写业务日志；失败与恢复标识一致，fallback 自身失败停止递归。磁盘和独立输出都不可用时无法保证留痕，保留这一限制。",
  "src/diagnostics/jobs.ts": "workerRunner -> execute/save 统一记录 diagnosticId 与终态；锁 EEXIST 是预期竞争，EPERM 视为存活；worker 提前退出和取消分开。previous.catch 仅允许后继队列继续，原任务返回调用者；面板关闭不取消后台任务。锁内复核快照已有竞态保护。",
  "src/diagnostics/model.ts": "fail/abort/serverRequest 汇入 analyzeWithModel 的唯一结果；result.catch 仅预防迟到拒绝，finally 关闭一次。已有定时 progress 抛错捕获及 dispose 失败日志，保留规则报告，不更改用户所选诊断模型/effort。",
  "src/diagnostics/page.ts": "show/begin 错误通过 error 统一落盘，refresh 与 Webview 投递已有失败/恢复。新增消息类型校验和操作边界，覆盖 configure/select/cancel/repair 等；已有脚本错误桥与纯折叠不重复记录。",
  "src/diagnostics/scan.ts": "stat/read/parse 失败分别累计 scanErrors、unreadableFiles、invalidLines，报告呈现证据缺口；根目录非 ENOENT 传播至 worker/jobs。按扫描开始长度读取、时间未知单列；扫描完整不等于写入完整。",
  "src/diagnostics/wait.ts": "timeout/abort/rejection 拒绝原 Promise，由 model/configuration 记录最终状态；迟到回调忽略是防重复结算，不是隐藏失败。",
  "src/diagnostics/worker.ts": "扫描失败发送脱敏 errorFields 给父线程，再由 workerRunner/jobs.execute 结算；主线程日志出口统一落盘。父任务取消后的迟到消息忽略。",
  "src/diagnosticsReport.ts": "坏行计入 invalidLines 和报告说明；目录读取非 ENOENT 记录并传播。旧抽样报告不能替代 scanPluginLogs 全量统计。0.1.160 已修 analysis 中 durationMs 缺失被当 0 秒累计的缺陷。",
  "src/diff.ts": "UTF-8 解析失败为 binary 展示状态；读取权限/磁盘错误已有 operationFailure，missing 与 unreadable 分开，不返回伪造空正文。",
  "src/extension.ts": "固定 registerCommand -> observeOperation -> provider 服务；activate/注册/关闭各有上层边界。诊断前刷新已有 LogFlushState，失败/超时在结果显示覆盖缺口，不再默认为全部落盘。",
  "src/imageFile.ts": "只做有界文件读取，异常传播至 panel.loadLocalImage 或 remote.image.read；不在底层重复记录路径。remote 真实读取错误以前只返回业务拒绝，本次补脱敏日志。",
  "src/logging.ts": "write/flush/prune 健康记录独立于业务 sink；批次有界保留、重试和恢复落盘，保留扫描覆盖缺口。本次补 onHealth 输出也抛错时的 console 兜底，并验证双通道失败和恢复。最末输出本身不可用时不递归，不能保证永久磁盘故障下落盘。",
  "src/notificationRouter.ts": "endpoint 启动错误传播至 sendLocalNotice 调用方；click -> observeOperation 与 HTTP 状态。已有持续 runtime error 监听，移除已成功启动的临时 reject；陌生路径/Origin/已关闭来源按预期拒绝。",
  "src/notifications.ts": "queueSessionNotification 只释放上一失败队列，原 Promise 仍返回调用者；show/clear/focus -> observeOperation。clearPrevious 汇总 failed 交 panel clear_previous；轮询 result.json 的 ENOENT 是有期限正常等待，不代表发送失败。",
  "src/operations.ts": "operationLog 出口失败由 DiagnosticHealth 独立反馈，errorFields 仅白名单；observeOperation 关联开始/终态。日志出口自身最终失败不递归。",
  "src/panel/chatViewProvider.ts": "命令注册、消息入口、发送阶段、settingsQueue、快照、恢复与通知已有上游日志。实际缺口：finishWorkspaceActivity 抛错会跳过 sending 释放，现最外层 finally 必定释放且保留原始发送错误；收尾失败单独落盘。发送准备 record 的静默捕获改用 DiagnosticHealth 独立兜底。队列 catch 保留原任务拒绝，解析/路径探测不重复埋点。",
  "src/remote/bridgeClient.ts": "parseCommand 拒绝返回固定错误，execute -> observeOperation remote.execute；未知写入结果断开桥接，不能谎称未执行。reply 发送失败由末尾 catch 记录。remote.connection 是独立手机桥接，不是主 Codex RPC。",
  "src/remote/executionReceipts.ts": "transact.catch 只允许后续事务继续，run 返回原任务拒绝到 remote.execute；先持久化 unknown 防重放。hash/update 是纯摘要计算，无需重复日志。",
  "src/remote/sessionAdapter.ts": "publish/observe/schedule/closed 委派 remote.adapter.failure；执行边界由 remote.execute 统一记录。图片读取真实文件错误曾统一吞成 IMAGE_NOT_AVAILABLE，现增加 remote.image.read；明确的图片大小/游标/不可用业务拒绝仍按固定错误返回。",
  "src/remote/taskQueue.ts": "原 drain catch 吞掉发送异常，调度器 catch 无法检出。已有 start/failed/paused/dispatched，保留队首暂停，显式恢复后重试；不记录消息正文或附件。",
  "src/remote/timeline.ts": "imageSources 是纯解析；RemoteImageReader 的 URL/类型拒绝是业务校验，磁盘错误继续传播，本次由 adapter 新增 remote.image.read 落盘。readImageFile 保留实际字节预算。",
  "src/remote/transcript.ts": "transcriptPage 是内存分页和 createHash.update，静态规则误认为外部 update；读取历史在 SessionStore/remote.execute 边界，纯计算不埋点。",
  "src/snapshot.ts": "walk/read/fingerprint 将缺失、不可读、扫描不全汇总 skipReasons/completeScan/unrestorableChanges，并由 checkpoint/panel 记录。inode/大小/时间一致性与实际读入预算已有测试；不对每个文件重复埋点。",
  "src/webview/diagnostics.ts": "select/render/折叠/搜索是界面状态；真正操作经 DiagnosticsPage.message/jobs 统一终态，浏览器全局错误经 installWebviewErrors 到宿主。配置失败不推断已成功保存。",
  "src/webview/errors.ts": "全局 error/unhandledrejection 固定类别上报；通道失败由独立 console 健康信号并在宿主来信时重试。已有图片资源类型，绝不含 URL/路径。",
  "src/webview/main.ts": "发送由宿主入口记录，全局 error/unhandledrejection 走 installWebviewErrors；高亮、URL、搜索 JSON 解析允许普通文本回退。图片、拖入、剪贴板错误已有安全上报，图片显式重载和历史恢复已有测试。纯 DOM 和计算不逐分支记录，工具名 js 不能据此认定页面崩溃。",
  "src/workdayCalendar.ts": "URL/年度解析纯校验；updateYear 镜像失败继续第二来源，最终失败/成功/缓存失败在 refresh 调用链已有日志。取消保持取消，不绕过权限或重复无限请求。",
  "src/workspaceActivity.ts": "begin/save 的同步磁盘失败传播至发送准备阶段；finish 的失败由收尾/结果处理边界记录。本次修 handleSend finally 的释放缺口，持久化失败仍保留活动记录供下次核验，不伪造已安全完成。"
};
const body=fs.readFileSync(report,'utf8'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const locations=[...body.matchAll(/^- (src\/[^:]+):(\d+) · ([^：]+)：([^\n]+)/gm)];
if(locations.length!==748)throw new Error('完整报告候选数量不符：'+locations.length);
const sources=new Map();
const entries=locations.map(([,file,line,symbol,kind])=>{
 if(!boundaries[file])throw new Error('未登记调用链：'+file);
 if(!sources.has(file))sources.set(file,execFileSync('git',['show',`${baseline}:${file}`],{cwd:root,encoding:'utf8'}));
 const source=sources.get(file).split('\n'),n=Number(line);
 if(!source[n-1])throw new Error('基线位置无效：'+file+':'+line);
 return {file,line:n,symbol,kind,sourceExcerpt:source.slice(Math.max(0,n-2),n+2).join('\n'),reviewKey:file};
});
const files=[...sources].map(([file,source])=>({file,baselineSha256:hash(source),currentSha256:hash(fs.readFileSync(path.join(root,file))),boundary:boundaries[file]}));
const result={diagnosticId:'a86dec96-a71d-478c-bba8-cc13095c8ce1',baseline,sourceVersion:'0.1.196',reportSha256:hash(body),
 currentVersion:require('../package.json').version,
 scope:'完整报告全部 748 个候选按 37 个文件的调用链边界核验；每个位置保留基线源码及哈希。候选不是已确认漏记，不宣称逐分支全部动态注入。',files,entries,
 nativeReview:{file:'native/Notifications.swift',sha256:hash(fs.readFileSync(path.join(root,'native/Notifications.swift'))),
 boundary:'授权/add/clear -> finish -> result.json -> requestLocalNotification -> operation；点击由 NotificationRouter 记录。结果写入失败有固定 NSLog，父端等待有期限。',
 limitation:'Swift 自动规则仍为 unsupported；源码人工检查和打包编译不能证明真实系统通知授权、窗口切换和用户可见性。'},
 verification:['test/diagnostic-a86-fix.test.cjs','test/model-refresh.test.cjs','test/compaction-relay.test.cjs','test/diagnostics-page.test.cjs','test/diagnostic-afefb855-fix.test.cjs','npm test 全量回归：RPC/停止/快照/设置/诊断 worker 与锁/远端/通知/页面'],
 limits:['MCP 403 和模型容量/限流来自上游，未复现历史端点与网络条件，不能宣称服务已恢复。','CLI 内部模型目录刷新不受插件菜单冷却控制，不宣称解决跨进程刷新超时。','系统技能目录失败未确认原因；未删除目录或修改权限。','历史缺失的请求关联、工具正文和心跳不能补回，未归因等待保留未知。','未发起真实收费压缩评测；压缩隔离、取消、断开和恢复使用本地模拟回归。','所有保留日志扫描与原报告最近24小时口径不同；诊断重分类不是实际故障数下降。']};
fs.mkdirSync(path.join(root,'benchmarks'),{recursive:true});
fs.writeFileSync(path.join(root,'benchmarks/diagnostic-a86-source-review.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({candidates:entries.length,files:files.length,version:result.currentVersion}));
