import { createHash } from 'node:crypto';
import type { TimelineItem } from '../shared';

/** 仅传展示文本，不传 data URI、完整 Webview 消息或执行能力。长回复按页读取，不静默截断。 */
export function transcriptText(items: TimelineItem[]): string {
    return items.map(item => {
        switch (item.type) {
            case 'user': return `你\n${item.text}${item.images?.length ? '\n（图片请在电脑端查看）' : ''}`;
            case 'assistant_text': return `Codex\n${item.text}`;
            case 'thinking': return `思考\n${item.text}`;
            case 'tool': return `工具 · ${item.displayName || item.name}${item.isError ? ' · 失败' : ''}\n${JSON.stringify(item.input ?? {})}\n${item.result ?? ''}`;
            case 'image': return '（图片请在电脑端查看）';
            case 'compaction': return '（上下文已压缩）';
            case 'checkpoint': return '';
        }
    }).filter(Boolean).join('\n\n');
}
export function transcriptPage(text: string, state: Record<string, unknown>, query: { end?: number; revision?: string }) {
    const revision = createHash('sha256').update(text).update(JSON.stringify(state)).digest('hex');
    if (query.end === undefined && query.revision === revision) return { ...state, revision, unchanged: true };
    const reset = query.end !== undefined && query.revision !== revision;
    let end = query.end !== undefined && !reset ? Math.min(query.end, text.length) : text.length;
    // 游标是 UTF-16 偏移；边界不能切开 emoji 等代理对。
    if (end > 0 && end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    let start = Math.max(0, end - 1600);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
    while (Buffer.byteLength(JSON.stringify(text.slice(start, end))) > 5000 && start < end) {
        start++; if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) start++;
    }
    return { ...state, revision, text: text.slice(start, end), start, end, total: text.length, reset, unchanged: false };
}
