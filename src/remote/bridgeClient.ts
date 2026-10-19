import { observeOperation, expectedFileError, operationFailure, operationLog } from '../operations';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { isReadOperation, parseCommand, type Command } from './command';
import { CURRENT_CAPABILITIES, requiredCapability } from './contract';

export type RemoteReply = { accepted: true; result: unknown } | { accepted: false; error: string };
export interface RemoteRegistration { windowId: string; workspaceId: string; label: string; path?: string; folderCount?: number }

/** 桥接不存在时仅定期检查私有目录；不访问公网，也不自动执行断线前的指令。 */
export class RemoteBridgeClient {
    private socket?: net.Socket;
    private retry?: NodeJS.Timeout;
    private disposed = false;
    private registered = false;
    private eventsEnabled = false;
    private readonly completions = new Map<string,{sessionId:string;event:Record<string,unknown>}>();
    publish(sessionId:string,event:Record<string,unknown>):void {
        try {
            const text=JSON.stringify({kind:'event',sessionId,event})+'\n';
            if(Buffer.byteLength(text)>7000)return;
            if(event.kind==='completed'&&typeof event.commandId==='string'){
                this.completions.set(`${event.deviceId}:${event.commandId}`,{sessionId,event:JSON.parse(text).event});
                if(this.completions.size>500)this.completions.delete(this.completions.keys().next().value!);
            }
            if(!this.registered||!this.eventsEnabled||!this.socket||this.socket.destroyed)return;
            if(this.socket.writableLength>64000){this.socket.destroy();return;}
            this.socket.write(text);
        } catch (error) {
            operationFailure('remote.publish', error);
            this.socket?.destroy();
        }
    }
    private connectedBefore = false;
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
            const operationId = randomUUID();
            operationLog('remote.connection', 'start', { operationId });
            let buffer = Buffer.alloc(0), registered = false, pending = 0;
            const deadline = setTimeout(() => { operationLog('remote.connection', 'timeout', { operationId, phase: 'register' }); socket.destroy(); }, 5000);
            const send = (value: unknown) => {
                const text = JSON.stringify(value) + '\n';
                if (socket.destroyed || socket.writableLength > 64_000 || Buffer.byteLength(text) > 16_000) { socket.destroy(); return; }
                socket.write(text);
            };
            socket.on('connect', () => {
                try { send({ kind: 'register', version: 1, token: config.token, ...this.registration, capabilities: CURRENT_CAPABILITIES }); }
                catch (error) { operationFailure('remote.register', error); socket.destroy(); }
            });
            socket.on('error', error => operationFailure('remote.connection', error, { operationId }));
            socket.on('close', () => {
                clearTimeout(deadline);
                operationLog('remote.connection', this.disposed ? 'cancelled' : 'disconnected', { operationId, registered, pending });
                if (this.socket === socket) { this.socket = undefined; this.registered = false; this.eventsEnabled = false; }
                this.schedule();
            });
            const receive = (frame: any) => {
                if (!registered) {
                    if (frame?.kind !== 'registered' || frame.version !== 1) throw new Error();
                    registered = true;
                    this.registered = true;
                    // 未明确支持事件的旧桥接只收回执，不能被新事件帧断开。
                    this.eventsEnabled = frame.features?.events === true;
                    for (const value of this.completions.values()) this.publish(value.sessionId, value.event);
                    clearTimeout(deadline); operationLog('remote.connection', this.connectedBefore ? 'recovered' : 'ready', { operationId }); this.connectedBefore = true; return;
                }
                if (frame?.kind !== 'execute' || typeof frame.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.id) || pending >= 16) throw new Error();
                let command: Command;
                try { command = parseCommand(frame.command, Date.now()); }
                catch (error) {
                    const kind = frame.command?.operation?.kind;
                    const unsupported = typeof kind === 'string' && !requiredCapability({kind});
                    const code = unsupported ? 'UNSUPPORTED_OPERATION' :
                        (error as {code?: string}).code === 'COMMAND_EXPIRED' ? 'COMMAND_EXPIRED' : 'INVALID_COMMAND';
                    send({kind: 'reply', id: frame.id, reply: {accepted: false, error: code}});
                    return;
                }
                if (command.target?.windowId !== this.registration.windowId || command.target.workspaceId !== this.registration.workspaceId) throw new Error();
                pending++;
                const active = () => !this.disposed && !socket.destroyed && command.expiresAt > Date.now();
                void observeOperation('remote.execute', async () => {
                    const reply = await this.execute(command, active);
                    if (!reply.accepted) operationLog('remote.execute', 'rejected', { reason: /^[A-Z_]{1,64}$/.test(reply.error) ? reply.error : 'UNKNOWN' });
                    return reply;
                }, { connectionId: operationId, commandId: frame.id, kind: command.operation.kind }).catch((error): RemoteReply => {
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
