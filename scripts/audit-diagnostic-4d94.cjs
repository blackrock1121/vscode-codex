// 绑定当前构建的源码候选，复用哈希一致文件的既有调用链审查，明确新增核验边界。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),{manifest}=require('./log-audit.cjs').buildLogAudit(root);
const previous=require('../benchmarks/diagnostic-a86-source-review.json');
const changed={
 'src/codex/compactionRelay.ts':'rewrite -> report(request) -> websocket response/incomplete 或 HTTP finish；新增每次 routeId 的单调时钟耗时。断流终态清理本次计时，重连生成新 routeId，普通请求不改配置。onRoute 抛错由 compaction.observer 记录；JSON/URL 未匹配原样转发。',
 'src/codex/process.ts':'rpc 诊断/通知/请求 -> PerformanceTrace、handlerFailed、panel.handleEmitInner 统一落盘；新增 setCustomTitle 仅走所属 RPC，不修改用户模型/effort/速度/权限。压缩启动预算是可选优化等待，迟到配置不接管已启动线程；手动兼容路径 finally 恢复，取消/断连/重启由现有回归覆盖。',
 'src/codex/rpc.ts':'request 现在分配一次 operationId，成功/失败/超时/取消复用，failureId 跨层保留；管理连接也可串联。write 管道异常经 fail 统一落盘和拒绝 pending，因此管理连接 reject 的 catch 不重复记同一底层错误。initialize/process end/kill 清理已有日志。',
 'src/codex/session.ts':'setCustomTitle 接受所属连接，核对 thread ID，再完成写入才更新缓存；未打开的历史会话仍使用管理连接。读取/缓存/hydrate 走 observeOperation 与 session.read recovered；元数据默认探测与错误传播不重复记录。',
 'src/diagnostics/jobs.ts':'workerRunner/execute/save/repair 边界统一记录；修复提示按 options/coverage 的真实时间范围生成，缺少旧记录配置时保持未知。报告路径不是可执行命令；长正文保留完整报告入口。',
 'src/diagnostics/model.ts':'只发送白名单摘要；补充最长轮次分项与未发送类别计数，不扩大工具权限。model fail/abort/serverRequest 在唯一终态结算，result.catch 只是提前观察拒绝，finally dispose 记录错误。摘要拼装是纯计算。',
 'src/diagnostics/scan.ts':'扫描文件长度快照，错误/坏行/丢行记覆盖缺口；增加压缩 routeId/connectionId/failureId 供摘要关联，避免不同压缩尝试混淆。报告中的当前源码审查仍仅在 general 模式开启，performance 模式未冒充已审查。',
 'src/notifications.ts':'focus 的总 2000ms 预算现在覆盖 executeCommand 与窗口状态；settled 防止迟到结果再次结算，finally 解除订阅。成功焦点只恢复该层，notification.click 后续导航由上层单独记录。show/clear/排队边界已有日志；前序失败 catch 仅放行后继队列。',
 'src/panel/chatViewProvider.ts':'页面 onPanelMessage/onSidebarMessage 与 process.emit 错误有统一 operation 边界。修复会话改名走原连接，observeOperation 增加开始/成功/失败，并在页面提示失败；不重发修复任务。refreshSessions 的 output 是 extension.ts 包装的 DailyLogWriter，不是纯控制台。发送收尾、设置队列、更新与通知继续复用既有边界。',
};
const files=manifest.files.map(f=>{
 const prior=previous.files.find(p=>p.file===f.file),unchanged=prior?.currentSha256===f.sha256;
 if(f.candidates.length&&!unchanged&&!changed[f.file])throw Error('存在未登记的变化候选文件：'+f.file);
 return {...f,review:changed[f.file]??(unchanged?prior.boundary:'当前静态规则无候选；不据此认定所有路径都有日志。'),reviewBasis:changed[f.file]?'本次调用链与差异核验':unchanged?'源码哈希与已有 a86 审查一致，复用边界结论':'静态规则',...(unchanged?{previousReview:'benchmarks/diagnostic-a86-source-review.json'}:{})};
});
const result={diagnosticId:'4d94bbc6-a6ea-4687-9b49-0c8539141058',baseline:'0440923',version:manifest.version,sourceHash:manifest.sourceHash,
 scope:'原完整报告没有源码位置清单；本次独立生成全部当前源码候选。优先沿消息/RPC/进程/压缩/通知/更新/会话修复检查实际日志出口；不声称逐条动态注入所有候选。',
 files,candidates:files.reduce((n,f)=>n+f.candidates.length,0),unsupported:manifest.unsupported,
 verification:['test/diagnostic-4d94-fix.test.cjs','test/compaction-relay.test.cjs','test/connection-diagnostics-fix.test.cjs','test/afefb855-ui.test.cjs','npm test'],
 limitations:['哈希复用不是重新逐分支审查；未覆盖源码语言仍列为 unsupported。','原生窗口最小化/跨窗口点击、OS休眠和真实上游访问控制未做现场自动化，不冒充已验证。','Webview error/unhandledrejection 与消息投递已有脱敏边界；页面脚本加载前彻底无法运行时无法依赖页内处理器自报。','纯计算、预期文件探测与已由上层记录的错误不重复埋点。']};
fs.writeFileSync(path.join(root,'benchmarks/diagnostic-4d94-source-review.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({version:result.version,files:files.length,candidates:result.candidates,sourceHash:result.sourceHash}));
