import type { DiagnosticFinding } from './analysis';

export type IssueState = 'open' | 'repairing' | 'awaiting_verification' | 'verified' | 'external' | 'dismissed' | 'deferred' | 'recurred';
export const issueStateLabel: Record<IssueState, string> = {
  open: '待核验', repairing: '修复中', awaiting_verification: '已修改，待验证', verified: '复测通过（会话回报）',
  external: '外部原因，待跟踪', dismissed: '无需修改', deferred: '暂缓处理', recurred: '修复后再次发现',
};
export interface Observation { version: string; firstAt: number; lastAt: number; count: number }
export interface RepairResult {
  issueId: string; outcome: 'fixed' | 'external' | 'not_a_bug' | 'deferred'; reason: string;
  commit?: string; version?: string; tests?: string;
  verification?: { outcome: 'passed' | 'failed' | 'insufficient'; at: number; version: string; scenario: string; evidence: string };
}
export interface TrackedIssue {
  id: string; title: string; category?: string; state: IssueState; firstDetectedAt: number; lastDetectedAt: number;
  firstEventAt?: number; lastEventAt?: number; latestBatchId?: string;
  lastEventByVersion?: Record<string, number>;
  result?: RepairResult; resultAt?: number;
  history: { at: number; batchId: string; sessionId?: string; state: IssueState; result?: RepairResult }[];
}
export interface IssueView extends TrackedIssue {
  findingIds: string[]; relation: 'first' | 'historical' | 'new_events' | 'unknown';
}
export interface TrackingView {
  issues: IssueView[]; modelCount: number; legacy: boolean; warning?: string;
  batch?: { id: string; sessionId?: string; receiptPath: string; revision: number; reported: number; total: number; error?: string };
}
export function actionable(state: IssueState): boolean { return ['open', 'deferred', 'recurred'].includes(state); }
export function findingCount(findings: DiagnosticFinding[]): number { return findings.filter(f => f.origin !== 'model' && !f.id.startsWith('model-')).length; }
export function trackingSummary(view: TrackingView): string {
  const count = (states: IssueState[]) => view.issues.filter(i => states.includes(i.state)).length;
  return `待核验问题 ${count(['open', 'deferred', 'recurred'])} 项 · 修复中 ${count(['repairing'])} · 待验证 ${count(['awaiting_verification'])} · 复测通过 ${count(['verified'])} · 外部原因 ${count(['external'])} · 无需修改 ${count(['dismissed'])}`;
}
