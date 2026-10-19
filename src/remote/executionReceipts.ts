import { createHash } from 'node:crypto';
import type { Command } from './command';
import type { RemoteReply } from './bridgeClient';

interface RecordEntry { digest: string; state: 'accepted' | 'rejected' | 'unknown'; sessionId: string; error?: string }
export interface ReceiptStorage { read(): Record<string, RecordEntry>; write(value: Record<string, RecordEntry>): Promise<void> }
/** 只保存 ID、摘要和交接状态，不保存提示词/正文。先记录未知，再执行；崩溃后不重发。 */
export class ExecutionReceipts {
    private writing: Promise<unknown> = Promise.resolve();
    constructor(private readonly storage: ReceiptStorage) {}
    private key(deviceId: string, commandId: string): string { return deviceId + '/' + commandId; }
    status(command: Command, commandId: string) {
        const entry = this.storage.read()[this.key(command.deviceId, commandId)];
        return {kind: 'command.status', commandId, state: entry?.sessionId === command.target?.sessionId ? entry.state : 'unknown', sessionId: command.target?.sessionId};
    }
    private transact<T>(fn: (records: Record<string, RecordEntry>) => Promise<T>): Promise<T> {
        const task = this.writing.then(() => fn({...this.storage.read()}));
        this.writing = task.catch(() => undefined); return task;
    }
    async run(command: Command, execute: () => Promise<RemoteReply>): Promise<RemoteReply> {
        const key = this.key(command.deviceId, command.commandId);
        const digest = createHash('sha256').update(JSON.stringify([command.target?.workspaceId, command.target?.sessionId, command.operation])).digest('hex');
        const old = await this.transact(async records => {
            const old = records[key];
            if (old) return old;
            if (Object.keys(records).length >= 10000) throw new Error('EXECUTION_RECEIPTS_FULL');
            records[key] = {digest, state: 'unknown', sessionId: command.target!.sessionId};
            await this.storage.write(records); return undefined;
        });
        if (old) {
            if (old.digest !== digest || old.state === 'unknown') throw new Error('PLUGIN_RESULT_UNKNOWN');
            return old.state === 'accepted' ? {accepted: true, result: {kind: 'message.accepted', sessionId: old.sessionId, delivery: 'handed_to_original_session'}}
                : {accepted: false, error: old.error ?? 'MESSAGE_NOT_SENT'};
        }
        const reply = await execute();
        await this.transact(async records => {
            records[key] = {digest, state: reply.accepted ? 'accepted' : 'rejected', sessionId: command.target!.sessionId, ...(!reply.accepted ? {error: reply.error} : {})};
            await this.storage.write(records);
        });
        return reply;
    }
}
