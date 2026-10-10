const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {CodexProcess,permissions}=require('../dist/test/codex/process.js');
const {CodexRpc}=require('../dist/test/codex/rpc.js');
const {timeline}=require('../dist/test/codex/events.js');
const {SessionStore,previewTitle}=require('../dist/test/codex/session.js');
const {WorkspaceSnapshot}=require('../dist/test/snapshot.js');
const {diffCounts}=require('../dist/test/diff.js');
const {CheckpointManager}=require('../dist/test/checkpoints.js');
const executable=path.resolve('test/fake-codex.cjs');
function waitUntil(predicate){return new Promise((resolve,reject)=>{const end=Date.now()+5000;const tick=()=>{if(predicate())resolve();else if(Date.now()>end)reject(Error('等待超时'));else setTimeout(tick,10);};tick();});}
async function client(t,extra={}){const events=[],requests=[];const p=new CodexProcess({codexPath:executable,cwd:process.cwd(),permissionMode:'default',...extra},{emit:e=>events.push(e),onPermission:r=>requests.push(r),onSessionId:()=>{},onClose:()=>{}});t.after(()=>p.disposeAndWait());await p.start();return {p,events,requests};}
test('初始化不发送预热；流式消息不重复且报告上下文',async t=>{const {p,events}=await client(t);assert.equal(events.some(e=>e.kind==='result'),false);assert.equal(p.sendUserMessage('你好'),true);await waitUntil(()=>events.some(e=>e.kind==='result'));assert.equal(events.filter(e=>e.kind==='text_delta').map(e=>e.text).join(''),'你好');assert.deepEqual(events.find(e=>e.kind==='context'),{kind:'context',used:123,total:1000});});
test('审批只在用户应答后完成，支持本会话允许',async t=>{const {p,events,requests}=await client(t);p.sendUserMessage('approval');await waitUntil(()=>requests.length);assert.equal(p.isBusy,true);assert.equal(events.some(e=>e.kind==='result'),false);p.respondPermission(requests[0].requestId,{behavior:'allow',suggestionId:'session'});await waitUntil(()=>events.some(e=>e.kind==='result'));assert.match(events.find(e=>e.kind==='tool_result').content,/acceptForSession/);});
test('新版提问协议等待用户输入并按 question ID 回答',async t=>{const {p,events,requests}=await client(t);p.sendUserMessage('question');await waitUntil(()=>requests.length);assert.equal(requests[0].toolName,'AskUserQuestion');assert.equal(p.isBusy,true);assert.equal(events.some(e=>e.kind==='result'),false);p.answerQuestion(requests[0].requestId,{'选择什么？':'A'});await waitUntil(()=>events.some(e=>e.kind==='result'));assert.deepEqual(JSON.parse(JSON.parse(events.find(e=>e.kind==='tool_result').content).text.split('\n')[1]),[{question:'选择什么？',answers:['A']}]);});
test('普通会话注册 AskUserQuestion 并等待选项提交',async t=>{const {p,events,requests}=await client(t);p.sendUserMessage('dynamic-question');await waitUntil(()=>requests.length);assert.equal(requests[0].toolName,'AskUserQuestion');assert.deepEqual(requests[0].input.questions[0].options,[{label:'A',description:'选项'}]);assert.equal(p.isBusy,true);assert.equal(events.some(e=>e.kind==='result'),false);p.answerQuestion(requests[0].requestId,{choice:'A'});await waitUntil(()=>events.some(e=>e.kind==='result'));const response=JSON.parse(events.find(e=>e.kind==='tool_result').content);assert.equal(response.interruptCount,1);assert.equal(response.answerCount,0);assert.deepEqual(JSON.parse(response.text.split('\n')[1]),[{question:'选择什么？',answers:['A']}]);});
test('兼容旧版提问方法名',async t=>{const {p,events,requests}=await client(t);p.sendUserMessage('legacy-question');await waitUntil(()=>requests.length);p.answerQuestion(requests[0].requestId,{q1:'A'});await waitUntil(()=>events.some(e=>e.kind==='result'));assert.deepEqual(JSON.parse(JSON.parse(events.find(e=>e.kind==='tool_result').content).text.split('\n')[1]),[{question:'选择什么？',answers:['A']}]);});
test('停止后可继续；压缩完成不重复触发队列',async t=>{const {p,events}=await client(t);p.sendUserMessage('wait');await p.interrupt();await waitUntil(()=>events.some(e=>e.kind==='result'));p.compact();await waitUntil(()=>events.filter(e=>e.kind==='result').length===2);assert.equal(p.isBusy,false);assert.equal(p.sendUserMessage('继续'),true);await waitUntil(()=>events.filter(e=>e.kind==='result').length===3);});
test('请求超时和进程退出会拒绝挂起请求',async t=>{const rpc=new CodexRpc(executable,process.cwd());t.after(()=>rpc.disposeAndWait());await rpc.start();await assert.rejects(rpc.request('hang',{},30),/超时/);const pending=rpc.request('hang');rpc.dispose();await assert.rejects(pending,/关闭/);});
test('协议行损坏后释放旧进程，管理连接下次请求自动重连',async t=>{const store=new SessionStore(process.cwd(),()=>executable);t.after(()=>store.dispose());const first=await store.connection();await assert.rejects(first.request('malformed'),/无效协议数据（stdout 行长度 8 字节）/);assert.equal(first.isClosed,true);const next=await store.connection();assert.notEqual(next,first);assert.deepEqual((await next.request('model/list')).data.map(m=>m.model),['test-model']);});
test('只读请求遇到临时协议错误会重连重试一次',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-rpc-retry-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new SessionStore(dir,()=>executable);t.after(()=>store.dispose());assert.deepEqual(await store.read('malformed-once'),{});});
test('并发历史读取合并为一次完整 thread/read',async()=>{const store=new SessionStore('/tmp',()=>'/fake');const calls=[];store.connection=async()=>({request:async(method,params)=>{calls.push({method,params});await new Promise(r=>setTimeout(r,10));return {thread:{id:params.threadId,historyMode:'full',turns:[{id:'turn-1',items:[]}]}};}});await Promise.all([store.hydrate('same'),store.hydrate('same')]);assert.deepEqual(calls,[{method:'thread/read',params:{threadId:'same',includeTurns:true}}]);assert.equal(store.countLines('same'),1);});
test('只读模式不允许提权；未知权限拒绝',()=>{assert.equal(permissions('plan',[]).approvalPolicy,'never');assert.equal(permissions('default',[]).sandbox,'read-only');assert.equal(permissions('acceptEdits',['/tmp']).sandbox,'workspace-write');assert.throws(()=>permissions('typo',[]));});
test('历史映射保留图片、工具失败与上下文',()=>{const items=timeline([{items:[{type:'userMessage',content:[{type:'text',text:'问题\n<user-attached-context>代码</user-attached-context>'},{type:'image',url:'data:image/png;base64,YQ=='}]},{type:'commandExecution',id:'x',command:'false',exitCode:1,aggregatedOutput:'错误'}]}]);assert.equal(items[0].text,'问题');assert.equal(items[0].context,'代码');assert.equal(items[0].images.length,1);assert.equal(items[1].isError,true);});
test('历史提问显示答案且遮蔽私密输入',()=>{const items=timeline([{items:[{type:'dynamicToolCall',id:'ask',tool:'AskUserQuestion',status:'completed',success:true,arguments:{questions:[{id:'choice',question:'选择？'},{id:'secret',question:'密码？',isSecret:true}]},contentItems:[{type:'inputText',text:JSON.stringify({answers:{choice:{answers:['A']},secret:{answers:['123456']}}})}]}]}]);assert.equal(items[0].name,'AskUserQuestion');assert.match(items[0].result,/"选择？" = "A"/);assert.match(items[0].result,/"密码？" = "（已填写）"/);assert.doesNotMatch(items[0].result,/123456/);});
test('会话标题优先使用手动名称，预览只取简短首句',()=>{const store=new SessionStore('/tmp',()=>'/fake');store.threads.set('a',{id:'a',preview:'现在的机器人只有回复消息的功能，但是我需要它可以执行任务\n后续说明',updatedAt:2});store.threads.set('b',{id:'b',name:'我自己命名的标题',preview:'很长的预览消息',updatedAt:1});assert.equal(store.list()[0].title,'现在的机器人只有回复消息的功能');assert.equal(store.list()[1].title,'我自己命名的标题');assert.equal(previewTitle('这是一个非常非常非常非常非常非常非常非常长的标题'),'这是一个非常非常非常非常非常非常非常非常长的标题'.slice(0,22)+'…');});
test('新会话首条消息发出后立即进入列表，空的远端列表不会冲掉它',async t=>{const store=new SessionStore(process.cwd(),()=>executable);t.after(()=>store.dispose());store.notePending('new-thread','完善 gitignore 文件\n后续说明');assert.equal(store.list()[0].title,'完善 gitignore 文件');await store.refresh();assert.equal(store.list()[0].id,'new-thread');assert.equal(store.list()[0].title,'完善 gitignore 文件');});
test('派生释放写入权，远端列表暂缺时保留本地分支',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-fork-writer-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const fake=path.resolve('test/fake-fork-writer.cjs');const store=new SessionStore(dir,()=>fake);t.after(()=>store.dispose());const id=await store.fork('source','turn-1');assert.equal(id,'forked-thread');await store.refresh();assert.equal(store.list()[0].id,id);assert.equal(store.countLines(id),1);const rpc=new CodexRpc(fake,dir);t.after(()=>rpc.disposeAndWait());await rpc.start();const resumed=await rpc.request('thread/resume',{threadId:id});assert.equal(resumed.thread.id,id);});
test('文件基线覆盖修改、新建和删除；回滚恢复原内容',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-snapshot-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const root=path.join(dir,'project');await fs.mkdir(root);const a=path.join(root,'a.txt'),b=path.join(root,'b.txt'),c=path.join(root,'c.txt');await fs.writeFile(a,'原文');await fs.writeFile(b,'保留');const snap=new WorkspaceSnapshot([root]);await snap.capture();await fs.writeFile(a,'新文');await fs.unlink(b);await fs.writeFile(c,'新增');const changes=await snap.changed();assert.equal(changes.get(a),'原文');assert.equal(changes.get(b),'保留');assert.equal(changes.get(c),null);const cp=new CheckpointManager(path.join(dir,'state'));cp.setSession('test');const id=cp.beginTurn('修改',0);for(const [file,original]of changes)cp.recordSnapshot(file,original);cp.flush();const r=cp.restore(id);assert.equal(r.restoredFiles,3);assert.equal(await fs.readFile(a,'utf8'),'原文');assert.equal(await fs.readFile(b,'utf8'),'保留');await assert.rejects(fs.access(c));});
test('派生复制截断点之前的还原点且保留原会话记录',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-fork-checkpoints-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const original=new CheckpointManager(dir);original.setSession('source');original.beginTurn('第一轮',0);original.beginTurn('第二轮',1);const before=await fs.readFile(path.join(dir,'checkpoints-source.json'),'utf8');assert.equal(CheckpointManager.forkFor(dir,'source','branch',1,[{text:'第一轮',hasImages:false,line:1}]),true);const branch=new CheckpointManager(dir);branch.setSession('branch');assert.equal(branch.list().length,1);assert.equal(branch.list()[0].userText,'第一轮');assert.equal(original.list().length,2);assert.equal(await fs.readFile(path.join(dir,'checkpoints-source.json'),'utf8'),before);});
test('还原点行号按实际会话轮次校正并持久化',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-align-checkpoints-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const cp=new CheckpointManager(dir);cp.setSession('source');const id=cp.beginTurn('第二轮',0);cp.alignTurn(id,1);assert.deepEqual(cp.metaOf(id),{truncateLine:1,userText:'第二轮'});const reloaded=new CheckpointManager(dir);reloaded.setSession('source');assert.equal(reloaded.cutLineOf(id),1);});
test('额度耗尽触发阻断，重置后解除；未知额度不伪造',()=>{const {quotaEvents}=require('../dist/test/codex/events.js');assert.ok(quotaEvents({primary:{usedPercent:100,resetsAt:1000}}).some(e=>e.kind==='rate_limit'&&e.level==='exhausted'));assert.ok(quotaEvents({primary:{usedPercent:30}}).some(e=>e.kind==='rate_limit_cleared'));assert.equal(quotaEvents(null).some(e=>e.kind==='rate_limit_cleared'),false);});
test('实际 7 天周期映射为周额度，保留重置时间',()=>{const {usageView,quotaEvents}=require('../dist/test/codex/events.js');const rate={primary:{usedPercent:6,windowDurationMins:10080,resetsAt:1790754733},secondary:null};assert.deepEqual(usageView(rate),{kind:'usage',sessionPct:undefined,sessionResetAt:undefined,weekPct:6,weekResetAt:1790754733});assert.ok(quotaEvents({primary:{...rate.primary,usedPercent:85}}).some(e=>e.kind==='rate_limit'&&e.limitLabel==='每周额度'));});
test('扫描超限后不能把已有但未扫描的文件误判为新增',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-scan-limit-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.writeFile(path.join(dir,'a.txt'),'A');await fs.writeFile(path.join(dir,'b.txt'),'B');const snap=new WorkspaceSnapshot([dir],1);await snap.capture();await fs.unlink(path.join(dir,'a.txt'));const changes=await snap.changed();assert.equal(changes.has(path.join(dir,'b.txt')),false);assert.ok(snap.skipped.size>0);});
test('快照排除规则只影响指定路径，并记录其他跳过原因',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-snapshot-exclude-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.mkdir(path.join(dir,'generated'));await fs.mkdir(path.join(dir,'nested'));await fs.writeFile(path.join(dir,'generated','auto.ts'),'生成');await fs.writeFile(path.join(dir,'nested','debug.log'),'日志');await fs.writeFile(path.join(dir,'source.ts'),'源码');await fs.writeFile(path.join(dir,'blob.bin'),Buffer.from([1,0,2]));await fs.writeFile(path.join(dir,'huge.txt'),'x'.repeat(2*1024*1024+1));const snap=new WorkspaceSnapshot([dir],20000,['generated/**','**/*.log']);await snap.capture();assert.equal(snap.files.get(path.join(dir,'source.ts')),'源码');assert.equal(snap.files.has(path.join(dir,'generated','auto.ts')),false);assert.equal(snap.skipped.has(path.join(dir,'generated','auto.ts')),false);assert.equal(snap.skipped.has(path.join(dir,'nested','debug.log')),false);assert.equal(snap.skipReasons.get(path.join(dir,'blob.bin')),'binary');assert.equal(snap.skipReasons.get(path.join(dir,'huge.txt')),'large');await fs.writeFile(path.join(dir,'generated','auto.ts'),'变更');await fs.writeFile(path.join(dir,'source.ts'),'修改');const changes=await snap.changed();assert.equal(changes.has(path.join(dir,'generated','auto.ts')),false);assert.equal(changes.get(path.join(dir,'source.ts')),'源码');});
test('多工作区的快照排除规则按各自目录生效',async t=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-multi-root-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const a=path.join(dir,'a'),b=path.join(dir,'b');await fs.mkdir(a);await fs.mkdir(b);await fs.writeFile(path.join(a,'icon.png'),'A');await fs.writeFile(path.join(b,'icon.png'),'B');const snap=new WorkspaceSnapshot([a,b],20000,new Map([[a,['icon.png']],[b,[]]]));await snap.capture();assert.equal(snap.files.has(path.join(a,'icon.png')),false);assert.equal(snap.files.get(path.join(b,'icon.png')),'B');});
test('长文件的小改动只计算变化段，行数保持准确',()=>{const lines=Array.from({length:5000},(_,i)=>`line-${i}`);const before=lines.join('\n');const after=[...lines.slice(0,2500),'inserted',...lines.slice(2500)].join('\n');assert.deepEqual(diffCounts(before,after),{added:1,removed:0});assert.deepEqual(diffCounts('A\nB\nC','A\nX\nC'),{added:1,removed:1});assert.deepEqual(diffCounts(before,before),{added:0,removed:0});const unrelatedA=Array.from({length:2100},(_,i)=>`a-${i}`).join('\n');const unrelatedB=Array.from({length:2100},(_,i)=>`b-${i}`).join('\n');assert.deepEqual(diffCounts(unrelatedA,unrelatedB),{added:1,removed:1});});

