// 固定完整报告中的全部位置，按调用链保留人工审查证据，不降低静态扫描规则。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),reportPath=process.argv[2],baseline='5597025';
if(!reportPath)throw new Error('请提供完整诊断报告路径');
const body=fs.readFileSync(reportPath,'utf8'),hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const prior=require('../benchmarks/diagnostic-87cc-source-review.json');
const boundaries=Object.fromEntries(prior.files.map(f=>[f.file,f.boundary.split(' 本次')[0]]));
Object.assign(boundaries,{
 'src/codex/compactionRelay.ts':'HTTP 路由、重写和 observer 已有统一边界；JSON 非匹配为透传。确认 WebSocket 反向发送和连接前排队发送的回调缺少失败处理；现由 failedWrite 统一脱敏落盘、结束待完成压缩并释放双方。取消仍是 cancelled，终态不重复；不重放请求。压缩只改请求，用户配置保持不变。',
 'src/codex/process.ts':'同步 notification/request 已由 handlerFailed 统一落盘并释放连接；ensureChild 的 RPC 拒绝由 rpc.request 和 latency.end 记录。确认异步 routeChildNotification/discoverChildren 的后继回调只向页面 emit 且 keepBusy，现接入 handlerFailed。确认 finish 的 questionState 清理失败无上游落盘，补 question.cleanup。其余 preTool/compact/restore/stop/validation 的委派边界不重复记录。',
 'src/codex/rpc.ts':'initialize->start.catch，receiveLine->fail；不可写 stdin/同步 write/流事件共享 failureId 并结算挂起请求；管理 RPC 有统一终态。解析和序列化区分 client/transport/backend。增加 timeoutMs 与 terminationReason，不更改超时预算。resolveCodex 和邻目录探测最终由 spawn 失败记录。',
 'src/codex/session.ts':'connection 的拒绝工具回调由 rpc.write/fail 处理；read/hydrate 外层 observeOperation 记录。确认历史页只核验容器与游标，没有校验轮次内容和重复轮次，现补全后才替换缓存。trackRead 关联同类/同线程后续成功及 previousFailureId，较早并发成功不冲掉新失败；后端失败不自动重放，断管只按原规则重建一次。prepareFork.ready 的 catch 是提前观察拒绝，使用者仍 await。',
 'src/remote/bridgeClient.ts':'remote.connection 是手机接入桥接，独立于 CodexRpc。publish、注册、帧解析、背压、发送失败均走固定关闭原因；关闭记 connectionId/initiator/pending/retryScheduled，恢复绑定 previousFailureId。主动 dispose 记 cancelled。remote.execute 接住业务委派异常，不自动重放未知写入结果。',
 'src/snapshot.ts':'capture 汇总目录/读取/指纹的 partial/unavailable、跳过原因及分项时长。确认目录扫描后文件在打开前消失会被当成不存在，现记 unreadable，重现时不能误当新增删除。稳定文件读满 stat 大小后省去 EOF 再读，仍核验前后 inode/大小/mtime/ctime；变化/增长/符号链接安全测试通过。',
 'src/logging.ts':'write/flush/prune 通过独立健康信号报告故障，避免日志器递归；批次失败保留并有界重试。flush 返回未落盘行/字节，扫描可报告不完整/超时。ENOSPC/EIO、恢复、溢出、出口抛错由现有故障注入检出；不再重复埋点。',
 'src/diagnostics/jobs.ts':'workerRunner 的错误/退出/取消 -> execute -> save 统一记录 diagnosticId；锁 EEXIST 为预期竞争，EPERM 存活探测不删除他人锁。list 在锁内复核，progress 合并，页面销毁不取消后台任务。故障注入覆盖锁冲突、worker 退出、持久化失败和恢复。',
 'src/panel/chatViewProvider.ts':'onPanelMessage/onSidebarMessage 顶层委派边界；restore/fork/settings/history/notify 各有处理终态。队列 catch 仅保证后续继续，原拒绝由调用者处理。revivePanel 的恢复失败由 logFailure 和面板提示记录；handleSendInner 独立准备有分项计时，连接早拒绝被观察，快照收尾后才结束。图片/链接安全解析和纯 DOM 不逐处埋点。',
 'src/webview/main.ts':'事件发送 -> panel.onPanelMessage -> 对应处理/回执；全局 error/unhandledrejection -> installWebviewErrors -> 宿主。局部高亮/URL/搜索 JSON/图片校验为普通文本或占位回退。question/drop/clipboard 异常已有安全上报；当前新增的搜索结构纯解析不应记正文。原版网页工具空白修复已有专门回归。',
 'src/remote/sessionAdapter.ts':'publish/observe/schedule/closed 的 catch -> failure(remote.adapter)；executeOperation 的预期业务拒绝 -> bridgeClient remote.execute rejected。hostOperation 委派保留原错误。状态发布不是 RPC 进程事件；taskQueue 的失败保留队首暂停并显式恢复。',
});
const tests={
 'src/codex/process.ts':['test/diagnostic-50df-fix.test.cjs','test/diagnostic-3a562940-fix.test.cjs','test/session-model.test.cjs'],
 'src/codex/compactionRelay.ts':['test/diagnostic-50df-fix.test.cjs','test/compaction-relay.test.cjs'],
 'src/codex/session.ts':['test/diagnostic-50df-fix.test.cjs','test/session-model.test.cjs'],
 'src/remote/bridgeClient.ts':['test/diagnostic-50df-fix.test.cjs','test/remote.test.cjs'],
 'src/snapshot.ts':['test/diagnostic-50df-fix.test.cjs','test/snapshot-safety.test.cjs'],
 'src/logging.ts':['test/diagnostic-66f-fix.test.cjs','test/diagnostic-87cc-fix.test.cjs'],
};
const changes={
 'src/codex/compactionRelay.ts':['websocket','catch'], 'src/codex/process.ts':['routeChildNotification','discoverChildren','finish'],
 'src/codex/session.ts':['hydrateWith','hydrateThread','connection'], 'src/remote/bridgeClient.ts':['receive','then','finally'],
 'src/snapshot.ts':['read','capture','readBatch'], 'src/codex/rpc.ts':['request'],
};
const pure=new Set(['parseQuestionReply','maskQuestionReply','toolView','routeCompaction','imageSources','transcriptPage','isFeishuWebhook','parseHolidayYear','codeBlock','extractSearchLinks','prettyHost','linkifyRefs','resolveWorkspaceFile','findProjectRoot']);
const positions=[...body.matchAll(/^- (src\/[^:]+):(\d+) · ([^：]+)：([^\n]+)/gm)];
if(positions.length!==722)throw new Error('完整报告候选数量不符：'+positions.length);
const sources=new Map(),entries=positions.map(([,file,line,symbol,kind],index)=>{
 if(!boundaries[file])throw new Error('缺少调用链审查：'+file);
 if(!sources.has(file))sources.set(file,execFileSync('git',['show',`${baseline}:${file}`],{cwd:root,encoding:'utf8'}));
 const lines=sources.get(file).split('\n'),n=Number(line);
 return {index:index+1,file,line:n,symbol,kind,sourceExcerpt:lines.slice(Math.max(0,n-2),n+2).join('\n'),reviewKey:file,
 disposition:changes[file]?.includes(symbol)?'所属调用链确认缺口并修复；具体故障注入见文件结论':pure.has(symbol)?'纯解析/格式回退/预期探测；真实操作边界见文件结论':'按所属函数及委派链核验；统一记录、预期分支与限制见文件结论，不等同逐位置动态注入'};
});
const current=require('./log-audit.cjs').buildLogAudit(root).manifest;
const result={diagnosticId:'50df1fc5-257f-477b-8b26-9f0d1cebb198',baseline,sourceVersion:'0.1.182',sourceHash:'afa499310bdac273504f865d8f866643b698fbf6669cc8f7e3ecd39bd3872641',reportSha256:hash(body),
 currentVersion:current.version,currentSourceHash:current.sourceHash,scope:'完整读取原报告722个候选、36个文件；固定原版行号及摘录，沿统一边界审查。规则保持 review-required，不把722视为实际漏记数，不宣称每个位置都动态注入。',
 files:[...sources].map(([file,source])=>{const old=prior.files.find(f=>f.file===file);return {file,sourceSha256:hash(source),currentSha256:hash(fs.readFileSync(path.join(root,file))),unchangedSincePriorReview:old?.currentSha256===hash(source),boundary:boundaries[file],verification:tests[file]??['完整 npm test；既有对应组件成功/失败/取消/恢复测试（详见复验说明）']};}),entries,
 nativeReview:{file:'native/Notifications.swift',sha256:hash(fs.readFileSync(path.join(root,'native/Notifications.swift'))),
 boundary:'完整读取通知请求校验、队列、授权、替换、点击预检、应用激活、聚焦与清理；show/clear 的错误经 result.json 返回宿主 observeOperation，写结果失败用固定 NSLog 健康信号。focus 由宿主 notification.focus/click 关联；原窗口关闭时拒绝跳到无关窗口。',
 limitation:'自动扫描仍 unsupported。原生激活/预检若未到达宿主，宿主无法记录该次点击，原生仅显示明确失败提示；不能宣称这些路径已落入插件日志。本次依靠原生编译与路由/焦点单测，未操作真实通知权限或点击用户通知。'},
 supplementalScope:'本次新增 trackRead/failedWrite 及 general 恢复关联为编排边界，已通过故障注入；currentSourceHash 固定最终构建。后续主线并行回滚保护改动不冒充本诊断修复。',
 verification:['test/diagnostic-50df-fix.test.cjs','scripts/verify-diagnostic-50df.cjs','完整类型检查及 npm test'],
 limitations:['历史缺失的终态、后端 timing 和工具输出无法补回。','系统技能安装失败属于 CLI 后端，未证实插件根因；不删除技能目录、不声称已修复该后端错误。','未使用真实付费模型执行压缩或注入外部服务故障；现有中继和配置恢复测试保持用户模型/effort/serviceTier/permission。','磁盘及独立健康通道同时永久不可用时，无法保证日志落盘。']};
fs.writeFileSync(path.join(root,'benchmarks/diagnostic-50df-source-review.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({candidates:entries.length,files:sources.size,unchangedSincePrior:result.files.filter(f=>f.unchangedSincePriorReview).length,currentSourceHash:current.sourceHash}));
