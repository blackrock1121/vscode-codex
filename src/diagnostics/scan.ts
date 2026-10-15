import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { PerformanceRow } from '../codex/performanceTrace';
import { performanceReport } from '../diagnosticsReport';
import { PerformanceAccumulator, DiagnosticCoverage, DiagnosticOutput, DiagnosticSource } from './analysis';

const LOG_NAME = /^codex-chat-(\d{4}-\d{2}-\d{2})\.log$/;
const MAX_LINE = 65536;
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 160) : '未标注';
const cell = (value: unknown) => String(value).replace(/[|`\r\n<>]/g, ' ');
const SAMPLE_LIMITS: Record<string, number> = { turn_start: 256, turn_summary: 40, 'span-tool': 50, 'span-bash': 50, 'span-agent': 25,
  preparation_stage: 30, finalization: 20, compaction: 50, rpc: 30, 'codex.tool_result': 50,
  'codex.api_request': 30, 'codex.websocket_request': 30, 'codex.responses_api_timing': 30, heartbeat: 100 };

/** 报告明细有界，分析累计不采样；最慢项保留到末尾，供现有报告渲染器排序。 */
class ReportSamples {
  private readonly buckets = new Map<string, PerformanceRow[]>();
  add(row: PerformanceRow): void {
    if (row.event === 'turn_summary') this.buckets.set('heartbeat', (this.buckets.get('heartbeat') ?? []).filter(r => r.traceId !== row.traceId));
    const event = String(row.event);
    const key = row.diagnosticType === 'compaction' ? 'compaction' : row.type === 'rpc' && row.stage === 'end' ? 'rpc' :
      event === 'span_end' ? `span-${row.kind}` : event;
    const limit = Object.hasOwn(SAMPLE_LIMITS, key) ? SAMPLE_LIMITS[key] : 0; if (!limit) return;
    const bucket = this.buckets.get(key) ?? []; bucket.push(row);
    if (bucket.length > limit) {
      if (['turn_start', 'compaction', 'heartbeat'].includes(key)) bucket.shift();
      else {
        const score = (r: PerformanceRow) => Number(r.durationMs ?? r.elapsedMs ?? r.duration_ms ?? 0) || 0;
        let smallest = 0;
        for (let i = 1; i < bucket.length; i++) if (score(bucket[i]) < score(bucket[smallest])) smallest = i;
        bucket.splice(smallest, 1);
      }
    }
    this.buckets.set(key, bucket);
  }
  rows(): PerformanceRow[] { return [...this.buckets.values()].flat(); }
}

/** 扫描开始时存在的全部日文件及各自长度快照，避免追随持续追加而永不结束。 */
export async function scanPluginLogs(dir: string, progress: (message: string) => void = () => {}): Promise<DiagnosticOutput> {
  const names = (await fs.promises.readdir(dir).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw error;
  })).filter(name => LOG_NAME.test(name)).sort();
  const snapshots = await Promise.all(names.map(async name => {
    try { return { name, size: (await fs.promises.stat(path.join(dir, name))).size }; }
    catch { return { name, size: -1 }; }
  }));
  const coverage: DiagnosticCoverage = { mode: 'local-plugin-full', files: names.length, readFiles: 0, unreadableFiles: 0,
    bytes: 0, lines: 0, records: 0, invalidLines: 0, oversizedLines: 0, droppedLines: 0, windows: 0, sessions: 0,
    firstDay: names[0]?.match(LOG_NAME)?.[1], lastDay: names.at(-1)?.match(LOG_NAME)?.[1], sources: [] };
  const accumulator = new PerformanceAccumulator(), samples = new ReportSamples();
  const windows = new Set<string>(), sessions = new Set<string>(), sources = new Map<string, DiagnosticSource>();
  const consume = (line: string) => {
    const dropped = line.match(/\[logging\] droppedLines=(\d+)/);
    if (dropped) coverage.droppedLines += Number(dropped[1]);
    const match = line.match(/\[(perf|transport|compaction)\] (\{.*\})\s*$/);
    if (!match) { if (/\[(perf|transport|compaction)\] /.test(line)) coverage.invalidLines++; return; }
    let row: PerformanceRow;
    try {
      const parsed = JSON.parse(match[2]);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      const identity = line.slice(0, match.index).match(/\[pluginVersion=([\w.-]+) windowId=([\w.-]+) hostId=([\w.-]+)\]/);
      row = { ...parsed, diagnosticType: match[1], ...(identity ? { pluginVersion: identity[1], windowId: identity[2], hostId: identity[3] } : {}) };
    } catch { coverage.invalidLines++; return; }
    coverage.records++; accumulator.add(row); samples.add(row);
    const at = typeof row.atMs === 'number' && Number.isFinite(row.atMs) && row.atMs > 0 && row.atMs <= 8640000000000000 ? row.atMs : undefined;
    if (at !== undefined) { coverage.fromMs = Math.min(coverage.fromMs ?? at, at); coverage.toMs = Math.max(coverage.toMs ?? at, at); }
    if (typeof row.windowId === 'string') windows.add(row.windowId);
    for (const id of [row.threadId, row.parentThreadId, row['conversation.id'], row.thread_id]) if (typeof id === 'string' && id) sessions.add(id);
    const pluginVersion = text(row.pluginVersion), windowId = text(row.windowId), hostId = text(row.hostId);
    const key = JSON.stringify([pluginVersion, windowId, hostId]);
    const source = sources.get(key) ?? { pluginVersion, windowId, hostId, records: 0, turns: 0, tools: 0, failures: 0 };
    source.records++;
    if (row.event === 'turn_summary') source.turns++;
    if (row.event === 'span_end' && ['tool', 'bash'].includes(String(row.kind))) { source.tools++; if (row.outcome === 'failed') source.failures++; }
    sources.set(key, source);
  };
  for (const [index, snapshot] of snapshots.entries()) {
    progress(`正在全量扫描插件日志 ${index + 1}/${snapshots.length}：${snapshot.name}`);
    if (snapshot.size < 0) { coverage.unreadableFiles++; continue; }
    if (!snapshot.size) { coverage.readFiles++; continue; }
    const decoder = new StringDecoder('utf8'); let pending = '', oversized = false, fileBytes = 0;
    const accept = (chunk: string) => {
      const parts = chunk.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (!oversized) {
          if (pending.length + parts[i].length > MAX_LINE) { pending = ''; oversized = true; }
          else pending += parts[i];
        }
        if (i < parts.length - 1) {
          coverage.lines++;
          if (oversized) coverage.oversizedLines++; else consume(pending);
          pending = ''; oversized = false;
        }
      }
    };
    try {
      for await (const chunk of fs.createReadStream(path.join(dir, snapshot.name), { highWaterMark: 65536, end: snapshot.size - 1 })) {
        fileBytes += (chunk as Buffer).length; coverage.bytes += (chunk as Buffer).length; accept(decoder.write(chunk as Buffer));
      }
      accept(decoder.end());
      if (pending || oversized) { coverage.lines++; if (oversized) coverage.oversizedLines++; else consume(pending); }
      if (fileBytes === snapshot.size) coverage.readFiles++; else coverage.unreadableFiles++;
    } catch { coverage.unreadableFiles++; }
  }
  coverage.windows = windows.size; coverage.sessions = sessions.size; coverage.sources = [...sources.values()];
  const analyzed = accumulator.result();
  if (coverage.unreadableFiles || coverage.invalidLines || coverage.oversizedLines || coverage.droppedLines) analyzed.findings.push({ id: 'log-coverage', title: '部分观测证据缺失', severity: 'warning', traceIds: [],
    evidence: `未完整读取 ${coverage.unreadableFiles} 个文件；损坏记录 ${coverage.invalidLines} 行；超长行 ${coverage.oversizedLines} 行；日志缓冲丢弃 ${coverage.droppedLines} 行。`,
    recommendation: '先核对目录权限、日志写入和采集开关，修复证据缺失；已删除或未采集的数据无法追溯恢复。' });
  const sourceNote = `诊断范围：本机整个插件，不按工作区或会话过滤。扫描全部 ${coverage.files} 个保留日志文件，完整读取 ${coverage.readFiles} 个，已读 ${(coverage.bytes / 1048576).toFixed(2)} MiB、${coverage.records} 条结构化记录。`;
  const overview = ['# 插件全局诊断范围', '', sourceNote, '',
    `文件日期：${coverage.firstDay ?? '无'} 至 ${coverage.lastDay ?? '无'}；可识别窗口 ${coverage.windows} 个、会话/子线程 ${coverage.sessions} 个。`,
    `全量汇总：${analyzed.summary.turns} 轮任务、${analyzed.summary.tools} 次工具调用、${analyzed.summary.failures} 次失败。`, '',
    '包含本机共享日志目录中的所有工作区、窗口、会话和插件版本。通常保留最近 7 天；文件按扫描开始时的长度读取，扫描期间新增数据留到下次诊断。',
    '仅分析实际采集的观测数据，不是对所有源代码的自动审查。已删除、关闭采集或升级前未记录的内容，以及其他机器/远程宿主的日志不在覆盖范围。',
    `证据缺口：未完整读取文件 ${coverage.unreadableFiles}；损坏行 ${coverage.invalidLines}；超长行 ${coverage.oversizedLines}；缓冲丢弃行 ${coverage.droppedLines}。`, '',
    '## 全量版本与窗口统计', '', '| 插件版本 | 窗口 | 宿主 | 记录 | 轮次 | 工具 | 失败 |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...coverage.sources.map(s => `| ${cell(s.pluginVersion)} | ${cell(s.windowId)} | ${cell(s.hostId)} | ${s.records} | ${s.turns} | ${s.tools} | ${s.failures} |`), '',
    '## 代表性明细', '', '上述统计和问题检测处理了全部有效记录；以下仅展示有限的最慢项与近期示例，以控制报告大小，不代表只分析了这些示例。', ''];
  return { ...analyzed, coverage, sourceNote, report: overview.join('\n') + '\n' + performanceReport(samples.rows(), '明细展示经过筛选；全量统计以上方全局汇总为准。') };
}