test('空答案和普通授权都不能放行提问，拒绝提问会停止本轮',async t=>{
 const {p,events,requests}=await client(t);p.sendUserMessage('dynamic-question');await waitUntil(()=>requests.length);
 const key=requests[0].requestId;
 assert.equal(p.answerQuestion(key,{}),false);assert.equal(p.answerQuestion(key,{choice:'  '}),false);
 p.respondPermission(key,{behavior:'allow'});
 await new Promise(r=>setTimeout(r,80));assert.equal(events.some(e=>e.kind==='result'),false);assert.equal(p.isBusy,true);
 p.respondPermission(key,{behavior:'deny'});await waitUntil(()=>events.some(e=>e.kind==='result'));
 assert.equal(events.some(e=>e.kind==='tool_result'),false);
});
test('成功应答后的服务端清理通知不会把答案标为取消',async t=>{
 const {p,events,requests}=await client(t);p.sendUserMessage('dynamic-question');await waitUntil(()=>requests.length);
 const key=requests[0].requestId;assert.equal(p.answerQuestion(key,{choice:'A'}),true);
 p.notification({method:'serverRequest/resolved',params:{threadId:'thread-1',requestId:key}});
 assert.equal(events.some(e=>e.kind==='permission_resolved'&&e.behavior==='deny'),false);
 await waitUntil(()=>events.some(e=>e.kind==='result'));
});

