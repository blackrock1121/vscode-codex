import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import type { Command } from './command';

/** 只读取 Mac 桥接写入的完整、短期图片；ID 不可解释为任意文件路径。 */
export function remoteImages(command: Command, ids: string[], directory=path.join(os.homedir(),'.codex-chat','remote-bridge','images')): {mediaType:string;data:string}[] {
    if(ids.length>4 || new Set(ids).size!==ids.length)throw new Error('INVALID_REMOTE_IMAGE');
    if(!ids.length)return [];
    const dir=fs.lstatSync(directory);
    if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid?.()||(dir.mode&0o077))throw new Error('UNSAFE_REMOTE_IMAGE');
    let total=0;
    const read=(file:string,max:number)=>{
        const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)||stat.size>max)throw new Error('UNSAFE_REMOTE_IMAGE');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
    };
    return ids.map(id=>{
        if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!/^[A-Za-z0-9_-]{1,128}$/.test(command.deviceId))throw new Error('INVALID_REMOTE_IMAGE');
        const base=path.join(directory,command.deviceId+'_'+id),meta=JSON.parse(read(base+'.json',2048).toString('utf8'));
        const t=command.target;
        if(meta.version!==1||meta.deviceId!==command.deviceId||!t||meta.target?.windowId!==t.windowId||meta.target?.workspaceId!==t.workspaceId||meta.target?.sessionId!==t.sessionId
            ||!Number.isSafeInteger(meta.expiresAt)||meta.expiresAt<=Date.now()||!['image/png','image/jpeg','image/webp'].includes(meta.mime))throw new Error('REMOTE_IMAGE_EXPIRED');
        const data=read(base+'.image',1_048_576);total+=data.length;
        if(total>4_194_304||data.length!==meta.size||createHash('sha256').update(data).digest('hex')!==meta.sha256)throw new Error('INVALID_REMOTE_IMAGE');
        return {mediaType:meta.mime,data:data.toString('base64')};
    });
}
