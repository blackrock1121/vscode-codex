import { expectedFileError, operationFailure } from './operations';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { observedChildTailMs, type PerformanceRow } from './codex/performanceTrace';
import { redactDiagnosticText } from './diagnostics/redact';

const seconds = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? `${(v / 1000).toFixed(2)} 秒` : '未观测';
const cell = (v: unknown) => String(v ?? '—').replace(/[|`\r\n<>]/g, ' ').slice(0, 160);
const phaseNames: Record<string, string> = { preparation: '发送前准备', tools: '工具/Bash', user_wait: '用户审批/回答',
  compaction: '压缩', local_preparation: '本地工具准备/子任务核验', model_visible: '可见模型输出阶段', child_tail: '子任务收尾等待', agent_wait: '显式等待子任务', unobserved: '未归因等待' };
const waitNames: Record<string, string> = { rpc_pending: 'RPC 请求尚未结算', connection_closed: '连接已关闭', after_root_end: '根轮次结束后收尾', no_active_backend_event: '连接期间未观测到活动阶段（后端细分未知）' };
const preparationNames: Record<string, string> = { previous_finalization_wait: '等待前轮收尾', attachments: '附件读取', autosave: '自动保存',
  connection: '连接与会话准备', history: '历史读取', snapshot: '工作区快照', session_settings_wait: '等待设置保存', checkpoint_metadata: '还原点元数据', finalization: '结束后快照整理' };

/** 仅消费结构化白名单记录；不把普通日志中的正文或命令复制到报告。 */
export function performanceReport(rows: PerformanceRow[], sourceNote = ''): string {
  const summaries = rows.filter(r => r.event === 'turn_summary').slice(-40);
  const starts = new Map(rows.filter(r => r.event === 'turn_start').map(r => [r.traceId, r]));
  const slowTools = rows.filter(r => r.event === 'span_end' && ['tool', 'bash'].includes(String(r.kind)) && typeof r.durationMs === 'number');
  const failures = new Map<string, { count: number; totalMs: number }>();
  for (const r of slowTools.filter(r => r.outcome === 'failed')) {
    const key = cell(r.failureCategory ?? 'unknown');
    const v = failures.get(key) ?? { count: 0, totalMs: 0 }; v.count++; v.totalMs += Number(r.durationMs) || 0; failures.set(key, v);
  }
  const toolEvents = rows.filter(r => r.event === 'codex.tool_result');
  const transport = rows.filter(r => ['codex.api_request', 'codex.websocket_request', 'codex.responses_api_timing'].includes(String(r.event)));
  const sources = new Map<string, { version: unknown; window: unknown; host: unknown; traces: Set<unknown> }>();
  for (const r of rows) {
    const version = r.pluginVersion ?? '旧日志未标注', window = r.windowId ?? '未知', host = r.hostId ?? '未知';
    const key = JSON.stringify([version, window, host]);
    const source = sources.get(key) ?? { version, window, host, traces: new Set() };
    if (r.traceId) source.traces.add(r.traceId);
    sources.set(key, source);
  }
  const sourceLines = ['## 版本与窗口来源', '', '| 插件版本 | 窗口加载实例 | 扩展宿主进程 | 任务数 |', '| --- | --- | --- | --- |',
    ...[...sources.values()].map(s => `| ${cell(s.version)} | ${cell(s.window)} | ${cell(s.host)} | ${s.traces.size} |`)];
  const text = ['# Codex 速度诊断', '', `生成时间：${new Date().toISOString()}`, sourceNote, '',
    '时长以插件观测为准。工具累计耗时可重叠，不能直接相加当作任务耗时；审批等待单独列出。模型输出阶段不等于纯推理耗时，“未归因等待”也不能直接认定为模型慢或调度慢。', '',
    `当前样本：${summaries.length} 轮完整汇总，${slowTools.length} 条工具结束记录，${toolEvents.length} 条 CLI 工具结果。`, '',
    ...sourceLines, '', '## 每轮耗时（最多 40 轮明细，按耗时排序）', '',
    '| 任务标识 | 插件版本 / 窗口 | 模型 / effort | 总耗时 | 排队 | 首个活动事件 | 首个正文 | 工具数 / 失败 | 最大并行工具 / 子任务 | 子任务尾部等待 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const r of [...summaries].sort((a, b) => Number(b.elapsedMs) - Number(a.elapsedMs))) {
    const s = starts.get(r.traceId);
    text.push(`| ${cell(r.traceId)} | ${cell(r.pluginVersion ?? '未标注')} / ${cell(typeof r.windowId === 'string' ? r.windowId.slice(0, 8) : undefined)} | ${cell(s?.model)} / ${cell(s?.effort)} | ${seconds(r.elapsedMs)} | ${seconds(r.queueMs)} | ${seconds(r.firstEventMs)} | ${seconds(r.firstTextMs)} | ${r.toolCount} / ${r.failures} | ${r.maxParallelTools} / ${r.maxParallelAgents} | ${seconds(observedChildTailMs(r))} |`);
  }
  if (!summaries.length) text.push('', '尚无完整任务样本。重载后运行任务即可自动采集；仍在运行的任务可查看下方心跳。');
  for (const r of [...summaries].sort((a, b) => Number(b.elapsedMs) - Number(a.elapsedMs)).slice(0, 5)) {
    const phases = r.phasesMs as Record<string, number> | undefined;
    text.push('', `### ${cell(r.traceId)}`, '', ...Object.entries(phases ?? {}).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${phaseNames[k] ?? cell(k)}：${seconds(v)}`),
      ...Object.entries((r.unobservedEvidenceMs ?? {}) as Record<string, number>).map(([k, v]) => `- 未归因等待（按区间结束时客户端状态采样）· ${waitNames[k] ?? cell(k)}：${seconds(v)}`),
      `- 工具实际并行时间：${seconds(r.parallelToolMs)}；重复命令：${r.repeatedCommands}；明确报告的模型重试：${r.retries}。`,
      `- 不完整阶段：${r.incompleteSpans}；因上限未采集的阶段：${r.droppedSpans}；扩展宿主最大定时器延迟：${seconds(r.maxEventLoopDelayMs)}。`);
  }
  text.push('', '## 最慢工具/Bash（按单次观测时长）', '', '| 任务 / 工具 ID | 工具 / 程序 | 耗时 | 首次输出 | 结束前无输出 | 退出码 / 分类 | 重复次数 |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of [...slowTools].sort((a, b) => Number(b.durationMs) - Number(a.durationMs)).slice(0, 25))
    text.push(`| ${cell(r.traceId)} / ${cell(r.itemId)} | ${cell(r.tool)} / ${cell(r.program)} | ${seconds(r.durationMs)} | ${seconds(r.firstOutputMs)} | ${seconds(r.outputIdleMs)} | ${cell(r.exitCode)} / ${cell(r.failureCategory ?? r.outcome)} | ${r.repeated ?? 0} |`);
  text.push('', '## CLI 底层工具（辅助观测，不与上表相加）', '', '| 任务 / 调用 ID | 工具 | CLI 耗时 | 成功 / 失败分类 |', '| --- | --- | --- | --- |');
  for (const r of [...toolEvents].sort((a, b) => Number(b.duration_ms) - Number(a.duration_ms)).slice(0, 20))
    text.push(`| ${cell(r.traceId ?? '未关联')} / ${cell(r.call_id ?? r.tool_call_id)} | ${cell(r.tool_name ?? r.tool ?? r['tool.name'])} | ${seconds(r.duration_ms)} | ${cell(r.success)} / ${r.expectedCancellation === true ? '问题暂停（预期中断）' : cell(r.failureCategory)} |`);
  text.push('', '## 子 Agent', '', '| 任务 | 子线程 / 父线程 | 活动时长 | 结果 |', '| --- | --- | --- | --- |');
  for (const r of rows.filter(r => r.event === 'span_end' && r.kind === 'agent').sort((a, b) => Number(b.durationMs) - Number(a.durationMs)).slice(0, 20))
    text.push(`| ${cell(r.traceId)} | ${cell(r.threadId)} / ${cell(r.parentThreadId)} | ${seconds(r.durationMs)} | ${cell(r.outcome)} |`);
  text.push('', '## 失败共性', '', '| 分类线索 | 次数 | 累计工具耗时（可重叠） |', '| --- | --- | --- |');
  for (const [category, v] of [...failures].sort((a, b) => b[1].totalMs - a[1].totalMs)) text.push(`| ${category} | ${v.count} | ${seconds(v.totalMs)} |`);
  if (!failures.size) text.push('| 当前样本未记录失败 | 0 | — |');
  text.push('', '## 发送准备与收尾', '', '| 任务 | 阶段 | 耗时 | 结果 |', '| --- | --- | --- | --- |');
  for (const r of rows.filter(r => ['preparation_stage', 'finalization'].includes(String(r.event))).sort((a, b) => Number(b.durationMs) - Number(a.durationMs)).slice(0, 20))
    text.push(`| ${cell(r.traceId)} | ${preparationNames[String(r.stage ?? r.event)] ?? cell(r.stage ?? r.event)} | ${seconds(r.durationMs)} | ${cell(r.outcome ?? 'completed')} |`);
  text.push('', '## RPC 往返等待（可能与上面各阶段重叠）', '', '| 任务 | RPC | 时长 | 结果 |', '| --- | --- | --- | --- |');
  for (const r of rows.filter(r => r.type === 'rpc' && r.stage === 'end').sort((a, b) => Number(b.durationMs) - Number(a.durationMs)).slice(0, 15))
    text.push(`| ${cell(r.traceId ?? '连接准备/未关联')} | ${cell(r.method)} | ${seconds(r.durationMs)} | ${cell(r.outcome)} |`);
  text.push('', '## 压缩（包括实际压缩模型）', '', '| 任务 | 触发 / 阶段 | 实际模型 / effort | 已耗时 | 结果 |', '| --- | --- | --- | --- | --- |');
  for (const r of rows.filter(r => r.diagnosticType === 'compaction' && ['end', 'model_selected', 'settings_synced'].includes(String(r.stage))).slice(-20))
    text.push(`| ${cell(r.traceId)} | ${cell(r.trigger)} / ${cell(r.stage)} | ${cell(r.model)} / ${cell(r.effort)} | ${seconds(r.elapsedMs)} | ${cell(r.outcome ?? r.modelSource)} |`);
  text.push('', '### 压缩路由与回退', '', '回退表示本次采用原生路径；是否压缩成功须另看同一请求的结束记录，启动预算到期也不等于 RPC 超时。', '',
    '| 时间 / 版本 / 窗口 | 任务或会话 | 阶段 | 原因 / 范围 |', '| --- | --- | --- | --- |');
  for (const r of rows.filter(r => r.diagnosticType === 'compaction_route').slice(-20)) {
    const at = new Date(Number(r.logAtMs ?? r.atMs));
    const safe = (value: unknown) => cell(typeof value === 'string' ? redactDiagnosticText(value, 160) : value);
    text.push(`| ${Number.isFinite(at.getTime()) ? at.toISOString() : '未记录'} / ${safe(r.pluginVersion)} / ${safe(r.windowId)} | ${safe(r.traceId ?? r.threadId)} | ${safe(r.stage)} | ${safe(r.reason)} / ${safe(r.scope)} |`);
  }
  text.push('', '## 模型/网络观测', '',
    '下表只列后端实际给出的数值。API 请求耗时包含多种等待，不能等同于推理耗时；不同记录也可能覆盖同一次请求，不合并相加。', '',
    '| 任务 | 事件 | 请求时长 | 首 token | 后端 engine 时间 | 状态 / attempt |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of transport.slice(-30)) text.push(`| ${cell(r.traceId ?? '未关联')} | ${cell(r.event)} | ${seconds(r.duration_ms)} | ${seconds(r.ttft_ms)} | ${seconds(r.engine_service_total_ms)} | ${cell(r['http.response.status_code'] ?? r.status_code ?? r.success)} / ${cell(r.attempt)} |`);
  text.push('', `CLI 工具结果中 ${toolEvents.filter(r => !r.traceId).length} 条缺少足够关联信息，保留为未关联，不强行归给当前任务。进程级 histogram 也不会归给某一轮。`, '', '## 尚未结束的任务');
  const ended = new Set(rows.filter(r => r.event === 'turn_summary').map(r => r.traceId));
  const heartbeats = new Map(rows.filter(r => r.event === 'heartbeat' && !ended.has(r.traceId)).map(r => [r.traceId, r]));
  for (const r of heartbeats.values()) {
    const date = new Date(Number(r.atMs));
    const active = Array.isArray(r.active) ? r.active : [];
    const userWait = active.some(s => s?.kind === 'question' || s?.kind === 'approval');
    text.push('', `- ${cell(r.traceId)}：${userWait ? '正在等待用户回答或授权；' : ''}已运行 ${seconds(r.elapsedMs)}，最近事件距今（记录当时）${seconds(r.idleMs)}，活动阶段 ${r.activeCount}，记录时间 ${Number.isFinite(date.getTime()) ? date.toISOString() : '未记录'}。`);
  }
  if (!heartbeats.size) text.push('', '无未结束任务的心跳样本。');
  text.push('', '## 如何据此提速', '',
    '- 优先处理耗时最高、反复出现的失败分类，结合工具 ID 回到原会话核对命令。命令指纹只在同一进程中用于识别相同命令，重复不自动等于失败重试。',
    '- 工具阶段较长且并行时间接近零时，再检查独立操作是否可以并发；子任务尾部等待较长时检查拆分是否失衡。',
    '- 发送准备或本地宿主延迟高时优先查快照、历史、文件保存和事件处理；压缩高时检查上下文增长及重复压缩。',
    '- 模型/网络缺少后端细分时，先收集对应请求记录，避免把未观测时间武断归为服务端排队。', '',
    '日志只保存在本机，保留 7 天。不记录提示词、图片内容、完整命令、工具输出或凭据。');
  return text.filter(line => line !== undefined).join('\n');
}

export async function readPerformanceData(dir: string): Promise<{ rows: PerformanceRow[]; sourceNote: string }> {
  const names = (await fs.readdir(dir).catch(error => { if (expectedFileError(error)) return [] as string[]; operationFailure('diagnostics.report.read', error); throw error; })).filter(n => /^codex-chat-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort().slice(-3);
  const rows: PerformanceRow[] = []; let truncated = false, invalidLines = 0;
  // 限制一次报告读取 12 MiB；日常运行不解析历史日志。
  for (const name of names) {
    const handle = await fs.open(path.join(dir, name), 'r');
    try {
      const size = (await handle.stat()).size, limit = 4 * 1024 * 1024;
      const buffer = Buffer.alloc(Math.min(size, limit));
      await handle.read(buffer, 0, buffer.length, Math.max(0, size - limit));
      let content = buffer.toString('utf8');
      if (size > limit) { truncated = true; content = content.slice(content.indexOf('\n') + 1); }
      for (const line of content.split('\n')) {
        const match = line.match(/\[(perf|transport|compaction)\] (\{.*\})$/); if (!match) continue;
        try {
          const row = JSON.parse(match[2]);
          const identity = line.slice(0, match.index).match(/\[pluginVersion=([\w.-]+) windowId=([\w.-]+) hostId=([\w.-]+)\]/);
          if (row && typeof row === 'object' && !Array.isArray(row)) rows.push({ ...row, diagnosticType: match[1],
            ...(identity ? { pluginVersion: identity[1], windowId: identity[2], hostId: identity[3] } : {}) });
        } catch { invalidLines++; /* 报告明确显示证据缺口，不能冒充没有异常。 */ }
      }
    } finally { await handle.close(); }
  }
  return { rows, sourceNote: `读取最近 ${names.length} 个日志文件，每个最多 4 MiB。${truncated ? '部分旧记录被截断，统计只是当前采样范围。' : ''}${invalidLines ? `有 ${invalidLines} 条结构化记录损坏，诊断不完整。` : ''}` };
}

export async function readPerformanceReport(dir: string): Promise<string> {
  const { rows, sourceNote } = await readPerformanceData(dir);
  return performanceReport(rows, sourceNote);
}