test('恢复旧会话可正常连接',async t=>{
 const p=new CodexProcess({codexPath:executable,cwd:process.cwd(),permissionMode:'default',resumeSessionId:'thread-1'},{emit:()=>{},onPermission:()=>{},onSessionId:(_,resumed)=>assert.equal(resumed,true),onClose:()=>{}});
 t.after(()=>p.disposeAndWait());await p.start();assert.equal(p.currentSessionId,'thread-1');
});

test('旧会话原生异步提问展示 AskUserQuestion 并真正停止后台，提交前不继续',async t=>{
 const {p,events,requests}=await client(t,{resumeSessionId:'thread-1'});
 p.sendUserMessage('async-question');
 await waitUntil(()=>p.pausedQuestion);assert.equal(requests.length,0);
 await waitUntil(()=>requests.length);
 const q=requests[0];
 assert.equal(q.toolName,'AskUserQuestion');
 assert.deepEqual(q.input.questions,[{id:'0',question:'请选择测试结果',options:[{label:'A'},{label:'B'}]}]);
 await new Promise(r=>setTimeout(r,120));
 assert.equal(p.isBusy,true);assert.equal(requests.length,1);
 assert.equal(events.some(e=>['text_delta','tool_input','result'].includes(e.kind)),false);
 assert.equal(p.answerQuestion(q.requestId,{}),false);
 assert.equal(p.answerQuestion(q.requestId,{'0':'B'}),true);
 await waitUntil(()=>events.some(e=>e.kind==='result'));
 const response=JSON.parse(events.find(e=>e.kind==='tool_result').content);
 assert.equal(response.interruptCount,1);assert.equal(response.answerCount,0);
 assert.deepEqual(JSON.parse(response.text.split('\n')[1]),[{question:'请选择测试结果',answers:['B']}]);
});

