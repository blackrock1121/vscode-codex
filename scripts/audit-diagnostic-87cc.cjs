// 完整报告逐位置审查账本；保持自动扫描原规则，不以人工结论删除候选。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),report=process.argv[2];
if(!report)throw new Error('请提供完整诊断报告路径');
const baseline='a97fdd7',body=fs.readFileSync(report,'utf8'),hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const boundaries={
 'src/checkpoints.ts':'restore 的预检与写入失败由 panel.restoreCheckpoint/forkRewind 捕获；失败回滚后的 failure 最终抛出，rollback/临时清理已有独立日志。ENOENT 预检仅表示尚不存在。',
 'src/codex/compactionInput.ts':'save 的 ENOENT/EEXIST 是内容寻址归档探测；其它错误传播至 optimizeCompactionInput.prepare 的 fallback。预算/取消已记录；纯 reduce 不单独埋点。归档失败保留输入，不能当成压缩失败。',
 'src/codex/compactionRelay.ts':'routeCompaction/target 的 JSON、URL 非匹配属于原样转发/拒绝；实际 HTTP/WS 错误分别在代理边界记录，report 统一安全回调。已有 routeId、processRunId、WS 断开终态及 HTTP transport_end；HTTP 2xx 不代表语义压缩成功。',
 'src/codex/compactionValidation.ts':'validateCompactionModel/phase 错误向 runCompactionValidation 的 failed/cancelled 终态传播；通知、close、拒绝工具汇入 phase，finally 清理临时 RPC/目录。评测纯答案解析失败转换为评测失败。未运行真实收费评测。',
 'src/codex/events.ts':'parseQuestionReply/maskQuestionReply/toolView 是纯格式解析和脱敏，非 JSON 按普通文本/安全掩码处理；真正提交由 process.request/answerQuestion 和 panel.submitQuestionAnswer 记录。',
 'src/codex/performanceTrace.ts':'write 出口异常由 DiagnosticHealth 独立反馈；真实阶段已有 start/end/heartbeat/finish，缺失开始保留 incomplete，未知等待保留未知，不重复记录纯计算。',
 'src/codex/process.ts':'notification/request -> error/emit -> panel.handleEmitInner；preTool/子线程核验 -> latency 终态，定时取消、停止、压缩恢复已有 trace；close 已有 cancelCompactionRestore。转发请求日志补进程与轮次标识，不改模型/权限。 本次为中继 routeId 冻结发起轮次，迟到终态不借用新轮次；子线程未知 trace 保留未知。记录 request_only/sessionConfigurationChanged=false，兼容恢复记录实际 serviceTier。',
 'src/codex/rpc.ts':'receiveLine/流错误 -> fail；initialize -> start.catch；每个挂起请求有 requestId，进程关闭共享 failureId。管理 RPC 已有请求终态；后端拒绝、超时、传输失败分开。resolveCodex/Node 邻目录为可选探测，最终 spawn 失败统一记录。 本次修复同步 write 抛错和不可写 stdin 未废弃连接的缺口，所有挂起调用同一 failureId 及时结算；无效 JSON/信封归类 invalid_data；参数序列化失败标为 client 且保留健康连接。',
 'src/codex/session.ts':'read/hydrate 已有 observeOperation；断线仅对读取重建一次，恢复日志关联前后进程，窗口关闭不重试。readTurnCount 的协议兼容回退只匹配已知错误；prepareFork.ready 提前观察拒绝但使用者仍 await。setCustomTitle/archive/delete 直接走 RPC，管理 RPC 边界补齐成功和失败。',
 'src/codex/telemetry.ts':'OTLP 属性解析失败保留 timingStatus；接收/解码/观察者已有安全日志，已有 listen 后持续 server.error 边界。仅证明本机采集器，CLI 内部导出重试/丢弃不可从一次 ExportError 推断。',
 'src/diagnosticHealth.ts':'最终健康反馈不递归写业务日志；失败与恢复标识一致，fallback 自身失败停止递归。磁盘和独立输出都不可用时无法保证留痕，保留这一限制。',
 'src/diagnostics/jobs.ts':'workerRunner -> execute/save 的统一日志与 diagnosticId；alive EPERM 视为存活，锁 EEXIST 为正常竞争，其余失败不循环。合并过时 progress，记录终态失败；worker 错误和取消分开，页面关闭不取消后台任务。 本次修复 list 读取旧快照后，锁内未复核而覆盖其它窗口终态的竞态；任务、通知、修复会话三类分别验证。',
 'src/diagnostics/model.ts':'fail/abort/serverRequest 汇入 analyzeWithModel 的唯一结果；result.catch 仅预防迟到拒绝，finally 关闭一次。已有定时 progress 抛错捕获及 dispose 失败日志，保留规则报告，不更改用户所选诊断模型/effort。',
 'src/diagnostics/page.ts':'show/message/begin 委派至 error，refresh 自带失败/恢复日志，后台 jobs 负责操作终态；postWebviewMessage 统一投递失败/恢复。选择/折叠/关闭是 UI 状态，不重复埋点。',
 'src/diagnostics/scan.ts':'stat/read/parse 失败分别累计 scanErrors、unreadableFiles、invalidLines，报告呈现证据缺口；根目录非 ENOENT 传播至 worker/jobs。按扫描开始长度读取、时间未知单列；扫描完整不等于写入完整。',
 'src/diagnostics/wait.ts':'timeout/abort/rejection 拒绝原 Promise，由 model/configuration 记录最终状态；迟到回调忽略是防重复结算，不是隐藏失败。',
 'src/diagnostics/worker.ts':'扫描失败发送脱敏 errorFields 给父线程，再由 workerRunner/jobs.execute 结算；主线程日志出口统一落盘。父任务取消后的迟到消息忽略。',
 'src/diagnosticsReport.ts':'坏行计入 invalidLines 和报告说明；目录读取非 ENOENT 记录并传播。旧抽样报告不能替代 scanPluginLogs 全量统计。0.1.160 已修 analysis 中 durationMs 缺失被当 0 秒累计的缺陷。',
 'src/diff.ts':'UTF-8 解析失败为 binary 展示状态；读取权限/磁盘错误已有 operationFailure，missing 与 unreadable 分开，不返回伪造空正文。',
 'src/extension.ts':'固定 registerCommand -> observeOperation -> provider 服务；activate/注册/关闭各有上层边界。诊断前刷新已有 LogFlushState，失败/超时在结果显示覆盖缺口，不再默认为全部落盘。',
 'src/imageFile.ts':'readImageFile 只做有界文件读取，失败原样传播到 panel.loadLocalImage 或 remote.execute；宿主记录 unreadable/missing/too_large。已有增长预算测试，不重复在底层记录敏感路径。',
 'src/logging.ts':'write/flush/prune 不递归调用 operation sink，健康反馈独立；批次失败保留、最多有界重试、恢复落盘。已有在途字节/行数与 flush 状态，扫描等待超时不撤销正在写入的批次。 本次修复丢弃计数无时间戳被有时间窗扫描排除的问题，保持旧格式兼容并验证恢复后继续写入。',
 'src/notificationRouter.ts':'endpoint 启动错误传播至 sendLocalNotice 调用方；click -> observeOperation 与 HTTP 状态。已有持续 runtime error 监听，移除已成功启动的临时 reject；陌生路径/Origin/已关闭来源按预期拒绝。',
 'src/notifications.ts':'queueSessionNotification 只释放上一失败队列，原 Promise 仍返回调用者；show/clear/focus -> observeOperation。clearPrevious 汇总 failed 交 panel clear_previous；轮询 result.json 的 ENOENT 是有期限正常等待，不代表发送失败。',
 'src/operations.ts':'operationLog 的出口失败走 DiagnosticHealth 独立健康信号，不记录错误正文；已有 errorFields 白名单关联字段。observeOperation 的开始/终态按 AsyncLocalStorage 关联。本次允许 client 来源，区分本地参数序列化与传输/后端失败。',
 'src/panel/chatViewProvider.ts':'onPanelMessage/onSidebarMessage 顶层错误出口；restore/fork/settings/history/notify 分别已有实际处理边界。settingsQueue/snapshotExclusionUpdate 的 catch 仅保持队列可继续，原任务交回调用者。0.1.160 已修 handleSendInner 的连接早拒绝/快照迟到竞态；loadLocalImage 增加脱敏原因与有界读取。DOM/URI/目录候选探测不逐条埋点。',
 'src/remote/bridgeClient.ts':'parseCommand 拒绝返回固定错误，execute -> observeOperation remote.execute；未知写入结果断开桥接，不能谎称未执行。reply 发送失败由末尾 catch 记录。remote.connection 是独立手机桥接，不是主 Codex RPC。',
 'src/remote/executionReceipts.ts':'transact.catch 只允许后续事务继续，run 返回原任务拒绝到 remote.execute；先持久化 unknown 防重放。hash/update 是纯摘要计算，无需重复日志。',
 'src/remote/sessionAdapter.ts':'publish/observe/schedule/closed -> failure 统一 remote.adapter；executeOperation 的业务拒绝 -> bridgeClient remote.execute rejected；主机委派保持原错误。queue.drain 的真实吞错在 taskQueue 修补。图片大小错误仍映射 IMAGE_TOO_LARGE。',
 'src/remote/taskQueue.ts':'原 drain catch 吞掉发送异常，调度器 catch 无法检出。已有 start/failed/paused/dispatched，保留队首暂停，显式恢复后重试；不记录消息正文或附件。',
 'src/remote/timeline.ts':'imageSources 是纯解析，非 JSON 走文本；read 图片异常转换固定业务拒绝，remote.execute 统一落盘。readImageFile 限制实际读入量，防 stat 后增长突破预算，保留图片权限边界。',
 'src/remote/transcript.ts':'transcriptPage 是内存分页和 createHash.update，静态规则误认为外部 update；读取历史在 SessionStore/remote.execute 边界，纯计算不埋点。',
 'src/snapshot.ts':'walk/read/fingerprint 结果汇总 skipReasons/completeScan/unrestorableChanges，capture 和 panel 阶段落盘。已有读取前后 inode/大小/时间核对，变化/删除列 unreadable；no_workspace 是 skipped，部分不可读为 partial，不能假装完整保障。 本次按已知文件大小缩减读取缓冲与 EOF 探测分配，保留一致性检查；文件增长切回有界块读取，过大仍列 large，其余变化列 unreadable，避免逐字节循环。统一终态添加目录清单/遍历/读取/指纹分项墙钟。',
 'src/webview/diagnostics.ts':'select/render/折叠/搜索是界面状态；真正操作经 DiagnosticsPage.message/jobs 统一终态，浏览器全局错误经 installWebviewErrors 到宿主。配置失败不推断已成功保存。',
 'src/webview/errors.ts':'全局 error/unhandledrejection 固定类别上报；通道失败由独立 console 健康信号并在宿主来信时重试。已有图片资源类型，绝不含 URL/路径。',
 'src/webview/main.ts':'send 委派 panel.onPanelMessage；全局脚本异常统一错误桥。高亮、URL、搜索 JSON 解析为预期普通文本回退；纯 DOM 操作不埋点。question/drop 已安全上报，已有图片复制失败分类；本地图片缺失显示占位，未证实整页崩溃。 本次给失败图片添加显式重载并在历史恢复时重置缓存，覆盖缺失、损坏和恢复，不自动无限重试。',
 'src/workdayCalendar.ts':'URL/年度解析纯校验；updateYear 镜像失败继续第二来源，最终失败/成功/缓存失败在 refresh 调用链已有日志。取消保持取消，不绕过权限或重复无限请求。',
};
const pure=new Set(['parseQuestionReply','maskQuestionReply','toolView','routeCompaction','imageSources','transcriptPage','isFeishuWebhook','parseHolidayYear','codeBlock','extractSearchLinks','prettyHost','linkifyRefs','resolveWorkspaceFile','findProjectRoot']);
const fixes={
 'src/codex/rpc.ts':['receiveLine','write'], 'src/codex/process.ts':['compactionRouted','finish'],
 'src/diagnostics/jobs.ts':['list','batch'], 'src/logging.ts':['flush'],
 'src/snapshot.ts':['read','walk','capture'], 'src/webview/main.ts':['showLocalImage','hydrateLocalImages'],
};
const locations=[...body.matchAll(/^- (src\/[^:]+):(\d+) · ([^：]+)：([^\n]+)/gm)];
if(locations.length!==700)throw new Error('完整候选数量不符：'+locations.length);
const sources=new Map(),entries=locations.map(([,file,line,symbol,kind])=>{
 if(!boundaries[file])throw new Error('未登记调用链：'+file);
 if(!sources.has(file))sources.set(file,execFileSync('git',['show',`${baseline}:${file}`],{cwd:root,encoding:'utf8'}));
 const lines=sources.get(file).split('\n'),n=Number(line);
 return {file,line:n,symbol,kind,sourceExcerpt:lines.slice(Math.max(0,n-2),n+2).join('\n'),reviewKey:file,
  disposition:fixes[file]?.includes(symbol)?'所属调用链有本次修复，见文件结论及回归证据':pure.has(symbol)?'纯解析或预期探测，依赖真实操作边界':'已沿委派/上游/终态核验，见文件结论；不重复埋点'};
});
const native='native/Notifications.swift',current=require('./log-audit.cjs').buildLogAudit(root).manifest;
const kinds={'错误处理未见':'catch-unlogged','错误继续传播':'error-propagated','错误处理委派':'handler-delegated','包含异步':'operation-unlogged','操作分支':'branch-unlogged','命令入口':'entry-unlogged'};
const remaining=new Map();
for(const e of entries){const kind=Object.entries(kinds).find(([prefix])=>e.kind.startsWith(prefix))[1],key=[e.file,e.symbol,kind].join(':');remaining.set(key,(remaining.get(key)||0)+1);}
const currentSupplementalReview=[];
for(const f of current.files)for(const c of f.candidates){
 const key=[f.file,c.symbol,c.kind].join(':'),n=remaining.get(key)||0;
 if(n){remaining.set(key,n-1);continue;}
 const lines=fs.readFileSync(path.join(root,f.file),'utf8').split('\n');
 currentSupplementalReview.push({file:f.file,...c,sourceExcerpt:lines.slice(c.line-1,c.line+2).join('\n'),boundary:boundaries[f.file],
  verification:f.file==='src/webview/main.ts'?'test/webview.test.cjs 的 87cc 缺失/损坏/恢复用例；宿主读取由 webview.image.read 统一落盘':'test/diagnostic-87cc-fix.test.cjs 的同步断管/序列化/恢复用例；rpc.process/rpc.request 统一落盘'});
}
const result={diagnosticId:'87cc8d0b-9968-4894-82fb-fef2db4a37fc',baseline,sourceVersion:'0.1.160',
 sourceHash:'4a34dec6ab4afd74c9d0e009f7716a09cd92ca3bdcd3140b75bc0d4c9ebf1861',reportSha256:hash(body),
 currentVersion:current.version,currentSourceHash:current.sourceHash,currentSupplementalReview,
 scope:'完整读取原报告全部700个候选；位置固定在0.1.160源码，按实际调用链核验。静态扫描仍为review-required，不宣称每个分支都做过动态注入。',
 files:[...sources].map(([file,source])=>({file,sourceSha256:hash(source),currentSha256:hash(fs.readFileSync(path.join(root,file))),boundary:boundaries[file]})),entries,
 nativeReview:{file:native,sha256:hash(fs.readFileSync(path.join(root,native))),
  boundary:'授权拒绝/add 回调/clear 结果 -> finish -> result.json -> requestLocalNotification -> operation 日志；点击 prepare/activate/focus 由 NotificationRouter 记录；结果写入失败 NSLog 固定 result_write_failed，父端超时可见。',
  limitation:'Swift 自动扫描仍不支持；本次完整人工读源码并依靠现有通知路由测试及打包编译，未实际发送通知、修改系统通知授权或验证用户看见通知。'},
 verification:['test/diagnostic-87cc-fix.test.cjs','test/webview.test.cjs','test/diagnostic-66f-fix.test.cjs','test/compaction-relay.test.cjs','test/diagnostic-3a1-fix.test.cjs','完整 npm test（含 RPC、compaction、snapshot、settings、remote、notifications、diagnostics 页面等回归）'],
 limitations:['旧日志缺失的后端 timing、工具正文、失败终态不能补回，未知等待保持未知。','700是候选数，不是实际漏记数；纯计算和已有统一日志不重复埋点。','未执行真实收费模型压缩、外部服务故障恢复或真实系统通知权限测试。','磁盘永久不可写时不能保证落盘，独立健康输出和扫描覆盖缺口明确显示限制。']};
fs.mkdirSync(path.join(root,'benchmarks'),{recursive:true});fs.writeFileSync(path.join(root,'benchmarks/diagnostic-87cc-source-review.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({reviewed:entries.length,files:sources.size,currentSourceHash:current.sourceHash,nativeReviewed:native}));
