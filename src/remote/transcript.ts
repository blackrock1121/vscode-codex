import { itemRevision, imageSources } from './timeline';
import { createHash } from 'node:crypto';
import type { TimelineItem } from '../shared';

/** 仅传展示文本，不传 data URI、完整 Webview 消息或执行能力。长回复按页读取，不静默截断。 */
export function transcriptText(items: TimelineItem[]): string {
    return items.map(item => {
        switch (item.type) {
            case 'user': return `你\n${item.text}${item.images?.length ? `\n[图片 × ${item.images.length}]` : ''}`;
            case 'assistant_text': return `Codex\n${item.text}`;
            case 'thinking': return item.text.trim()?`思考\n${item.text}`:'';
            case 'tool': return `工具 · ${item.displayName || item.name}${item.isError ? ' · 失败' : ''}\n${JSON.stringify(item.input ?? {})}\n${item.result ?? ''}`;
            case 'image': return '[生成的图片]';
            case 'compaction': return '（上下文已压缩）';
            case 'checkpoint': return '';
        }
    }).filter(Boolean).join('\n\n');
}
export function transcriptPage(text: string, state: Record<string, unknown>, query: { end?: number; revision?: string }, maxBytes=5000) {
    const revision = createHash('sha256').update(text).update(JSON.stringify(state)).digest('hex');
    if (query.end === undefined && query.revision === revision) return { ...state, revision, unchanged: true };
    const reset = query.end !== undefined && query.revision !== revision;
    let end = query.end !== undefined && !reset ? Math.min(query.end, text.length) : text.length;
    // 游标是 UTF-16 偏移；边界不能切开 emoji 等代理对。
    if (end > 0 && end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    let start = Math.max(0, end - 1600);
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
    while (Buffer.byteLength(JSON.stringify(text.slice(start, end))) > maxBytes && start < end) {
        start++; if (/[\uDC00-\uDFFF]/.test(text[start] ?? '')) start++;
    }
    return { ...state, revision, text: text.slice(start, end), start, end, total: text.length, reset, unchanged: false };
}

/** 分角色展示信息与旧文本共用同一页游标，避免用户正文中的角色名称被误解析。 */
export function transcriptSnapshot(items: TimelineItem[],state:Record<string,unknown>,query:{end?:number;revision?:string}) {
    const blocks=items.map((item,index)=>{
        const tool=item.type==='tool',plan=tool&&item.name==='TodoWrite';
        let text=transcriptText([item]);
        if(plan){const todos=item.input?.todos;text=Array.isArray(todos)?todos.map((t:any)=>(t.status==='completed'?'✓ ':t.status==='in_progress'?'◉ ':'○ ')+String(t.content??t.activeForm??'')).join('\n'):text;}
        else if(tool){const input=item.input??{};const key=['command','cmd','query','pattern','file_path','path'].find(k=>typeof input[k]==='string');
            text=(key?String(input[key]).replace(/\s+/g,' ').slice(0,160):item.displayName||item.name)+(item.isError?' · 失败':'');}
        return {role:plan?'plan':item.type==='user'?'user':item.type==='thinking'?'thinking':tool?'tool':'assistant',
            text,id:String(index),...('sourceId' in item&&item.sourceId?{sourceId:item.sourceId}:{}),messageRevision:itemRevision(item),imageCount:imageSources(item).length,actionable:!state.busy&&!state.waiting&&(item.type==='user'||item.type==='assistant_text'),...(tool?{toolName:(item.displayName||item.name).slice(0,80),detail:true,
                status:item.isError?'failed':item.permission==='pending'?'waiting':item.result!==undefined?'completed':'running'}:{})};
    }).filter(b=>b.text);
    const text=blocks.map(b=>b.text).join('\n\n');
    const snapshotState={...state,timelineRevision:createHash('sha256').update(JSON.stringify(blocks.map(b=>[b.id,b.toolName,b.status]))).digest('hex')};
    // 文字、消息元数据与旧版兼容正文都算入 IPC 预算；大量短工具不能撑破 7000 B 帧。
    let budget=2300;
    for (;;) {
        const page=transcriptPage(text,snapshotState,query,budget);
        if(page.unchanged)return page;
        const visible=page as typeof page & {start:number;end:number};let offset=0;
        const messages: {role:string;text:string;continued:boolean;id:string;toolName?:string;status?:string;detail?:boolean;messageRevision:string;imageCount:number;actionable:boolean}[]=[];
        for(const block of blocks) {
            const end=offset+block.text.length,from=Math.max(offset,visible.start),to=Math.min(end,visible.end);
            if(to>from){let body=block.text.slice(from-offset,to-offset);const prefix=block.role==='user'?'你\n':block.role==='thinking'?'思考\n':block.role==='assistant'?'Codex\n':'';
                if(from===offset&&prefix&&body.startsWith(prefix))body=body.slice(prefix.length);
                if(body.trim())messages.push({role:block.role,text:body,continued:from>offset,id:block.id,...(block.sourceId?{sourceId:block.sourceId}:{}),messageRevision:block.messageRevision,imageCount:block.imageCount,actionable:block.actionable,
                    ...(block.toolName?{toolName:block.toolName,status:block.status,detail:block.detail}:{})});}
            offset=end+2;
        }
        const result={...page,messages};
        if(Buffer.byteLength(JSON.stringify(result))<=6500 || budget<=64)return result;
        budget=Math.max(64,Math.floor(budget*0.7));
    }
}