test('无选项的原生提问可保存、重载并提交自由文本答案',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-async-question-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const first=await client(t,{questionStateDir:dir,resumeSessionId:'thread-1'});
 first.p.sendUserMessage('async-freeform');await waitUntil(()=>first.requests.length);
 await first.p.disposeAndWait();
 const restored=await client(t,{questionStateDir:dir,resumeSessionId:'thread-1'});
 assert.equal(restored.requests.length,1);assert.deepEqual(restored.requests[0].input.questions[0].options,[]);
 assert.equal(restored.p.answerQuestion(restored.requests[0].requestId,{'0':'我的答案'}),true);
 await waitUntil(()=>restored.events.some(e=>e.kind==='result'));
 assert.match(restored.events.find(e=>e.kind==='tool_result').content,/我的答案/);
 await assert.rejects(fs.access(path.join(dir,'question-thread-1.json')));
});

test('只把结构化原生提问映射为历史问题卡片，普通文字不猜测成问题',()=>{
 const {asyncQuestions}=require('../dist/test/codex/events.js');
 const item={type:'agentMessage',id:'ask',delivery:'async',text:'选择？',questions:[{title:'选择？',options:['A','B']}]};
 assert.equal(timeline([{items:[item]}])[0].name,'AskUserQuestion');
 assert.equal(timeline([{items:[item]}])[0].result,'选择？');
 for(const invalid of [{...item,delivery:null},{...item,questions:[]},{...item,questions:[{title:''}]},{...item,questions:[{title:'选择？',options:[{}]}]}])assert.equal(asyncQuestions(invalid),undefined);
 assert.deepEqual(timeline([{items:[{type:'agentMessage',text:'请确认后回复'}]}]),[{type:'assistant_text',text:'请确认后回复'}]);
});

