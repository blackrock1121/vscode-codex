import { createHash } from 'node:crypto';
import { readImageFile } from '../imageFile';
import * as path from 'node:path';
import type { TimelineItem } from '../shared';

/** 消息索引只在内容指纹匹配时有效，防止分页或还原后编辑了另一条消息。 */
export function itemRevision(item: TimelineItem): string {
    return createHash('sha256').update(JSON.stringify(item)).digest('hex');
}
export function checkedItem(items: TimelineItem[], index: number, revision: string): TimelineItem {
    const item = items[index];
    if (!item || itemRevision(item) !== revision) throw new Error('MESSAGE_CHANGED');
    return item;
}
export function imageSources(item: TimelineItem): string[] {
    if(item.type==='image')return [item.src];if(item.type==='user')return item.images??[];
    const found:string[]=[];
    const inline=(value:string)=>{if(/^data:image\/(png|jpeg|webp|gif);base64,/.test(value))found.push(value);};
    const markdown=(value:string)=>{for(const match of value.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)){const ref=match[1]||match[2];if(ref&&!/^https?:/i.test(ref))found.push(ref);}};
    if(item.type==='assistant_text')markdown(item.text);
    if(item.type==='tool'){
        if(item.name==='imageGeneration'&&typeof item.input?.savedPath==='string')found.push(item.input.savedPath);
        if(item.name==='imageView'&&typeof item.input?.path==='string')found.push(item.input.path);
        let visited=0;
        const walk=(value:any,depth=0):void=>{
            if(depth>8||visited++>200||found.length>=8)return;
            if(typeof value==='string'){inline(value);if(value.length<20000)markdown(value);return;}
            if(!value||typeof value!=='object')return;
            if(Array.isArray(value)){for(const v of value)walk(v,depth+1);return;}
            if(value.type==='image'&&typeof value.data==='string'&&typeof value.mimeType==='string')inline(`data:${value.mimeType};base64,${value.data}`);
            for(const key of ['content','contentItems','structuredContent','result','image_url','url','text'])if(key in value)walk(value[key],depth+1);
        };
        if(item.result)try{const value=JSON.parse(item.result);walk(value);
            if(item.name==='imageGeneration'&&!found.length){const raw=typeof value==='string'?value:value?.result;if(typeof raw==='string'&&/^[A-Za-z0-9+/=\r\n]+$/.test(raw)){const mime=raw.startsWith('/9j/')?'jpeg':raw.startsWith('UklGR')?'webp':'png';inline(`data:image/${mime};base64,${raw}`);}}
        }catch{walk(item.result);}
    }
    return [...new Set(found)].slice(0,8);
}
export function decodeImage(src: string): { mediaType: string; data: string } {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(src);
    if (!match || match[2].length > 28_000_000) throw new Error('IMAGE_NOT_AVAILABLE');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 20_971_520) throw new Error('IMAGE_TOO_LARGE');
    const magic = bytes.subarray(0, 12);
    const valid = match[1] === 'image/png' ? magic.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        : match[1] === 'image/jpeg' ? magic[0] === 255 && magic[1] === 216
        : match[1] === 'image/gif' ? /^GIF8[79]a/.test(magic.toString('ascii'))
        : magic.subarray(0, 4).toString() === 'RIFF' && magic.subarray(8, 12).toString() === 'WEBP';
    if (!valid) throw new Error('IMAGE_NOT_AVAILABLE');
    return { mediaType: match[1], data: bytes.toString('base64') };
}
export function imageChunk(item: TimelineItem, index: number, offset: number) {
    const image = decodeImage(imageSources(item)[index] ?? '');
    const bytes = Buffer.from(image.data, 'base64');
    if (offset > bytes.length) throw new Error('INVALID_OFFSET');
    const end = Math.min(bytes.length, offset + 3072);
    return { kind: 'session.image', mime: image.mediaType, offset, next: end, total: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.subarray(offset, end).toString('base64') };
}
export function sourceUserIndex(items: TimelineItem[], index: number): number {
    for (let i = index; i >= 0; i--) if (items[i].type === 'user') return i;
    throw new Error('MESSAGE_NOT_EDITABLE');
}

/** 只读取权威聊天记录已经引用的图片；手机只传索引，不能指定文件路径。 */
export class RemoteImageReader {
    private readonly cache=new Map<string,{bytes:Buffer;mime:string;hash:string;at:number}>();
    async read(item:TimelineItem,index:number,offset:number,cwd:string){
        const key=itemRevision(item)+':'+index;let value=this.cache.get(key);
        if(value&&Date.now()-value.at>60000){this.cache.delete(key);value=undefined;}
        if(!value){
            let source=imageSources(item)[index];if(!source)throw new Error('IMAGE_NOT_AVAILABLE');
            if(!source.startsWith('data:')){
                if(source.startsWith('file:')){try{source=decodeURIComponent(new URL(source).pathname);}catch{throw new Error('IMAGE_NOT_AVAILABLE');}}
                if(/^[a-z][a-z\d+.-]*:/i.test(source)||source.includes('\0'))throw new Error('IMAGE_NOT_AVAILABLE');
                const file=path.resolve(cwd,source),mime:Record<string,string>={'.png':'png','.jpg':'jpeg','.jpeg':'jpeg','.gif':'gif','.webp':'webp'};
                const type=mime[path.extname(file).toLowerCase()];if(!type)throw new Error('IMAGE_NOT_AVAILABLE');
                try { source=`data:image/${type};base64,${(await readImageFile(file,20971520)).toString('base64')}`; }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'EFBIG') throw new Error('IMAGE_TOO_LARGE'); throw error; }
            }
            const decoded=decodeImage(source),bytes=Buffer.from(decoded.data,'base64');value={bytes,mime:decoded.mediaType,hash:createHash('sha256').update(bytes).digest('hex'),at:Date.now()};
            while(this.cache.size>=2)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,value);
        }
        value.at=Date.now();if(offset>value.bytes.length)throw new Error('INVALID_OFFSET');const end=Math.min(value.bytes.length,offset+3072);
        return {kind:'session.image',mime:value.mime,offset,next:end,total:value.bytes.length,sha256:value.hash,data:value.bytes.subarray(offset,end).toString('base64')};
    }
}
