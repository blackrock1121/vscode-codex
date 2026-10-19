import { expectedFileError, operationFailure, operationLog } from '../operations';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { isReadOperation, parseCommand, type Command } from './command';

export type RemoteReply = { accepted: true; result: unknown } | { accepted: false; error: string };
export interface RemoteRegistration { windowId: string; workspaceId: string; label: string; path?: string; folderCount?: number }

/** 桥接不存在时仅定期检查私有目录；不访问公网，也不自动执行断线前的指令。 */
export class RemoteBridgeClient {
    private socket?: net.Socket;
    private retry?: NodeJS.Timeout;
    private disposed = false;
    constructor(private readonly directory: string, private readonly registration: RemoteRegistration,
        private readonly execute: (command: Command, active: () => boolean) => Promise<RemoteReply>) {}
    start(): void { if (!this.disposed && !this.socket && !this.retry) this.connect(); }
    private connect(): void {
        if (this.disposed) return;
        try {
            for (const [name, type] of [['', 'directory'], ['bridge.json', 'file'], ['bridge.sock', 'socket']] as const) {
                const stat = fs.lstatSync(path.join(this.directory, name));
                if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) ||
                    !(type === 'directory' ? stat.isDirectory() : type === 'file' ? stat.isFile() && stat.size <= 1024 : stat.isSocket())) throw new Error();
            }
            const config = JSON.parse(fs.readFileSync(path.join(this.directory, 'bridge.json'), 'utf8'));
            if (config.version !== 1 || typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error();
            const socket = this.socket = net.createConnection(path.join(this.directory, 'bridge.sock'));
            let buffer = Buffer.alloc(0), registered = false, pending = 0;
            const deadline = setTimeout(() => socket.destroy(), 5000);
            const send = (value: unknown) => {
                const text = JSON.stringify(value) + '\n';
                if (socket.destroyed || socket.writableLength > 64_000 || Buffer.byteLength(text) > 16_000) { socket.destroy(); return; }
                socket.write(text);
            };
            socket.on('connect', () => send({ kind: 'register', version: 1, token: config.token, ...this.registration }));
            socket.on('error', error => operationFailure('remote.connection', error));
            socket.on('close', () => {
                clearTimeout(deadline);
                if (this.socket === socket) this.socket = undefined;
                this.schedule();
            });
            const receive = (frame: any) => {
                if (!registered) {
                    if (frame?.kind !== 'registered' || frame.version !== 1) throw new Error();
                    registered = true; clearTimeout(deadline); operationLog('remote.connection', 'ready'); return;
                }
                if (frame?.kind !== 'execute' || typeof frame.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.id) || pending >= 16) throw new Error();
                const command = parseCommand(frame.command, Date.now());
                if (command.target?.windowId !== this.registration.windowId || command.target.workspaceId !== this.registration.workspaceId) throw new Error();
                pending++;
                const active = () => !this.disposed && !socket.destroyed && command.expiresAt > Date.now();
                void this.execute(command, active).catch((error): RemoteReply => {
                    operationFailure('remote.execute', error);
                    // 未知异常可能发生在交接以后；中断连接让桥接记录“结果未知”，不能谎报未执行。
                    if (!isReadOperation(command.operation)) socket.destroy();
                    return { accepted: false, error: 'PLUGIN_OPERATION_FAILED' };
                })
                    .then(reply => {
                        if (Buffer.byteLength(JSON.stringify(reply)) > 7000) reply = { accepted: false, error: 'RESULT_TOO_LARGE' };
                        send({ kind: 'reply', id: frame.id, reply });
                    }).finally(() => { pending--; }).catch(error => { operationFailure('remote.reply', error); socket.destroy(); });
            };
            socket.on('data', data => {
                buffer = Buffer.concat([buffer, data]);
                try {
                    let end: number;
                    while ((end = buffer.indexOf(10)) >= 0) {
                        if (end > 16_000) throw new Error();
                        const frame = JSON.parse(buffer.subarray(0, end).toString('utf8')); buffer = buffer.subarray(end + 1); receive(frame);
                    }
                    if (buffer.length > 16_000) throw new Error();
                } catch (error) { operationFailure('remote.protocol', error); socket.destroy(); }
            });
        } catch (error) { if (!expectedFileError(error)) operationFailure('remote.prepare', error); this.schedule(); }
    }
    private schedule(): void {
        if (this.disposed || this.retry) return;
        this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, 5000);
        this.retry.unref();
    }
    dispose(): void { this.disposed = true; clearTimeout(this.retry); this.retry = undefined; this.socket?.destroy(); }
}