test('后台提问先中断且保留卡片，未答复不继续；答案通过新轮次送达',async t=>{
 const {p,events,requests}=await client(t);p.sendUserMessage('background-question');
 await waitUntil(()=>p.pausedQuestion);assert.equal(requests.length,0,'确认停止前不显示问题');
 await waitUntil(()=>requests.length);const key=requests[0].requestId;
 await new Promise(r=>setTimeout(r,120));
 assert.equal(p.isBusy,true);assert.equal(p.pausedQuestion.ready,true);
 assert.equal(events.some(e=>e.kind==='result'||e.kind==='text_delta'||e.kind==='permission_resolved'),false);
 assert.equal(p.sendUserMessage('不应插入'),false);
 assert.equal(p.answerQuestion(key,{choice:'B'}),true);assert.equal(p.answerQuestion(key,{choice:'B'}),false);
 await waitUntil(()=>events.some(e=>e.kind==='result'));
 const result=JSON.parse(events.find(e=>e.kind==='tool_result').content);
 assert.equal(result.interruptCount,1);assert.equal(result.answerCount,0);
 assert.match(result.text,/B/);
});
test('暂停失败不显示问题，也不允许提交后恢复',async t=>{
 const {p,events,requests}=await client(t);p.sendUserMessage('failed-pause');
 await waitUntil(()=>events.some(e=>e.kind==='result'));
 assert.equal(requests.length,0);assert.equal(p.answerQuestion('18',{choice:'A'}),false);
 assert.equal(events.find(e=>e.kind==='result').isError,true);
});

test('用户停止已暂停的问题后不会自动续轮，可以发起新的任务',async t=>{
 const {p,events,requests}=await client(t);p.sendUserMessage('background-question');await waitUntil(()=>requests.length);
 const key=requests[0].requestId;await p.interrupt();
 assert.equal(p.isBusy,false);assert.equal(p.answerQuestion(key,{choice:'A'}),false);
 assert.equal(events.filter(e=>e.kind==='result').length,1);assert.equal(events.some(e=>e.kind==='tool_result'),false);
 assert.equal(p.sendUserMessage('新任务'),true);await waitUntil(()=>events.filter(e=>e.kind==='result').length===2);
});

test('等待问题在进程销毁后恢复，空答仍被拒绝，提交后清除磁盘状态',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-paused-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const first=await client(t,{questionStateDir:dir});first.p.sendUserMessage('dynamic-question');await waitUntil(()=>first.requests.length);
 const file=path.join(dir,'question-thread-1.json');assert.ok((await fs.stat(file)).isFile());
 await first.p.disposeAndWait();
 const restored=await client(t,{questionStateDir:dir,resumeSessionId:'thread-1'});
 assert.equal(restored.requests.length,1);assert.equal(restored.p.isBusy,true);assert.equal(restored.events.some(e=>e.kind==='result'),false);
 const key=restored.requests[0].requestId;assert.equal(restored.p.answerQuestion(key,{}),false);
 assert.equal(restored.p.answerQuestion(key,{choice:'A'}),true);await waitUntil(()=>restored.events.some(e=>e.kind==='result'));
 await assert.rejects(fs.access(file));
});
test('取消已恢复的问题后不能在下次启动时复活；新轮次使旧问题失效',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-paused-cancel-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const first=await client(t,{questionStateDir:dir});first.p.sendUserMessage('dynamic-question');await waitUntil(()=>first.requests.length);await first.p.disposeAndWait();
 const stale=await client(t,{questionStateDir:dir,resumeSessionId:'thread-1',env:{TEST_LAST_TURN_ID:'new-turn'}});
 assert.equal(stale.requests.length,0);assert.equal(stale.p.isBusy,false);
 const second=await client(t,{questionStateDir:dir});second.p.sendUserMessage('dynamic-question');await waitUntil(()=>second.requests.length);await second.p.disposeAndWait();
 const restored=await client(t,{questionStateDir:dir,resumeSessionId:'thread-1'});await restored.p.interrupt();await restored.p.disposeAndWait();
 const again=await client(t,{questionStateDir:dir,resumeSessionId:'thread-1'});assert.equal(again.requests.length,0);assert.equal(again.p.isBusy,false);
});
test('私密回答保留给模型但历史及用户消息视图遮蔽，并保留普通答案',async t=>{
 const {p,events,requests}=await client(t);p.sendUserMessage('secret-question');await waitUntil(()=>requests.length);
 assert.equal(p.answerQuestion(requests[0].requestId,{choice:'SAMPLE_PRIVATE_ANSWER'}),true);await waitUntil(()=>events.some(e=>e.kind==='result'));
 const text=JSON.parse(events.find(e=>e.kind==='tool_result').content).text;
 assert.match(text,/SAMPLE_PRIVATE_ANSWER/);assert.match(text,/"isSecret":true/);
 const visible=timeline([{items:[{type:'userMessage',content:[{type:'text',text}]}]}]);
 assert.doesNotMatch(JSON.stringify(visible),/SAMPLE_PRIVATE_ANSWER/);assert.match(visible[0].text,/已填写/);
 const {QUESTION_REPLY_PREFIX}=require('../dist/test/codex/events.js');
 const mixed=QUESTION_REPLY_PREFIX+JSON.stringify([{question:'秘密',isSecret:true,answers:['PRIVATE']},{question:'普通',answers:['公开答案']}]);
 const result=timeline([{items:[{type:'userMessage',content:[{type:'text',text:mixed}]}]}]);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);assert.match(result[0].text,/公开答案/);
});

