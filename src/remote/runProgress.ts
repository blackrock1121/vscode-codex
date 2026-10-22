import { randomUUID } from 'node:crypto';
import type { ToWebview } from '../shared';

/** 与电脑 working pill 共用事件口径；读取快照、额度更新和心跳都不是新进展。 */
export class RunProgress {
    private value?: {id: string; startedAt: number; lastProgressAt: number; progress: string; phase: string; finishedAt?: number};
    private output = 0;
    private previous = 0;
    private base = 0;
    private thinking = 0;
    private estimate = 0;
    private tools = new Set<string>();
    private waiting = new Set<string>();
    private busy = false;
    observe(e: ToWebview, now = Date.now()): void {
        if (e.kind === 'busy') {
            if (e.busy && !this.busy) {
                this.value = {id: randomUUID(), startedAt: now, lastProgressAt: now, progress: '任务开始', phase: 'model'};
                this.output = this.previous = this.base = this.thinking = this.estimate = 0;
                this.tools.clear(); this.waiting.clear();
            }
            this.busy = e.busy;
            if (!e.busy && this.value && !this.value.finishedAt) this.finish(now, 'finished');
            return;
        }
        const run = this.value;
        if (!run || run.finishedAt) return;
        if (e.kind === 'result') { this.finish(now, e.isError ? 'failed' : 'finished'); return; }
        if (e.kind === 'permission_request') { this.waiting.add(e.requestId); run.phase = 'waiting'; return; }
        if (e.kind === 'permission_resolved') { this.waiting.delete(e.requestId); this.phase(); return; }
        if (e.kind === 'tokens' && Number.isFinite(e.output) && e.output >= 0) {
            if (e.output < this.previous) this.base += this.previous;
            this.previous = e.output; this.output = this.base + e.output;
        }
        if (e.kind === 'thinking_tokens' && Number.isFinite(e.tokens)) this.thinking = Math.max(this.thinking, e.tokens);
        if (e.kind === 'text_delta' || e.kind === 'thinking_delta') {
            for (const char of e.text) this.estimate += char.codePointAt(0)! >= 0x3000 ? 1.05 : .25;
        }
        if (e.kind === 'tool_input') this.tools.add(e.toolId);
        if (e.kind === 'block_start' && e.blockType === 'tool_use' && e.toolId) this.tools.add(e.toolId);
        if (e.kind === 'tool_result') this.tools.delete(e.toolUseId);
        if (this.waiting.size) return;
        const labels: Record<string, string> = {
            block_end: '模型阶段完成', text_delta: '收到回复内容', text_snap: '收到回复内容', thinking_delta: '收到思考进展',
            tool_input: '收到工具输入', tool_input_partial: '收到工具输入', tool_result: '收到工具结果',
            compacting: '开始压缩上下文', compacted: '上下文压缩完成',
        };
        const label = e.kind === 'activity' ? e.label : e.kind === 'block_start'
            ? e.blockType === 'thinking' ? '开始模型思考' : e.blockType === 'tool_use' ? '工具开始执行' : '开始生成回复' : labels[e.kind];
        if (label) { run.lastProgressAt = now; run.progress = Array.from(label).slice(0, 120).join(''); }
        if (e.kind === 'compacting') run.phase = 'compacting';
        else if (label) this.phase();
    }
    private phase(): void { if (this.value) this.value.phase = this.waiting.size ? 'waiting' : this.tools.size ? 'tools' : 'model'; }
    private finish(now: number, phase: string): void { if (this.value) { this.value.finishedAt = now; this.value.phase = phase; } }
    snapshot() {
        if (!this.value) return null;
        const exact = Math.max(this.output, this.thinking), estimated = Math.round(this.estimate);
        return {...this.value, tokens: Math.max(exact, estimated), estimated: estimated > exact};
    }
}
