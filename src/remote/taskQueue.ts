import { randomUUID } from 'node:crypto';
import { operationFailure, operationLog } from '../operations';

export interface QueuedTask {
    id: string; text: string; context?: string; images: { mediaType: string; data: string }[]; files: string[];
    contexts: { label: string; text: string }[]; labels: string[]; imageUris: string[];
    createdAt: number; deviceId?: string; commandId?: string;
}
/** 由扩展宿主调度，手机退后台及 Webview 重载不影响排队。失败保留队首并暂停。 */
export class SessionTaskQueue {
    readonly items: QueuedTask[] = [];
    paused = false;
    sending?: string;
    add(value: Omit<QueuedTask, 'id' | 'createdAt'>): QueuedTask {
        if (this.items.length >= 30 || this.items.reduce((n, x) => n + JSON.stringify(x).length, 0) + JSON.stringify(value).length > 12_000_000)
            throw new Error('QUEUE_FULL');
        const item = { ...value, id: randomUUID(), createdAt: Date.now() };
        this.items.push(item); return item;
    }
    remove(id: string): QueuedTask {
        if (this.sending === id) throw new Error('QUEUE_DISPATCHING');
        const index = this.items.findIndex(item => item.id === id);
        if (index < 0) throw new Error('QUEUE_CHANGED');
        return this.items.splice(index, 1)[0];
    }
    async drain(available: () => boolean, send: (item: QueuedTask) => Promise<boolean>): Promise<void> {
        if (this.paused || this.sending || !this.items.length || !available()) return;
        const item = this.items[0]; this.sending = item.id;
        const started = Date.now(), fields = { operationId: item.id };
        operationLog('queue.dispatch', 'start', { ...fields, queueMs: started - item.createdAt });
        try {
            if (await send(item)) {
                const index=this.items.findIndex(value=>value.id===item.id);if(index>=0)this.items.splice(index,1);
                operationLog('queue.dispatch', 'dispatched', { ...fields, durationMs: Date.now() - started });
            } else {
                this.paused = true;
                operationLog('queue.dispatch', 'paused', { ...fields, reason: 'not_accepted', durationMs: Date.now() - started });
            }
        } catch (error) {
            this.paused = true;
            operationFailure('queue.dispatch', error, { ...fields, retained: true, durationMs: Date.now() - started });
        }
        finally { this.sending = undefined; }
    }
    summary(page = 0) {
        return { paused: this.paused, total: this.items.length, page,
            items: this.items.slice(page * 5, page * 5 + 5).map(item => ({ id: item.id, text: item.text.slice(0, 300),
                imageCount: item.images.length, sending: item.id === this.sending, source: item.deviceId ? '手机' : '电脑' })) };
    }
}