test('提问续轮不受旧轮次迟到的完成、文字和工具事件影响',async t=>{
 const {p,events,requests}=await client(t,{env:{TEST_HOLD_REPLY:'1'}});
 p.sendUserMessage('async-question');await waitUntil(()=>requests.length);
 const old=p.pausedQuestion.turnId;
 assert.equal(p.answerQuestion(requests[0].requestId,{'0':'B'}),true);
 await waitUntil(()=>p.turnId&&p.turnId!==old);
 const count=events.length;
 for(const m of [
  {method:'turn/completed',params:{turn:{id:old,status:'interrupted'}}},
  {method:'item/agentMessage/delta',params:{turnId:old,itemId:'late',delta:'旧文字'}},
  {method:'item/started',params:{turnId:old,item:{id:'late-tool',type:'commandExecution',command:'旧工具'}}}
 ])p.notification({...m,params:{threadId:'thread-1',...m.params}});
 assert.equal(p.isBusy,true);assert.equal(events.length,count);
 await p.interrupt();await waitUntil(()=>!p.isBusy);
});

test('提问暂停期间仍接收账号额度更新，不恢复执行',async t=>{
 const {p,events,requests}=await client(t);p.sendUserMessage('async-question');await waitUntil(()=>requests.length);
 p.notification({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:100}}}});
 assert.ok(events.some(e=>e.kind==='rate_limit'&&e.level==='exhausted'));
 assert.equal(p.pausedQuestion.ready,true);assert.equal(events.some(e=>e.kind==='result'),false);
});

test('不支持的续轮速度不丢失待答问题，切回普通后可再次提交',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-retry-answer-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const {p,events,requests}=await client(t,{questionStateDir:dir});p.sendUserMessage('dynamic-question');await waitUntil(()=>requests.length);
 const key=requests[0].requestId;await p.setSpeedMode('ultrafast');
 assert.throws(()=>p.answerQuestion(key,{choice:'A'}),/重新提交答案/);
 assert.equal(p.pausedQuestion.ready,true);assert.equal(p.isBusy,true);
 assert.ok((await fs.stat(path.join(dir,'question-thread-1.json'))).isFile());
 assert.equal(events.some(e=>e.kind==='permission_resolved'),false);
 await p.setSpeedMode('default');assert.equal(p.answerQuestion(key,{choice:'A'}),true);
 await waitUntil(()=>events.some(e=>e.kind==='result'));
});

test('损坏的原生问题或动态问题停止后台，不展示不可回答卡片',async t=>{
 for(const native of [true,false]){
  const {p,events,requests}=await client(t);p.sendUserMessage('wait');await waitUntil(()=>p.turnId);
  const turnId=p.turnId;
  if(native)p.notification({method:'item/completed',params:{threadId:'thread-1',turnId,item:{id:'broken',type:'agentMessage',delivery:'async',text:'等你回答',questions:[{title:'选择？',options:{bad:true}}]}}});
  else await p.request({id:'invalid',method:'item/tool/call',params:{threadId:'thread-1',turnId,tool:'AskUserQuestion',arguments:{questions:[{question:'选择？',options:{bad:true}}]}}});
  await waitUntil(()=>!p.isBusy);
  assert.equal(requests.length,0);assert.ok(events.some(e=>e.kind==='notice'&&/提问格式无效/.test(e.message)));
 }
});

test('重复问题 ID 规范化后，各题答案不会被覆盖',async t=>{
 const {p,events,requests}=await client(t);p.sendUserMessage('wait');await waitUntil(()=>p.turnId);
 await p.request({id:'duplicate',method:'item/tool/call',params:{threadId:'thread-1',turnId:p.turnId,tool:'AskUserQuestion',arguments:{questions:[{id:'same',question:'第一题',options:[]},{id:'same',question:'第二题',options:[]}]}}});
 await waitUntil(()=>requests.length);
 assert.deepEqual(requests[0].input.questions.map(q=>q.id),['0','1']);
 assert.equal(p.answerQuestion('duplicate',{'0':'答案一','1':'答案二'}),true);
 await waitUntil(()=>events.some(e=>e.kind==='result'));
 const text=JSON.parse(events.find(e=>e.kind==='tool_result').content).text;
 assert.deepEqual(JSON.parse(text.split('\n')[1]),[{question:'第一题',answers:['答案一']},{question:'第二题',answers:['答案二']}]);
});

test('停止 RPC 应答不等于轮次结束，确认结束前保持忙碌',async t=>{
 const {p,events}=await client(t,{env:{TEST_INTERRUPT_DELAY:'180'}});p.sendUserMessage('wait');await waitUntil(()=>p.turnId);
 await p.interrupt();assert.equal(p.isBusy,true);assert.equal(events.some(e=>e.kind==='result'),false);
 await waitUntil(()=>!p.isBusy);assert.equal(p.stopTimer,undefined);
});

