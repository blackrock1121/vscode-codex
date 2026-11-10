import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DiagnosticRecord } from './jobs';
import type { DiagnosticFinding } from './analysis';
import { actionable, type IssueView, type RepairResult, type TrackedIssue, type TrackingView } from './tracking';
import { redactDiagnosticText } from './redact';
import { observeOperation, operationFailure, operationLog } from '../operations';

interface Batch { id: string; recordId: string; issueIds: string[]; startedAt: number; sessionId?: string; revision: number; reportedIds: string[]; error?: string; errorFailureId?: string; cancelled?: boolean }
interface Membership { ids: Record<string, string[]>; relations: Record<string, IssueView['relation']>; legacy: boolean }
interface Ledger { schema: 1; issues: Record<string, TrackedIssue>; records: Record<string, Membership>; batches: Record<string, Batch> }
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d-]{36}$/.test(value);
const safeText = (value: unknown, limit = 4000): value is string => typeof value === 'string' && !!value.trim() && value.length <= limit;
const version = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(v);
const isModel = (f: DiagnosticFinding) => f.origin === 'model' || f.id.startsWith('model-');

/** 历史分组不强行迁移到新指纹；规则升级不伪造“首次发生”或继承关闭结论。 */
export function issueKey(record: DiagnosticRecord, finding: DiagnosticFinding): string {
  const source = !finding.fingerprint && finding.id.startsWith('logging-source-') ? `source:${record.loggingAudit?.sourceHash ?? record.pluginVersion}:` : '';
  return `issue-${hash(source + (finding.fingerprint ?? `legacy:${finding.id}`))}`;
}

