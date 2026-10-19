import { createHash, randomUUID } from 'node:crypto';
import { operationFailure } from '../operations';
import type { SpeedMode, ToWebview } from '../shared';
import { parseCommand, type Command } from './command';
import type { RemoteReply } from './bridgeClient';
import type { RemoteSession, RemoteSessionHost } from './host';
import { transcriptSnapshot, transcriptText, transcriptPage } from './transcript';
import { SessionTaskQueue } from './taskQueue';
import { checkedItem, RemoteImageReader, decodeImage, sourceUserIndex } from './timeline';
import { remoteImages } from './images';
import { CURRENT_CAPABILITIES } from './contract';

interface RemoteState {
    taskQueue?: SessionTaskQueue;
    remoteNotify?: {deviceId: string; commandId: string};
    remoteStream?: {id: string; seq: number; text: string; thinking: string; active: boolean};
    remoteAction?: boolean;
    remoteRead?: Promise<void>;
    remoteReadAt?: number;
    remoteRequestSignature?: string;
    remoteRequestVersion?: number;
    remoteContext?: {used: number; total: number};
    remoteStatus?: {text: string; error: boolean};
    remoteMode?: string;
    remoteLimit?: Extract<ToWebview, {kind: 'rate_limit'}>;
}

/** v1 兼容接入：命令、手机排队、流与图片状态都不进入电脑聊天上下文。 */
export class RemoteSessionAdapter<C extends RemoteSession> {
    private readonly states = new WeakMap<C, RemoteState>();
    private readonly timers = new Map<C, ReturnType<typeof setTimeout>>();
    private remoteImageReader?: RemoteImageReader;
    private disabled = false;
    private lastFailureAt = 0;
    constructor(private readonly host: RemoteSessionHost<C>) {}
    private state(ctx: C): RemoteState {
        let state = this.states.get(ctx);
        if (!state) { state = {}; this.states.set(ctx, state); }
        return state;
    }
    private failure(error: unknown): void {
        if (Date.now() - this.lastFailureAt < 30000) return;
        this.lastFailureAt = Date.now();
        operationFailure('remote.adapter', error);
    }
    private publish(id: string, event: Record<string, unknown>): void {
        if (this.disabled) return;
        try { this.host.publish(id, event); } catch (error) { this.failure(error); }
    }
    observe(ctx: C, e: ToWebview): void {
        if (this.disabled) return;
        try {
            if(e.kind==='session'&&e.permissionMode)this.state(ctx).remoteMode=e.permissionMode;
            if(e.kind==='rate_limit')this.state(ctx).remoteLimit=e;
            if(e.kind==='rate_limit_cleared')this.state(ctx).remoteLimit=undefined;
            if(e.kind==='context')this.state(ctx).remoteContext={used:e.used,total:e.total};
            if(e.kind==='status'||e.kind==='activity')this.state(ctx).remoteStatus={text:e.label.slice(0,240),error:false};
            if(e.kind==='error')this.state(ctx).remoteStatus={text:e.message.slice(0,500),error:true};
            if(e.kind==='busy'&&e.busy)this.state(ctx).remoteStatus=undefined;
            if(e.kind==='result'&&!e.isError)this.state(ctx).remoteStatus=undefined;

            this.remoteEvent(ctx, e);
            if (e.kind === 'result' || e.kind === 'rate_limit_cleared') this.schedule(ctx);
        } catch (error) { this.failure(error); }
    }
    private schedule(ctx: C): void {
        if (this.disabled || !this.hasPending(ctx) || this.timers.has(ctx)) return;
        const timer = setTimeout(() => {
            this.timers.delete(ctx);
            void this.drainTasks(ctx).catch(error => this.failure(error));
        }, 0);
        this.timers.set(ctx, timer);
    }
    hasPending(ctx: C): boolean { return !!this.states.get(ctx)?.taskQueue?.items.length; }
    localSend(ctx: C): void {
        if (!ctx.proc?.isBusy && !ctx.sending) {
            const state = this.states.get(ctx);
            if (state) state.remoteNotify = undefined;
        }
    }
    closed(ctx: C): void {
        try {
            const state = this.states.get(ctx);
            if (state?.remoteNotify) this.remoteEvent(ctx, {kind: 'result', isError: true});
            if (state?.taskQueue?.items.length) { state.taskQueue.paused = true; this.postQueue(ctx); }
        } catch (error) { this.failure(error); }
    }
    setEnabled(enabled: boolean): void {
        this.disabled = !enabled;
        if (!enabled) { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
    }
    dispose(): void { this.setEnabled(false); }
    private queue(ctx:C):SessionTaskQueue { return this.state(ctx).taskQueue??=new SessionTaskQueue(); }
    private postQueue(ctx:C):void {
        this.queue(ctx);
        if(ctx.sessionId)this.publish(ctx.sessionId,{kind:'invalidate'});
    }
    async drainTasks(ctx:C):Promise<void> {
        const remote = this.state(ctx);
        const queue=this.queue(ctx);
        const available=()=>!this.disabled&&!this.host.disposed&&this.host.contexts().includes(ctx)&&!ctx.proc?.isBusy&&!ctx.sending&&!ctx.pendingPerm&&!remote.remoteAction&&!ctx.compacting&&!ctx.compactionPreparing&&!this.host.isRestoring(ctx)&&!this.host.isForking(ctx)
            &&!(remote.remoteLimit?.level==='exhausted'&&!remote.remoteLimit.modelScoped&&(!remote.remoteLimit.resetsAt||remote.remoteLimit.resetsAt>Date.now()/1000));
        await queue.drain(available,async item=>{
            remote.remoteNotify=item.deviceId?{deviceId:item.deviceId,commandId:item.commandId!}:undefined;
            const accepted=await this.host.handleSend(ctx,item.text,item.context,item.images.length?item.images:undefined,item.files.length?item.files:undefined,
                ()=>this.host.contexts().includes(ctx) && !this.disabled && !this.host.disposed,Date.now()-item.createdAt);
            if(!accepted)remote.remoteNotify=undefined;return accepted;
        });this.postQueue(ctx);
    }
    private remoteEvent(ctx:C,event:ToWebview):void {
        const remote = this.state(ctx);
        if(!ctx.sessionId)return;
        if(event.kind==='busy'&&event.busy)remote.remoteStream={id:randomUUID(),seq:0,text:'',thinking:'',active:true};
        if(event.kind==='text_delta'||event.kind==='thinking_delta') {
            const stream=remote.remoteStream??={id:randomUUID(),seq:0,text:'',thinking:'',active:true};
            const field=event.kind==='text_delta'?'text':'thinking';stream[field]=(stream[field]+event.text).slice(-4000);
            for(const text of event.text.match(/[\s\S]{1,600}/gu)??[]){stream.seq++;this.publish(ctx.sessionId,{kind:'delta',id:stream.id,seq:stream.seq,field,text});}
        } else if(['result','tool_input','tool_result','permission_request','permission_resolved','compacted','busy'].includes(event.kind)) {
            if(event.kind==='result'){remote.remoteReadAt=0;if(remote.remoteStream)remote.remoteStream.active=false;}
            this.publish(ctx.sessionId,{kind:'invalidate'});
        }
        if(event.kind==='result'&&remote.remoteNotify){
            const origin=remote.remoteNotify;remote.remoteNotify=undefined;
            this.publish(ctx.sessionId,{kind:'completed',...origin,title:this.remoteTitle(ctx),error:event.isError});
        }
    }
    private remoteTitle(ctx: C): string {
        return (this.host.store.list().find(s => s.id === ctx.sessionId)?.title || ctx.lastUserText || '新会话').replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    private remoteRequest(ctx: C) {
        const remote = this.state(ctx);
        const pending=ctx.pendingPerm?.kind==='permission_request'?ctx.pendingPerm:undefined;
        const signature=pending?createHash('sha256').update(JSON.stringify(pending)).digest('hex'):'';
        if(signature!==remote.remoteRequestSignature){remote.remoteRequestSignature=signature;remote.remoteRequestVersion=(remote.remoteRequestVersion??0)+1;}
        return pending?{requestId:pending.requestId,requestVersion:remote.remoteRequestVersion??1,
            turnId:ctx.proc?.currentTurnId??null,question:pending.toolName==='AskUserQuestion',
            title:pending.toolName==='AskUserQuestion'?'有问题需要回答':(pending.displayName||pending.toolName).slice(0,100)}:null;
    }
    /** 手机只能操作本窗口已打开或转入后台的原会话；不接收 Webview 任意指令。 */
    async execute(input: Command, connected: () => boolean): Promise<RemoteReply> {
        const command = parseCommand(input, Date.now()), registration = this.host.registration();
        const denied = (error: string): RemoteReply => ({ accepted: false, error });
        const active = () => !this.disabled && connected() && !this.host.disposed && command.expiresAt > Date.now() &&
            this.host.registration()?.workspaceId === registration?.workspaceId;
        if (!registration || !active() || command.target?.windowId !== registration.windowId || command.target.workspaceId !== registration.workspaceId)
            return denied('TARGET_OFFLINE');
        const contexts = () => this.host.contexts();
        const op = command.operation;
        if (op.kind === 'session.list') {
            const all = contexts().filter(c => c.sessionId);
            return { accepted: true, result: { kind: 'session.list', total: all.length,
                sessions: all.sort((a,b)=>Number(this.host.pinnedSet().has(b.sessionId!))-Number(this.host.pinnedSet().has(a.sessionId!))).slice(0, 20).map(c => ({ id: c.sessionId, title: this.remoteTitle(c), pinned:this.host.pinnedSet().has(c.sessionId!),
                    busy: !!c.proc?.isBusy || !!c.sending, waiting: c.pendingPerm?.kind === 'permission_request' })) } };
        }
        let ctx = contexts().find(c => c.sessionId === command.target!.sessionId);
        if (op.kind === 'session.create') {
            ctx = await this.host.openSession();
            if (!active()) return denied('COMMAND_EXPIRED');
        }
        if (!ctx || !ctx.sessionId && op.kind !== 'session.create') return denied('SESSION_NOT_OPEN');
        const remote = this.state(ctx);
        const selected = ctx, sourceId = ctx.sessionId, checkpoints = ctx.checkpoints;
        const selectedActive = () => active() && contexts().includes(selected) && selected.checkpoints === checkpoints &&
            (selected.sessionId === sourceId || op.kind === 'session.create');
        // 此标记随会话持久保存；以后即便桥接断线，也不能把该会话正文回退到飞书等 Webhook。
        await this.host.markPrivate(ctx);
        if (!selectedActive()) return denied('TARGET_CHANGED');
        const idle=()=>!ctx!.proc?.isBusy&&!ctx!.sending&&!ctx!.pendingPerm&&!remote.remoteAction&&!this.host.isRestoring(ctx!)&&!this.host.isForking(ctx!)&&!ctx!.compactionPreparing;
        if(op.kind==='session.rename') {
            if(!await this.host.store.setCustomTitle(sourceId!,op.title.trim()))return denied('SESSION_NOT_OPEN');
            this.host.refreshSessions();return {accepted:true,result:{kind:op.kind,title:op.title.trim()}};
        }
        if(op.kind==='session.pin'){await this.host.setPinned(sourceId!,op.pinned);return {accepted:true,result:{kind:op.kind,pinned:op.pinned}};}
        if(op.kind==='session.delete'){
            if(remote.remoteAction||ctx.sending||remote.taskQueue?.sending||this.host.isRestoring(ctx)||this.host.isForking(ctx))return denied('SESSION_BUSY');
            if(remote.taskQueue){remote.taskQueue.paused=true;remote.taskQueue.items.length=0;}
            await this.host.deleteSessions([sourceId!],true);
            return this.host.store.list().some(s=>s.id===sourceId)?denied('SESSION_DELETE_FAILED'):{accepted:true,result:{kind:op.kind,sessionId:sourceId}};
        }
        if(op.kind==='session.compact'){
            if(!idle())return denied('SESSION_BUSY');
            remote.remoteNotify={deviceId:command.deviceId,commandId:command.commandId};
            await this.host.compactSession(ctx);
            if(!ctx.proc?.isBusy){remote.remoteNotify=undefined;return denied('COMPACTION_NOT_STARTED');}
            return {accepted:true,result:{kind:op.kind}};
        }
        if(op.kind==='queue.remove'){
            try{this.queue(ctx).remove(op.id);}catch(error){return denied((error as Error).message);}
            this.postQueue(ctx);return {accepted:true,result:{kind:op.kind}};
        }
        if(op.kind==='queue.resume'){this.queue(ctx).paused=false;this.schedule(ctx);return {accepted:true,result:{kind:op.kind}};}
        if(op.kind==='message.enqueue'){
            try {
                const images=remoteImages(command,op.attachmentIds);
                this.queue(ctx).add({text:op.text,images,files:[],contexts:[],labels:[],imageUris:[],deviceId:command.deviceId,commandId:command.commandId});
                this.postQueue(ctx);this.schedule(ctx);return {accepted:true,result:{kind:op.kind,queued:true}};
            }catch(error){return denied((error as Error).message==='QUEUE_FULL'?'QUEUE_FULL':'IMAGE_NOT_AVAILABLE');}
        }
        if(['message.read','message.edit','message.regenerate','session.image'].includes(op.kind)) {
            if(op.kind!=='message.read'&&op.kind!=='message.edit'&&op.kind!=='message.regenerate'&&op.kind!=='session.image')return denied('INVALID_COMMAND');
            if(op.kind!=='session.image'||op.offset===0)await this.host.store.hydrate(sourceId!);if(!selectedActive())return denied('TARGET_CHANGED');
            const items=this.host.store.load(sourceId!);let item;
            try{item=checkedItem(items,op.item,op.revision);}catch{return denied('MESSAGE_CHANGED');}
            if(op.kind==='session.image'){
                try{return {accepted:true,result:{...await (this.remoteImageReader??=new RemoteImageReader()).read(item,op.index,op.offset,this.host.cwd()),item:op.item,index:op.index,revision:op.revision}};}catch(error){return denied(['IMAGE_TOO_LARGE','INVALID_OFFSET'].includes((error as Error).message)?(error as Error).message:'IMAGE_NOT_AVAILABLE');}
            }
            const index=sourceUserIndex(items,op.item),user=items[index];if(user.type!=='user')return denied('MESSAGE_NOT_EDITABLE');
            const point=this.host.checkpointsForView(ctx,sourceId!)[items.slice(0,index).filter(i=>i.type==='user').length];
            if(!point)return denied('MESSAGE_NOT_EDITABLE');
            if(op.kind==='message.read'){
                const offset=op.offset??0,end=Math.min(user.text.length,offset+700);
                return {accepted:true,result:{kind:op.kind,item:op.item,revision:op.revision,text:user.text.slice(offset,end),offset,next:end,total:user.text.length,
                    imageCount:user.images?.length??0,synthetic:!!point.synthetic}};
            }
            if(remote.remoteAction||ctx.sending||ctx.answeringQuestion||this.host.isRestoring(ctx)||this.host.isForking(ctx))return denied('SESSION_BUSY');
            let images;try{images=(user.images??[]).map(decodeImage);}catch{return denied('IMAGE_NOT_AVAILABLE');}
            remote.remoteAction=true;remote.remoteNotify=undefined;this.queue(ctx).paused=true;this.postQueue(ctx);this.host.setRestoring(ctx, true);
            try {
                if(!selectedActive())return denied('TARGET_CHANGED');
                if(!await this.host.editMessageRewind(ctx,point.id))return denied('RESTORE_FAILED');
                this.host.post(ctx,{kind:'restored'});
                await this.host.reloadSession(ctx);
                remote.remoteNotify={deviceId:command.deviceId,commandId:command.commandId};
                const text=op.kind==='message.edit'?op.text:user.text;
                const accepted=await this.host.handleSend(ctx,text,user.context,images.length?images:undefined,user.files,()=>active()&&contexts().includes(selected));
                if(!accepted)remote.remoteNotify=undefined;
                return {accepted:true,result:{kind:op.kind,sessionId:ctx.sessionId,title:this.remoteTitle(ctx),sent:accepted}};
            }finally{remote.remoteAction=false;this.host.setRestoring(ctx, false);}
        }
        if(op.kind==='session.controls') {
            const page=op.page??0;
            if(op.section==='queue')return {accepted:true,result:{kind:'session.controls',section:'queue',...this.queue(ctx).summary(page)}};
            if(op.section==='tool'){
                const item=this.host.store.load(sourceId!)[op.item!];if(!item||item.type!=='tool')return denied('TOOL_NOT_AVAILABLE');
                return {accepted:true,result:transcriptPage(transcriptText([item]),{kind:'session.controls',section:'tool',item:op.item,name:(item.displayName||item.name).slice(0,100)},op,4500)};
            }
            if(op.section==='settings'){
                const selected=this.host.modelCatalog.find(m=>m.id===this.host.sessionModel(ctx))??this.host.modelCatalog.find(m=>m.isDefault);
                return {accepted:true,result:{kind:'session.controls',section:op.section,page,total:this.host.modelCatalog.length,
                    models:this.host.modelCatalog.slice(page*6,page*6+6).map(m=>({id:m.id,name:m.name.slice(0,100),efforts:m.efforts,speedModes:m.speedModes})),
                    efforts:selected?.efforts.length?selected.efforts:['none','minimal','low','medium','high','xhigh','max','ultra'],
                    speeds:selected?.speedModes?.filter(s=>s!=='ultrafast')??['default']}};
            }
            if(op.section==='changes'){
                const changes=await this.host.getChangedFiles(ctx);if(!selectedActive())return denied('TARGET_CHANGED');
                return {accepted:true,result:{kind:'session.controls',section:op.section,page,total:changes.files.length,
                    added:changes.totalAdded,removed:changes.totalRemoved,
                    files:changes.files.slice(page*5,page*5+5).map(f=>({name:f.rel.length<=240?f.rel:f.rel.slice(0,80)+'…'+f.rel.slice(-159),added:f.added,removed:f.removed,status:f.status}))}};
            }
            const request=this.remoteRequest(ctx),pending=ctx.pendingPerm;
            if(!request || pending?.kind!=='permission_request')return denied('REQUEST_ALREADY_RESOLVED');
            const details={kind:'session.controls',section:op.section,request,input:pending.input,description:pending.description};
            // 批准必须建立在完整展示上，超大输入不静默裁掉关键命令或问题。
            return {accepted:true,result:Buffer.byteLength(JSON.stringify(details))<=6000?details:{kind:'session.controls',section:op.section,request,unsupported:true}};
        }
        if(op.kind==='session.configure'){
            if(ctx.sending||ctx.proc?.isBusy||ctx.pendingPerm||ctx.compactionPreparing||this.host.isRestoring(ctx)||this.host.isForking(ctx))return denied('SESSION_BUSY');
            const selected=this.host.modelCatalog.find(m=>m.id===this.host.sessionModel(ctx))??this.host.modelCatalog.find(m=>m.isDefault);
            if(op.key==='model'){
                if(op.value&&!this.host.modelCatalog.some(m=>m.id===op.value))return denied('SETTING_NOT_SUPPORTED');
                await this.host.setModel(ctx,op.value,selectedActive);
            }else if(op.key==='effort'){
                if(op.value&&!(selected?.efforts.length?selected.efforts:['none','minimal','low','medium','high','xhigh','max','ultra']).includes(op.value))return denied('SETTING_NOT_SUPPORTED');
                await this.host.setEffort(ctx,op.value,selectedActive);
            }else{
                if(op.value!=='default'&&!(op.value==='fast'&&selected?.speedModes?.includes('fast')))return denied('SETTING_NOT_SUPPORTED');
                await this.host.setSpeedMode(ctx,op.value as SpeedMode,selectedActive);
            }
            const actual=op.key==='model'?this.host.sessionModel(ctx):op.key==='effort'?this.host.sessionEffort(ctx):this.host.speedMode(ctx);
            return actual===op.value?{accepted:true,result:{kind:'session.configured',key:op.key,value:actual}}:denied('SETTING_NOT_SAVED');
        }
        if(op.kind==='permission.resolve'||op.kind==='question.answer'){
            const request=this.remoteRequest(ctx),pending=ctx.pendingPerm;
            if(!request||pending?.kind!=='permission_request'||request.requestId!==op.requestId||request.requestVersion!==op.requestVersion)return denied('REQUEST_ALREADY_RESOLVED');
            if(request.turnId!==op.turnId)return denied('TURN_CHANGED');
            if(Buffer.byteLength(JSON.stringify({input:pending.input,description:pending.description,request}))>5800)return denied('REQUEST_TOO_LARGE');
            if(op.kind==='permission.resolve'){
                if(request.question)return denied('QUESTION_REQUIRES_ANSWER');
                if(!this.host.handlePermission(ctx,op.requestId,op.decision==='allow'?'allow':'deny'))return denied('REQUEST_ALREADY_RESOLVED');
            }else{
                if(!request.question||ctx.answeringQuestion)return denied('REQUEST_ALREADY_RESOLVED');
                const questions=(pending.input as {questions?:{id?:string;question?:string;isSecret?:boolean}[]}).questions;
                if(!Array.isArray(questions)||!questions.length||questions.length>20)return denied('INVALID_ANSWERS');
                const answers:Record<string,string|string[]>={};
                for(const [i,q] of questions.entries()){
                    const value=op.answers[String(i)];if(value===undefined||(Array.isArray(value)?!value.length||value.some(v=>!v.trim()):!value.trim()))return denied('INVALID_ANSWERS');
                    answers[q.id||q.question||String(i)]=value;
                }
                ctx.answeringQuestion=true;
                try{await this.host.submitQuestionAnswer(ctx,op.requestId,answers,selectedActive);}finally{ctx.answeringQuestion=false;}
            }
            return {accepted:true,result:{kind:'request.resolved',requestId:op.requestId}};
        }
        if (op.kind === 'session.snapshot') {
            if (!remote.remoteRead && Date.now() - (remote.remoteReadAt ?? 0) >= 4000) {
                remote.remoteRead = this.host.store.hydrate(sourceId!).then(() => { this.state(selected).remoteReadAt = Date.now(); }).finally(() => { this.state(selected).remoteRead = undefined; });
            }
            await remote.remoteRead;
            if (!selectedActive()) return denied('TARGET_CHANGED');
            const items = this.host.store.load(sourceId!);
            this.host.fetchUsage();
            const usage = this.host.lastUsage?.kind === 'usage' ? this.host.lastUsage : undefined;
            const state = { kind: 'session.snapshot', sessionId: sourceId, title: this.remoteTitle(ctx), busy: !!ctx.proc?.isBusy || !!ctx.sending,
                turnId: ctx.proc?.currentTurnId ?? null, waiting: ctx.pendingPerm?.kind === 'permission_request',
                model: this.host.sessionModel(ctx).slice(0, 120), effort: this.host.sessionEffort(ctx).slice(0, 40),
                speed: this.host.speedMode(ctx), capabilities:CURRENT_CAPABILITIES, queueCount:remote.taskQueue?.items.length??0,queuePaused:remote.taskQueue?.paused??false,pinned:this.host.pinnedSet().has(sourceId!),stream:remote.remoteStream?{...remote.remoteStream,text:remote.remoteStream.text.slice(-600),thinking:remote.remoteStream.thinking.slice(-200),truncated:remote.remoteStream.text.length>600||remote.remoteStream.thinking.length>200}:null, request:this.remoteRequest(ctx), context:remote.remoteContext??null, limit:remote.remoteLimit??null, progress:remote.remoteStatus??null,
                permissionMode:remote.remoteMode??null, usage: usage ? { sessionPct: usage.sessionPct, sessionResetAt: usage.sessionResetAt,
                    weekPct: usage.weekPct, weekResetAt: usage.weekResetAt, planType: usage.planType, updatedAt: this.host.lastUsageUpdatedAt } : null };
            return { accepted: true, result: transcriptSnapshot(items, state, op) };
        }
        if (op.kind === 'message.send' || op.kind === 'session.create') {
            let images: {mediaType:string;data:string}[];
            try { images=remoteImages(command,op.attachmentIds??[]); } catch { return denied('IMAGE_NOT_AVAILABLE'); }
            if (ctx.sending || ctx.proc?.isBusy || ctx.pendingPerm?.kind === 'permission_request' ||
                this.host.isForking(ctx) || this.host.isRestoring(ctx) || ctx.answeringQuestion || ctx.compactionPreparing) return denied('SESSION_BUSY');
            if(remote.remoteAction)return denied('SESSION_BUSY');
            remote.remoteNotify={deviceId:command.deviceId,commandId:command.commandId};
            const accepted = await this.host.handleSend(ctx, op.text, undefined, images.length?images:undefined, undefined, selectedActive);
            if (!accepted){remote.remoteNotify=undefined;return denied('MESSAGE_NOT_SENT');}
            return { accepted: true, result: { kind: 'message.accepted', sessionId: ctx.sessionId, title: this.remoteTitle(ctx), delivery: 'handed_to_original_session' } };
        }
        if (op.kind === 'turn.stop') {
            if (!ctx.proc?.isBusy || ctx.proc.currentTurnId !== op.turnId) return denied('TURN_CHANGED');
            await this.host.stopContext(ctx);
            return { accepted: true, result: { kind: 'turn.stop', sessionId: sourceId, stopping: !!ctx.proc?.isBusy } };
        }
        return denied('OPERATION_NOT_READY');
    }
}