test('没有结构化问题的异步消息照常显示，停止中的迟到问题不再弹卡片',async t=>{
 const {p,events,requests}=await client(t,{env:{TEST_INTERRUPT_DELAY:'180'}});p.sendUserMessage('wait');await waitUntil(()=>p.turnId);
 p.notification({method:'item/completed',params:{threadId:'thread-1',turnId:p.turnId,item:{id:'notice',type:'agentMessage',delivery:'async',questions:[],text:'普通异步通知'}}});
 assert.ok(events.some(e=>e.kind==='text_delta'&&e.text==='普通异步通知'));assert.equal(p.stopTimer,undefined);
 await p.interrupt();
 p.notification({method:'item/completed',params:{threadId:'thread-1',turnId:p.turnId,item:{id:'late-question',type:'agentMessage',delivery:'async',questions:[{title:'迟到的问题',options:['A']}]}}});
 assert.equal(p.pausedQuestion,undefined);assert.equal(requests.length,0);
 await waitUntil(()=>!p.isBusy);
});

test('停止一直没有完成通知时关闭连接，释放发送锁',async t=>{
 const {p,events}=await client(t,{env:{TEST_INTERRUPT_NO_COMPLETE:'1'}});p.sendUserMessage('wait');await waitUntil(()=>p.turnId);
 t.mock.timers.enable({apis:['setTimeout']});
 try {
  await p.interrupt();t.mock.timers.tick(10000);
  assert.equal(p.isExited,true);assert.equal(p.isBusy,false);
  assert.ok(events.some(e=>e.kind==='error'&&/确认本轮停止/.test(e.message)));
 } finally {t.mock.timers.reset();}
});

test('私密标记随等待状态恢复，保存文件不含用户答案，历史继续遮蔽',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-paused-secret-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const first=await client(t,{questionStateDir:dir});first.p.sendUserMessage('secret-question');await waitUntil(()=>first.requests.length);await first.p.disposeAndWait();
 const restored=await client(t,{questionStateDir:dir,resumeSessionId:'thread-1'});
 assert.equal(restored.requests[0].input.questions[0].isSecret,true);
 assert.equal(restored.p.answerQuestion(restored.requests[0].requestId,{choice:'SAMPLE_SECRET'}),true);
 await waitUntil(()=>restored.events.some(e=>e.kind==='result'));
 assert.deepEqual(await fs.readdir(dir),[]);
 const text=JSON.parse(restored.events.find(e=>e.kind==='tool_result').content).text;
 assert.match(text,/SAMPLE_SECRET/);
 assert.doesNotMatch(JSON.stringify(timeline([{items:[{type:'userMessage',content:[{type:'text',text}]}]}])),/SAMPLE_SECRET/);
});
test('损坏的等待状态不阻塞会话初始化',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-paused-broken-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'question-thread-1.json'),'broken');
 const restored=await client(t,{questionStateDir:dir,resumeSessionId:'thread-1'});
 assert.equal(restored.p.isBusy,false);assert.equal(restored.requests.length,0);assert.ok(restored.events.some(e=>e.kind==='notice'));
});

test('合法 JSON 的无效等待状态也不阻塞初始化',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-paused-null-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const value of ['null','[]','{}']){
  await fs.writeFile(path.join(dir,'question-thread-1.json'),value);
  const restored=await client(t,{questionStateDir:dir,resumeSessionId:'thread-1'});
  assert.equal(restored.p.isBusy,false);assert.equal(restored.requests.length,0);await restored.p.disposeAndWait();
 }
});