/** 台账使用独立跨进程锁；整批回写先校验再落盘，任何失败不影响原诊断报告。 */
export class DiagnosticLedger {
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dir: string) { this.dir = path.join(dir, 'tracking'); }
  receiptPath(id: string): string { if (!uuid(id)) throw Error('修复批次编号无效'); return path.join(this.dir, `receipt-${id}.json`); }
  private async transaction<T>(fn: (data: Ledger) => Promise<T> | T): Promise<T> {
    const run = this.queue.catch(() => {}).then(() => observeOperation('diagnostics.ledger', async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const lockPath = path.join(this.dir, 'ledger.lock');
      let lock: fs.FileHandle | undefined;
      for (let n = 0; n < 100; n++) {
        try { lock = await fs.open(lockPath, 'wx', 0o600); break; }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          // 只回收明确已退出的持锁进程；不根据耗时删除活跃锁。
          try {
            const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') await fs.unlink(lockPath); }
            }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      if (!lock) throw Error('问题台账正在被其他窗口更新，请稍后刷新');
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid }));
        const file = path.join(this.dir, 'ledger.json'); let data: Ledger;
        try { data = JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; data = { schema: 1, issues: {}, records: {}, batches: {} }; }
        if (data.schema !== 1 || !data.issues || !data.records || !data.batches) throw Error('问题台账格式不兼容，原文件已保留');
        const before = JSON.stringify(data), result = await fn(data), after = JSON.stringify(data);
        if (before !== after) {
          const temp = `${file}.${randomUUID()}.tmp`;
          try { await fs.writeFile(temp, after, { mode: 0o600 }); await fs.rename(temp, file); }
          finally { await fs.unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') operationFailure('diagnostics.ledger.cleanup', error, { phase: 'temporary' }); }); }
        }
        return result;
      } finally {
        // close 失败也要尝试释放锁；清理错误独立记录，不能覆盖读写台账的原始异常。
        try { await lock.close(); } catch (error) { operationFailure('diagnostics.ledger.cleanup', error, { phase: 'close' }); }
        await fs.unlink(lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') operationFailure('diagnostics.ledger.cleanup', error, { phase: 'unlock' }); });
      }
    }));
    this.queue = run; return run;
  }
  private register(data: Ledger, record: DiagnosticRecord): void {
    if (record.status !== 'completed' || data.records[record.id]) return;
    const membership: Membership = { ids: {}, relations: {}, legacy: !record.trackingSchema };
    for (const f of record.findings.filter(f => !isModel(f))) {
      const id = issueKey(record, f), observations = f.observations ?? [];
      const first = observations.length ? Math.min(...observations.map(o => o.firstAt)) : undefined;
      const last = observations.length ? Math.max(...observations.map(o => o.lastAt)) : undefined;
      let issue = data.issues[id];
      if (!membership.ids[id]) {
        membership.ids[id] = [];
        membership.relations[id] = !issue ? 'first' : last === undefined || issue.lastEventAt === undefined ? 'unknown' : last > issue.lastEventAt ? 'new_events' : 'historical';
      }
      membership.ids[id].push(f.id);
      if (!issue) data.issues[id] = issue = { id, title: f.title, category: f.category, state: 'open', firstDetectedAt: record.createdAt, lastDetectedAt: record.createdAt, history: [] };
      issue.firstDetectedAt = Math.min(issue.firstDetectedAt, record.createdAt);
      issue.lastDetectedAt = Math.max(issue.lastDetectedAt, record.createdAt);
      if (first !== undefined) issue.firstEventAt = Math.min(issue.firstEventAt ?? first, first);
      if (last !== undefined) issue.lastEventAt = Math.max(issue.lastEventAt ?? last, last);
      issue.lastEventByVersion ??= {};
      for (const o of observations) if (version(o.version)) issue.lastEventByVersion[o.version] = Math.max(issue.lastEventByVersion[o.version] ?? 0, o.lastAt);
      const result = issue.result;
      // 只能由修复回报之后、同一目标版本的明确事件判定再次发现；旧版本、未知时间不能推断。
      if (result?.outcome === 'fixed' && issue.resultAt && ['awaiting_verification', 'verified'].includes(issue.state) &&
        observations.some(o => o.version === result.version && o.lastAt > Math.max(issue.resultAt!, result.verification?.at ?? 0))) {
        issue.state = 'recurred';
        issue.history.push({ at: Date.now(), batchId: issue.latestBatchId!, state: issue.state });
      }
    }
    data.records[record.id] = membership;
  }
  private async importReceipts(data: Ledger): Promise<void> {
    for (const batch of Object.values(data.batches)) {
      if (!batch.sessionId || batch.cancelled) continue;
      try {
        const file = this.receiptPath(batch.id), stat = await fs.stat(file);
        if (stat.size > 1024 * 1024) throw Error('修复结果超过 1 MiB 限制');
        const raw = JSON.parse(await fs.readFile(file, 'utf8'));
        if (raw.schema !== 1 || raw.batchId !== batch.id || raw.diagnosticId !== batch.recordId || !Number.isSafeInteger(raw.revision) || raw.revision < 1) throw Error('修复结果的格式、诊断编号或批次不匹配');
        if (raw.revision <= batch.revision) continue;
        if (!Array.isArray(raw.results) || raw.results.length > batch.issueIds.length) throw Error('修复结果条目无效');
        const seen = new Set<string>(), results: RepairResult[] = [];
        for (const r of raw.results) {
          if (!r || !batch.issueIds.includes(r.issueId) || seen.has(r.issueId) || !['fixed', 'external', 'not_a_bug', 'deferred'].includes(r.outcome) || !safeText(r.reason)) throw Error('修复结果包含重复、越界或不完整的问题条目');
          if (data.issues[r.issueId]?.latestBatchId !== batch.id) throw Error('此结果属于旧修复批次，不能覆盖新处理结果');
          if (r.outcome === 'fixed' && (!version(r.version) || typeof r.commit !== 'string' || !/^[a-f\d]{7,40}$/i.test(r.commit) || !safeText(r.tests))) throw Error('已修改条目必须提供版本、提交和测试证据');
          if (r.verification && (r.outcome !== 'fixed' || !['passed', 'failed', 'insufficient'].includes(r.verification.outcome) || r.verification.version !== r.version ||
            !Number.isFinite(r.verification.at) || r.verification.at < batch.startedAt || r.verification.at > Date.now() || !safeText(r.verification.scenario) || !safeText(r.verification.evidence))) throw Error('复测结果必须有对应版本、场景、时间和证据');
          seen.add(r.issueId);
          results.push({ issueId: r.issueId, outcome: r.outcome, reason: redactDiagnosticText(r.reason, 4000),
            ...(r.outcome === 'fixed' ? { version: r.version, commit: r.commit, tests: redactDiagnosticText(r.tests, 4000) } : {}),
            ...(r.verification ? { verification: { outcome: r.verification.outcome, version: r.version, at: r.verification.at,
              scenario: redactDiagnosticText(r.verification.scenario, 4000), evidence: redactDiagnosticText(r.verification.evidence, 4000) } } : {}) });
        }
        for (const result of results) {
          const issue = data.issues[result.issueId];
          const previous = issue.result;
          if (!issue.resultAt || previous?.commit !== result.commit || previous?.version !== result.version) issue.resultAt = Date.now();
          issue.result = result;
          issue.state = result.outcome === 'fixed' ? result.verification?.outcome === 'passed' ? 'verified' : result.verification?.outcome === 'failed' ? 'recurred' : 'awaiting_verification' : result.outcome === 'not_a_bug' ? 'dismissed' : result.outcome;
          if (result.outcome === 'fixed' && (issue.lastEventByVersion?.[result.version!] ?? 0) > Math.max(issue.resultAt, result.verification?.at ?? 0)) issue.state = 'recurred';
          issue.history.push({ at: Date.now(), batchId: batch.id, sessionId: batch.sessionId, state: issue.state, result });
        }
        operationLog('diagnostics.receipt.validate', batch.errorFailureId ? 'recovered' : 'completed', {
          diagnosticId: batch.recordId, batchId: batch.id, revision: raw.revision, resultCount: results.length,
          previousFailureId: batch.errorFailureId,
        });
        batch.revision = raw.revision; batch.reportedIds = [...new Set([...batch.reportedIds, ...seen])]; delete batch.error; delete batch.errorFailureId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        const message = error instanceof SyntaxError ? '修复结果 JSON 不完整，请保存完整文件后刷新' : redactDiagnosticText(String((error as Error).message), 300);
        // 相同坏回报的页面刷新不刷屏；结果正文和 reason/tests 不进入运行日志。
        if (batch.error !== message || !batch.errorFailureId) {
          batch.errorFailureId = randomUUID();
          operationFailure('diagnostics.receipt.validate', error, { diagnosticId: batch.recordId, batchId: batch.id, failureId: batch.errorFailureId });
        }
        batch.error = message;
      }
    }
  }
  async sync(records: DiagnosticRecord[]): Promise<Map<string, TrackingView>> {
    return this.transaction(async data => {
      await this.importReceipts(data);
      for (const record of [...records].sort((a, b) => a.createdAt - b.createdAt)) this.register(data, record);
      return new Map(records.filter(r => r.status === 'completed').map(r => {
        const member = data.records[r.id];
        const batch = Object.values(data.batches).filter(b => b.recordId === r.id && !b.cancelled).sort((a, b) => b.startedAt - a.startedAt)[0];
        return [r.id, { issues: Object.entries(member.ids).map(([id, findingIds]) => ({ ...data.issues[id], findingIds, relation: member.relations[id] })),
          modelCount: r.findings.filter(isModel).length, legacy: member.legacy,
          ...(batch ? { batch: { id: batch.id, sessionId: batch.sessionId, receiptPath: this.receiptPath(batch.id), revision: batch.revision,
            reported: batch.reportedIds.length, total: batch.issueIds.length, error: batch.error } } : {}) }];
      }));
    });
  }
  async begin(record: DiagnosticRecord): Promise<{ batchId: string; prompt: string }> {
    return this.transaction(async data => {
      await this.importReceipts(data); this.register(data, record);
      const ids = Object.keys(data.records[record.id].ids).filter(id => actionable(data.issues[id].state));
      if (!ids.length) throw Error('这些问题已在处理、待验证或已有处理结论，请查看问题台账和已有修复会话');
      const batch: Batch = { id: randomUUID(), recordId: record.id, issueIds: ids, startedAt: Date.now(), revision: 0, reportedIds: [] };
      data.batches[batch.id] = batch;
      for (const id of ids) { const issue = data.issues[id]; issue.state = 'repairing'; issue.latestBatchId = batch.id; issue.history.push({ at: batch.startedAt, batchId: batch.id, state: 'repairing' }); }
      const template = { schema: 1, diagnosticId: record.id, batchId: batch.id, revision: 1, results: [] };
      return { batchId: batch.id, prompt: `\n\n问题台账与结果回写（本次修复约定）：\n仅处理以下批次分配的问题；报告其他条目只作背景，已在其他会话处理的项目不要重复修改。\n${JSON.stringify(ids.map(id => ({ issueId: id, title: data.issues[id].title, findingIds: data.records[record.id].ids[id] })))}\n` +
        `处理后将结构化结果写入 ${JSON.stringify(this.receiptPath(batch.id))}（先写同目录临时文件，再原子重命名）。不要直接编辑 ledger.json 或原诊断记录。\n` +
        `文件模板：${JSON.stringify(template)}。results 每项包含 issueId、outcome（fixed/external/not_a_bug/deferred）、reason。fixed 必须增加 commit、version、tests；未处理的项目不要伪造结果。\n` +
        'fixed 仅代表已修改，默认待验证。有真实复测证据时可增加 verification:{outcome:"passed"或"failed"或"insufficient",at:复测时刻的毫秒时间戳,version:实际测试版本,scenario:复测场景,evidence:测试命令及结果或运行日志位置}。必须先安装并启用对应版本再声称运行验证通过；没有触发相关功能、旧版本日志和单纯没有报错都不是通过证据。测试结果由会话回报，插件不会把回报伪装成自动验证。\n' +
        '后续补充结果时递增 revision；同批次可分批回写。任务结束前必须回写每个已核验问题的结论，并在回复中说明未完成项目。\n' };
    });
  }
  async bind(batchId: string, sessionId: string): Promise<void> { await this.transaction(data => { const b = data.batches[batchId]; if (!b || b.cancelled) throw Error('修复批次已失效'); b.sessionId = sessionId; }); }
  async cancel(batchId: string): Promise<void> { await this.transaction(data => {
    const b = data.batches[batchId]; if (!b) return; b.cancelled = true;
    for (const id of b.issueIds) { const i = data.issues[id]; if (i.latestBatchId === batchId && i.state === 'repairing') { i.state = 'open'; i.history.push({ at: Date.now(), batchId, state: 'open' }); } }
  }); }
  async reopen(recordId: string, issueId: string): Promise<void> { await this.transaction(data => {
    if (!data.records[recordId]?.ids[issueId]) throw Error('此问题不属于当前诊断');
    const issue = data.issues[issueId];
    if (issue.state === 'repairing') throw Error('请先结束正在进行的修复批次');
    issue.state = 'open';
    // 旧会话迟到回报不能覆盖用户明确的重新核验决定。
    issue.latestBatchId = undefined;
    issue.history.push({ at: Date.now(), batchId: 'manual-reopen', state: 'open' });
  }); }
}
