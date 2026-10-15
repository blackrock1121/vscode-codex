const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const Module=require('node:module');
const {EventEmitter}=require('node:events');
const {JSDOM}=require('jsdom');
let currentPanel;
const vscode={ViewColumn:{Active:-1},Uri:{joinPath:(_base,...parts)=>parts.join('/')},window:{createWebviewPanel(){
 const panel={viewColumn:1,webview:{asWebviewUri:uri=>({toString:()=>uri}),postMessage:m=>panel.messages.push(m),onDidReceiveMessage:fn=>panel.receive=fn},messages:[],
 onDidDispose:fn=>panel.closed=fn,reveal:()=>{},dispose:()=>panel.closed?.()};currentPanel=panel;return panel;
}}};
const original=Module._load;Module._load=function(id,...args){return id==='vscode'?vscode:original.call(this,id,...args);};
const {DiagnosticsPage,diagnosticsHtml}=require('../dist/test/diagnostics/page.js');
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');Module._load=original;
const record={id:'11111111-1111-4111-8111-111111111111',createdAt:Date.now(),updatedAt:Date.now(),ownerPid:process.pid,status:'completed',progress:'诊断完成',
 pluginVersion:'0.1.128',workspaceName:'项目A',workspaceId:'project-a',windowId:'window-a',notification:{status:'sent'},summary:{turns:2,tools:5,failures:2,longestTurnMs:50000,versions:['0.1.127']},
 findings:[{id:'timeout',severity:'warning',title:'工具超时 <img src=x>',evidence:'两次失败',recommendation:'按证据修复',traceIds:['turn-a']}]};
function setup(t){
 const html=diagnosticsHtml('test-nonce','https://example.invalid/diagnostics.js'),sent=[],errors=[];
 const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.addEventListener('error',e=>errors.push(e.message));w.eval(fs.readFileSync('media/diagnostics.js','utf8'));
 const emit=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 return {w,sent,errors,emit};
}

test('诊断页面展示历史、通知状态与证据，点击修复发送对应记录 ID',t=>{
 const {w,sent,errors,emit}=setup(t);emit({type:'state',records:[record],selectedId:record.id,workspaceId:'project-a'});
 assert.match(w.document.getElementById('records').textContent,/11111111/);assert.match(w.document.getElementById('detail').textContent,/飞书通知：已发送/);
 assert.equal(w.document.querySelector('#detail img'),null);
 const repair=[...w.document.querySelectorAll('#detail button')].find(e=>e.textContent==='创建修复会话');assert.ok(repair);repair.click();repair.click();
 assert.equal(sent.filter(m=>m.type==='repair').length,1);assert.equal(sent.find(m=>m.type==='repair').id,record.id);
 emit({type:'detail',id:record.id,report:'# 证据\n<script>alert(1)</script>'});assert.equal(w.document.querySelector('.report script'),null);
 assert.deepEqual(errors,[]);
});

test('诊断中显示进度，完成后可打开证据；跨工作区不启动修复',t=>{
 const {w,sent,emit,errors}=setup(t);const running={...record,status:'running',progress:'正在分析耗时'};
 emit({type:'state',records:[running],selectedId:record.id,workspaceId:'project-a'});assert.match(w.document.getElementById('detail').textContent,/正在分析耗时/);
 assert.equal(sent.some(m=>m.type==='select'),false);
 emit({type:'state',records:[record],selectedId:record.id,workspaceId:'other'});assert.ok(sent.some(m=>m.type==='select'&&m.id===record.id));
 const repair=[...w.document.querySelectorAll('#detail button')].find(e=>e.textContent==='创建修复会话');assert.equal(repair.disabled,true);
 const engine=w.document.getElementById('diagnostic-engine');engine.value='rules';engine.dispatchEvent(new w.Event('change'));
 w.document.getElementById('start').click();assert.ok(sent.some(m=>m.type==='start'&&m.options.kind==='general'&&m.options.hours===24&&m.options.engine==='rules'));
 assert.deepEqual(errors,[]);
});

test('新版页面明确全局范围、全量覆盖及采样版本，发起位置不限制新建修复会话',t=>{
 const {w,sent,emit,errors}=setup(t);
 const global={...record,diagnosticScope:'local-plugin-full',coverage:{files:7,readFiles:7,windows:3,sessions:8,records:100,bytes:10000,firstDay:'2026-10-09',lastDay:'2026-10-15',unreadableFiles:0,invalidLines:0,oversizedLines:0,droppedLines:0}};
 emit({type:'state',records:[global],selectedId:record.id,workspaceId:'plugin-source'});
 const detail=w.document.getElementById('detail');assert.match(detail.textContent,/整个插件 · 全量/);assert.match(detail.textContent,/3 个窗口、8 个会话/);assert.match(detail.textContent,/被分析的插件版本：0.1.127/);
 assert.match(w.document.getElementById('records').textContent,/发起位置：项目A/);
 const repair=[...detail.querySelectorAll('button')].find(e=>e.textContent==='创建修复会话');assert.equal(repair.disabled,false);repair.click();
 assert.equal(sent.filter(m=>m.type==='repair').length,1);
 emit({type:'state',records:[{...global,repair:{status:'started',sessionId:'repair',workspaceId:'plugin-source'}}],selectedId:record.id,workspaceId:'business'});
 assert.equal([...detail.querySelectorAll('button')].find(e=>e.textContent==='查看修复会话').disabled,true);assert.deepEqual(errors,[]);
});