async function fastClient(t, extra={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-fast-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const log=path.join(dir,'rpc.jsonl');
 const c=await client(t,{...extra,env:{...extra.env,TEST_RPC_LOG:log}});
 return {...c,read:async()=> (await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse)};
}
test('快速模式在新建、恢复和续轮传递服务档位，关闭明确恢复普通速度',async t=>{
 for(const resumeSessionId of [undefined,'thread-1']) {
  const {p,events,read}=await fastClient(t,{resumeSessionId,speedMode:'fast',model:'test-model',effort:'high'});
  const init=(await read()).find(m=>m.method===(resumeSessionId?'thread/resume':'thread/start'));
  assert.equal(init.params.serviceTier,'priority');
  p.sendUserMessage('wait');await waitUntil(()=>p.turnId);
  await p.setSpeedMode('default');
  assert.equal((await read()).filter(m=>m.method==='turn/start').length,1);
  assert.equal((await read()).some(m=>m.method==='turn/interrupt'),false,'切换不得中断当前轮次');
  await p.interrupt();await waitUntil(()=>!p.isBusy);
  p.sendUserMessage('普通速度');await waitUntil(()=>events.filter(e=>e.kind==='result').length===2);
  const turns=(await read()).filter(m=>m.method==='turn/start');
  assert.deepEqual(turns.map(m=>m.params.serviceTier),['priority','default']);
  assert.ok(turns.every(m=>m.params.model==='test-model'&&m.params.effort==='high'));
 }
});
test('快速默认关闭且不继承会话服务档位；运行中开启只影响下轮',async t=>{
 const {p,events,read}=await fastClient(t);
 assert.equal((await read()).find(m=>m.method==='thread/start').params.serviceTier,'default');
 p.sendUserMessage('普通');await waitUntil(()=>!p.isBusy);await p.setSpeedMode('fast');
 p.sendUserMessage('加急');await waitUntil(()=>events.filter(e=>e.kind==='result').length===2);
 assert.deepEqual((await read()).filter(m=>m.method==='turn/start').map(m=>m.params.serviceTier),['default','priority']);
});
test('不支持或未列出的模型不静默降速，也不发送收费请求',async t=>{
 for(const extra of [{env:{TEST_NO_FAST:'1'}},{model:'unlisted-model'}]) {
  const {p,events,read}=await fastClient(t,{...extra,speedMode:'fast'});
  p.sendUserMessage('加急');await waitUntil(()=>events.some(e=>e.kind==='result'));
  assert.equal((await read()).some(m=>m.method==='turn/start'),false);
  assert.match(events.find(e=>e.kind==='error').message,/无法确认.*支持快速模式/);
  assert.equal(events.find(e=>e.kind==='result').isError,true);
  await p.setSpeedMode('default');p.sendUserMessage('普通');await waitUntil(()=>events.filter(e=>e.kind==='result').length===2);
  assert.equal((await read()).filter(m=>m.method==='turn/start').length,1);
 }
});

test('三档速度在已有会话逐轮切换，超高速不能改变模型或推理强度',async t=>{
 const {p,events,read}=await fastClient(t,{env:{TEST_ULTRA:'1'},model:'test-model',effort:'high',resumeSessionId:'thread-1',speedMode:'ultrafast'});
 assert.equal((await read()).find(m=>m.method==='thread/resume').params.serviceTier,'ultrafast');
 for(const mode of ['ultrafast','fast','default']) {
  await p.setSpeedMode(mode);p.sendUserMessage(mode);await waitUntil(()=>!p.isBusy);
 }
 const turns=(await read()).filter(m=>m.method==='turn/start');
 assert.deepEqual(turns.map(m=>m.params.serviceTier),['ultrafast','priority','default']);
 assert.ok(turns.every(m=>m.params.model==='test-model'&&m.params.effort==='high'));
 assert.equal(events.filter(e=>e.kind==='result').length,3);
});
test('仅支持快速的模型不能请求超高速，普通模式始终可恢复',async t=>{
 const {p,events,read}=await fastClient(t,{speedMode:'ultrafast'});
 p.sendUserMessage('超高速');await waitUntil(()=>!p.isBusy);
 assert.equal((await read()).some(m=>m.method==='turn/start'),false);
 assert.match(events.find(e=>e.kind==='error').message,/超高速/);
 await p.setSpeedMode('default');p.sendUserMessage('普通');await waitUntil(()=>events.filter(e=>e.kind==='result').length===2);
 assert.equal((await read()).find(m=>m.method==='turn/start').params.serviceTier,'default');
});
test('API 登录只发送计费类型，未知速度不能应用到进程',async t=>{
 const {p,events}=await client(t,{env:{TEST_API_KEY:'1'}});
 assert.ok(events.some(e=>e.kind==='speed_context'&&e.billing==='api'));
 await assert.rejects(()=>p.setSpeedMode('invalid'),/无效的速度模式/);
});

test('模型目录未返回也能完成普通模式启动并发送，不发送预热请求',async t=>{
 const {p,events,read}=await fastClient(t,{env:{TEST_DEFER_MODELS:'1'}});
 assert.equal(events.some(e=>e.kind==='models'),false);
 assert.equal((await read()).some(m=>m.method==='turn/start'),false);
 assert.equal(p.sendUserMessage('普通消息'),true);await waitUntil(()=>events.some(e=>e.kind==='result'));
 assert.equal(events.some(e=>e.kind==='models'),false,'普通消息完成时目录仍被阻塞');
 assert.equal((await read()).filter(m=>m.method==='turn/start').length,1);
 await p.rpc.request('release-models');await waitUntil(()=>events.some(e=>e.kind==='models'));
});
test('加速发送等待目录校验，等待期间的设置修改仅影响下一轮',async t=>{
 const {p,events,read}=await fastClient(t,{env:{TEST_DEFER_MODELS:'1'},speedMode:'fast',model:'test-model',effort:'high'});
 p.sendUserMessage('加速');await p.setSpeedMode('default');await p.setEffort('low');
 assert.equal((await read()).some(m=>m.method==='turn/start'),false);
 await p.rpc.request('release-models');await waitUntil(()=>events.some(e=>e.kind==='result'));
 const first=(await read()).find(m=>m.method==='turn/start');
 assert.equal(first.params.serviceTier,'priority');assert.equal(first.params.effort,'high');
 p.sendUserMessage('下一轮');await waitUntil(()=>events.filter(e=>e.kind==='result').length===2);
 const last=(await read()).filter(m=>m.method==='turn/start').at(-1);
 assert.equal(last.params.serviceTier,'default');assert.equal(last.params.effort,'low');
});
test('等待目录时停止立即完成，目录稍后返回不得复活旧消息或干扰新轮次',async t=>{
 const {p,events,read}=await fastClient(t,{env:{TEST_DEFER_MODELS:'1'},speedMode:'fast'});
 p.sendUserMessage('不能送出的旧消息');await p.interrupt();assert.equal(p.isBusy,false);
 assert.equal(events.some(e=>e.kind==='models'),false,'停止不等待目录');
 await p.setSpeedMode('default');p.sendUserMessage('wait');await waitUntil(()=>p.turnId);
 await p.rpc.request('release-models');await waitUntil(()=>events.some(e=>e.kind==='models'));
 const turns=(await read()).filter(m=>m.method==='turn/start');assert.equal(turns.length,1);assert.equal(turns[0].params.input[0].text,'wait');
 assert.equal(p.isBusy,true);await p.interrupt();await waitUntil(()=>!p.isBusy);
});