test('打开诊断中心立即创建页面，开始作业独立异步，关闭页面不停止后台任务',async t=>{
 const jobs=new EventEmitter();let started=0,disposed=0;
 Object.assign(jobs,{scope:{workspaceId:'project-a'},list:async()=>[record],get:async()=>record,report:async()=> '# 报告',start:async()=>{started++;return record;},dispose:()=>disposed++});
 const page=new DiagnosticsPage({extensionUri:'/extension'},jobs,async()=>{},async()=>{});t.after(()=>page.dispose());
 page.show(false);const panel=currentPanel;assert.match(panel.webview.html,/插件诊断中心/);assert.equal(started,0);
 await page.message({type:'ready'});assert.equal(panel.messages.at(-1).type,'state');
 await page.message({type:'start'});await new Promise(r=>setImmediate(r));assert.equal(started,1);
 panel.dispose();jobs.emit('changed',record.id);assert.equal(disposed,0);
 page.show(false);await page.message({type:'ready'});assert.equal(currentPanel.messages.at(-1).records[0].id,record.id);
});

test('诊断修复等待新面板就绪后自动发送，保留原会话草稿和运行状态',async()=>{
 const provider=Object.create(ChatViewProvider.prototype),sent=[],posted=[],titles=[];
 const originalCtx={sessionId:'original',draft:'原草稿',proc:{isBusy:true}};
 const fresh={ready:false,panel:{title:''},webview:{},checkpoints:{},blank:true};
 Object.assign(provider,{sessions:new Set([originalCtx,fresh]),openSession:async()=>fresh,post:(_ctx,m)=>posted.push(m),
 handleSend:async(ctx,text)=>{assert.equal(ctx,fresh);sent.push(text);ctx.sessionId='repair-session';return true;},
 store:{setCustomTitle:async(...args)=>{titles.push(args);return true;}},refreshSessions:()=>{}});
 const pending=provider.createDiagnosticRepairSession('修复这次诊断','诊断修复 11111111');await new Promise(r=>setImmediate(r));assert.equal(sent.length,0);
 fresh.ready=true;fresh.pendingDiagnosticRepair.start();assert.equal(await pending,'repair-session');assert.deepEqual(sent,['修复这次诊断']);
 assert.ok(posted.some(m=>m.kind==='remote_user'&&m.text==='修复这次诊断'));assert.equal(originalCtx.draft,'原草稿');assert.equal(originalCtx.proc.isBusy,true);
 assert.equal(titles[0][1],'诊断修复 11111111');
});

test('诊断页模型和推理档位来自目录，切换模型刷新官方英文值并发送选中的设置',t=>{
 const {w,sent,emit,errors}=setup(t);
 assert.equal(w.document.getElementById('start').disabled,true);
 emit({type:'configuration',models:[{id:'model-a',name:'Model A',efforts:['medium','high'],defaultEffort:'medium'},{id:'model-b',name:'Model B',efforts:['high','xhigh'],defaultEffort:'xhigh'}],options:{kind:'general',hours:24,engine:'model',model:'model-a',effort:'medium'}});
 const model=w.document.getElementById('diagnostic-model'),effort=w.document.getElementById('diagnostic-effort');
 assert.equal(model.value,'model-a');assert.equal(effort.value,'medium');assert.deepEqual([...effort.options].map(x=>x.textContent),['medium','high']);
 model.value='model-b';model.dispatchEvent(new w.Event('change'));assert.equal(effort.value,'xhigh');
 assert.deepEqual([...effort.options].map(x=>x.textContent),['high','xhigh']);
 effort.value='high';effort.dispatchEvent(new w.Event('change'));w.document.getElementById('start').click();w.document.getElementById('start').click();
 const starts=sent.filter(m=>m.type==='start');assert.equal(starts.length,1);assert.equal(starts[0].options.model,'model-b');assert.equal(starts[0].options.effort,'high');assert.equal(starts[0].options.hours,24);
 emit({type:'started'});assert.equal(w.document.getElementById('start').disabled,false);assert.deepEqual(errors,[]);
});

test('模型目录失败仍可切换本地规则，模型失败记录显示本地结果与异常计数',t=>{
 const {w,sent,emit,errors}=setup(t);emit({type:'error',message:'模型目录暂不可用'});
 const engine=w.document.getElementById('diagnostic-engine');engine.value='rules';engine.dispatchEvent(new w.Event('change'));
 assert.equal(w.document.getElementById('start').disabled,false);w.document.getElementById('start').click();assert.equal(sent.find(m=>m.type==='start').options.engine,'rules');
 emit({type:'state',records:[{...record,options:{kind:'general',hours:24,engine:'model',model:'model-a',effort:'high'},general:{errors:3,warnings:2,compactionErrors:1,retries:2,recoveries:1},modelAnalysis:{status:'failed',model:'model-a',effort:'high',durationMs:2000,message:'后端拒绝'}}],selectedId:record.id,workspaceId:'project-a'});
 const text=w.document.getElementById('detail').textContent;assert.match(text,/错误 3 条/);assert.match(text,/压缩错误 1 条/);assert.match(text,/失败，本地检查结果已保留/);assert.match(text,/model-a \/ high/);assert.deepEqual(errors,[]);
});
