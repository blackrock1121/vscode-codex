const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync('src/panel/chatViewProvider.ts','utf8');
function setup(t){
 const section=source.slice(source.indexOf('  private html('));
 const raw=section.match(/return (?:\/\* html \*\/ )?`([\s\S]*?)`;\s*\n\s+}/)[1];
 const html=raw.replace(/\$\{[^}]+\}/g,'').replace(/<script[^>]*><\/script>/g,'');
 const sent=[],errors=[];
 const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://webview.test/'});
 t.after(()=>dom.window.close());
 const w=dom.window; w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>({}),setState:()=>{}});
 w.ResizeObserver=class{observe(){}disconnect(){}};
 w.IntersectionObserver=class{observe(){}disconnect(){}};
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.HTMLElement.prototype.scrollTo=function(){};
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 w.document.queryCommandSupported=()=>false;
 w.addEventListener('error',e=>errors.push(e.message));
 w.eval(fs.readFileSync('media/webview.js','utf8'));
 const emit=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 return {w,sent,errors,emit};
}
test('真实聊天 HTML 和构建脚本可加载，无 QQ/SLS 入口',t=>{const {w,sent,errors}=setup(t);assert.ok(sent.some(m=>m.type==='ready'));assert.deepEqual(errors,[]);assert.equal(w.document.querySelector('[id*=sls],[id*=qq]'),null);});
test('动态模型、流式 Markdown、代码块和工具卡片可渲染',async t=>{const {w,errors,emit}=setup(t);emit({kind:'models',models:[{id:'test-model',name:'测试模型',description:'测试',efforts:['low']}]});w.document.getElementById('model-trigger').click();assert.match(w.document.getElementById('model-menu').textContent,/测试模型/);emit({kind:'busy',busy:true});emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'你好 **世界**\n\n```js\nconst a = 1;\n```'});emit({kind:'tool_input',toolId:'tool',name:'Bash',input:{command:'echo hello'}});emit({kind:'tool_result',toolUseId:'tool',content:'hello',isError:false});emit({kind:'result',isError:false,durationMs:1,numTurns:1});await new Promise(r=>setTimeout(r,80));assert.match(w.document.getElementById('messages').textContent,/世界/);assert.match(w.document.getElementById('messages').textContent,/echo hello/);assert.deepEqual(errors,[]);});
test('流式文字收到后立即可见，无需等待动画帧',t=>{const {w,emit,errors}=setup(t);emit({kind:'busy',busy:true});emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'第一批即时文字'});assert.match(w.document.getElementById('messages').textContent,/第一批即时文字/);emit({kind:'text_delta',text:'，第二批'});assert.match(w.document.getElementById('messages').textContent,/第一批即时文字，第二批/);assert.deepEqual(errors,[]);});
test('流式回复中完整链接立即渲染，本地图片由宿主加载',t=>{const {w,sent,emit,errors}=setup(t);emit({kind:'busy',busy:true});emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'请扫码 ![登录二维码](/tmp/qr.jpg) [打开图片](/tmp/qr.jpg)'});const messages=w.document.getElementById('messages');assert.equal(messages.textContent.includes('[打开图片]'),false);assert.ok(messages.querySelector('.code-ref[data-path="/tmp/qr.jpg"]'));assert.ok(sent.some(m=>m.type==='loadLocalImage'&&m.path==='/tmp/qr.jpg'));assert.ok(messages.querySelector('.local-image-placeholder'));emit({kind:'local_image',path:'/tmp/qr.jpg',dataUri:'data:image/jpeg;base64,YQ=='});const img=messages.querySelector('img[data-local-src="/tmp/qr.jpg"]');assert.ok(img);assert.equal(img.getAttribute('src'),'data:image/jpeg;base64,YQ==');img.dispatchEvent(new w.Event('load'));assert.equal(messages.querySelector('.local-image-placeholder'),null);assert.deepEqual(errors,[]);});
test('历史回复的本地图片无法读取时显示清楚的占位文字',t=>{const {w,sent,emit,errors}=setup(t);emit({kind:'load_history',sessionId:'image',items:[{type:'assistant_text',text:'![测试二维码](/tmp/missing.jpg)'}],checkpoints:[]});assert.ok(sent.some(m=>m.type==='loadLocalImage'&&m.path==='/tmp/missing.jpg'));emit({kind:'local_image',path:'/tmp/missing.jpg'});assert.match(w.document.getElementById('messages').textContent,/图片无法加载：测试二维码/);assert.equal(w.document.querySelector('.md img'),null);assert.deepEqual(errors,[]);});
test('发送与停止按钮传递真实消息契约',t=>{const {w,sent,emit}=setup(t);const input=w.document.getElementById('input');input.value='测试消息';input.dispatchEvent(new w.Event('input'));w.document.getElementById('btn-send').click();assert.ok(sent.some(m=>m.type==='send'&&m.text==='测试消息'));emit({kind:'busy',busy:true});w.document.getElementById('btn-stop').click();assert.ok(sent.some(m=>m.type==='interrupt'));});
test('排队消息可撤回到输入框，保留换行、图片、附件和已有草稿',t=>{const {w,sent,emit,errors}=setup(t);const input=w.document.getElementById('input');emit({kind:'busy',busy:true});emit({kind:'context_added',label:'选中代码',text:'const n = 1'});emit({kind:'attach_files',paths:['/tmp/example.ts']});emit({kind:'draft',text:'',images:[{mediaType:'image/png',data:'aGVsbG8='}]});input.value='第一行\n  缩进第二行\n\n末行  ';w.document.getElementById('btn-send').click();const queue=w.document.getElementById('task-queue');assert.equal(queue.querySelectorAll('.tq-row').length,1);assert.equal(sent.some(m=>m.type==='send'),false);input.value='已有草稿';queue.querySelector('.tq-recall').click();assert.equal(input.value,'第一行\n  缩进第二行\n\n末行  \n\n已有草稿');assert.equal(queue.querySelectorAll('.tq-row').length,0);assert.equal(w.document.activeElement,input);assert.match(w.document.getElementById('context-chips').textContent,/选中代码/);assert.match(w.document.getElementById('file-chips').textContent,/example.ts/);assert.equal(w.document.querySelectorAll('#image-previews .img-preview').length,1);assert.ok(sent.some(m=>m.type==='draft'&&m.text===input.value));assert.deepEqual(errors,[]);});
test('撤回指定排队消息不影响其他排队消息',t=>{const {w,sent,emit}=setup(t);const input=w.document.getElementById('input');emit({kind:'busy',busy:true});for(const text of ['第一条','第二条']){input.value=text;w.document.getElementById('btn-send').click();}const queue=w.document.getElementById('task-queue');queue.querySelectorAll('.tq-recall')[1].click();assert.equal(input.value,'第二条');assert.equal(queue.querySelectorAll('.tq-row').length,1);assert.match(queue.textContent,/第一条/);assert.equal(sent.some(m=>m.type==='send'),false);});
test('快照跳过清单可逐项排除、全部排除或忽略提醒',t=>{const {w,sent,emit,errors}=setup(t);const files=[{path:'/tmp/p/.DS_Store',rel:'.DS_Store',reason:'二进制'},{path:'/tmp/p/media/icon.png',rel:'media/icon.png',reason:'二进制'}];emit({kind:'snapshot_skips',files,total:2});let card=w.document.querySelector('.snapshot-skips');assert.ok(card);assert.equal(card.querySelectorAll('.ss-row').length,2);card.querySelector('.ss-row .ss-action').click();assert.ok(sent.some(m=>m.type==='excludeSnapshotPaths'&&m.paths?.[0]===files[0].path));emit({kind:'snapshot_exclude_result',ok:true,message:'已排除',paths:[files[0].path]});card=w.document.querySelector('.snapshot-skips');assert.equal(card.querySelectorAll('.ss-row').length,1);card.querySelector('.ss-actions .ss-action').click();assert.ok(sent.some(m=>m.type==='excludeSnapshotPaths'&&m.all===true));emit({kind:'snapshot_exclude_result',ok:true,message:'已排除',paths:[files[1].path]});assert.equal(w.document.querySelector('.snapshot-skips'),null);emit({kind:'snapshot_skips',files,total:2});w.document.querySelectorAll('.ss-actions .ss-action')[1].click();assert.equal(w.document.querySelector('.snapshot-skips'),null);assert.deepEqual(errors,[]);});
test('只有周额度时仅显示周限额和重置时间',t=>{const {w,emit,errors}=setup(t);emit({kind:'usage',weekPct:6,weekResetAt:1790754733});const pill=w.document.getElementById('usage-pill');assert.match(pill.textContent,/周.*6%/);assert.doesNotMatch(pill.textContent,/会话/);pill.click();const menu=w.document.getElementById('usage-menu');assert.match(menu.textContent,/每周 · 全部模型/);assert.match(menu.textContent,/\d+月\d+日 \d{2}:\d{2} 重置/);assert.doesNotMatch(menu.textContent,/5 小时/);assert.deepEqual(errors,[]);});
test('搜索结果只渲染 http(s) 链接',t=>{const {w,emit,errors}=setup(t);emit({kind:'tool_input',toolId:'search',name:'WebSearch',input:{query:'test'}});emit({kind:'tool_result',toolUseId:'search',content:'Links: [{"title":"正常","url":"https://example.com/a"},{"title":"危险","url":"javascript:alert(1)"}]',isError:false});const links=[...w.document.querySelectorAll('.search-hit')];assert.equal(links.length,1);assert.equal(links[0].href,'https://example.com/a');assert.deepEqual(errors,[]);});
test('回复中的网页、相对路径、绝对路径和文件 URI 分别走正确跳转',t=>{const {w,sent,emit,errors}=setup(t);emit({kind:'load_history',sessionId:'links',items:[{type:'assistant_text',text:'[网站](https://example.com/a?q=1) [邮箱](mailto:a@example.com) [相对](docs/guide.md#L8) [绝对](/tmp/a%20b.txt#L12) [文件 URI](file:///tmp/a%20b.pdf) [文档](/tmp/report.docx) [命令](command:workbench.action.files.openFile)'}],checkpoints:[]});const messages=w.document.getElementById('messages');const click=e=>e.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));const site=messages.querySelector('a[href="https://example.com/a?q=1"]');assert.ok(site);click(site);assert.ok(sent.some(m=>m.type==='openExternalLink'&&m.url==='https://example.com/a?q=1'));click(messages.querySelector('a[href^="mailto:"]'));assert.ok(sent.some(m=>m.type==='openExternalLink'&&m.url==='mailto:a@example.com'));for(const [label,p,line]of [['相对','docs/guide.md',8],['绝对','/tmp/a b.txt',12],['文件 URI','file:///tmp/a%20b.pdf',undefined],['文档','/tmp/report.docx',undefined]]){const ref=[...messages.querySelectorAll('.code-ref[data-action="open"]')].find(e=>e.textContent===label);assert.ok(ref,label);click(ref);assert.ok(sent.some(m=>m.type==='openFile'&&m.path===p&&m.line===line),label);}assert.equal([...messages.querySelectorAll('a,.code-ref')].some(e=>e.textContent==='命令'),false);assert.deepEqual(errors,[]);});
test('行内代码与正文中的本地文档路径可点击',t=>{const {w,sent,emit,errors}=setup(t);emit({kind:'load_history',sessionId:'paths',items:[{type:'assistant_text',text:'查看 `/tmp/Quarterly Report.pdf` 和 /tmp/qr.jpg'}],checkpoints:[]});const refs=[...w.document.querySelectorAll('.code-ref[data-action="open"]')];assert.deepEqual(refs.map(e=>e.dataset.path),['/tmp/Quarterly Report.pdf','/tmp/qr.jpg']);refs.forEach(e=>e.click());assert.deepEqual(sent.filter(m=>m.type==='openFile').map(m=>m.path),['/tmp/Quarterly Report.pdf','/tmp/qr.jpg']);assert.deepEqual(errors,[]);});
test('新推理档位可随模型列表显示并发送',t=>{const {w,sent,emit}=setup(t);emit({kind:'models',models:[{id:'future',name:'未来模型',description:'',efforts:['medium','future_level'],defaultEffort:'medium',isDefault:true}]});emit({kind:'config',model:'future',effort:'',permissionMode:'default'});w.document.getElementById('model-trigger').click();const option=w.document.querySelector('[data-effort="future_level"]');assert.ok(option);option.click();assert.ok(sent.some(m=>m.type==='setEffort'&&m.effort==='future_level'));});
test('推理强度按模型列出，支持 max/ultra 并可恢复默认',t=>{const {w,sent,emit,errors}=setup(t);emit({kind:'models',models:[{id:'gpt-6-sol',name:'GPT-6-Sol',description:'',efforts:['low','medium','high','xhigh','max','ultra'],defaultEffort:'medium',isDefault:true},{id:'gpt-5.5',name:'GPT-5.5',description:'',efforts:['low','medium','high','xhigh'],defaultEffort:'medium'}]});emit({kind:'config',model:'gpt-6-sol',effort:'high',permissionMode:'default'});w.document.getElementById('model-trigger').click();let menu=w.document.getElementById('model-menu');assert.equal(menu.querySelectorAll('[data-effort]').length,7);assert.equal(menu.querySelector('[data-effort="high"]').getAttribute('aria-pressed'),'true');menu.querySelector('[data-effort="ultra"]').click();assert.ok(sent.some(m=>m.type==='setEffort'&&m.effort==='ultra'));assert.equal(menu.querySelector('[data-effort="ultra"]').getAttribute('aria-pressed'),'true');emit({kind:'config',model:'gpt-5.5',effort:'',permissionMode:'default'});menu=w.document.getElementById('model-menu');assert.equal(menu.querySelectorAll('[data-effort]').length,5);assert.equal(menu.querySelector('[data-effort="ultra"]'),null);assert.match(menu.querySelector('[data-effort=""]').textContent,/默认.*中/);assert.deepEqual(errors,[]);});
test('提问卡片等待点击提交，按 ID 返回答案且遵守 isOther',t=>{const {w,sent,emit,errors}=setup(t);emit({kind:'permission_request',requestId:'17',toolName:'AskUserQuestion',input:{questions:[{id:'confirm',question:'是否继续？',header:'确认',isOther:false,options:[{label:'继续',description:'确认执行'},{label:'取消',description:'停止'}]}]},suggestions:[]});const picker=w.document.querySelector('.askp');assert.ok(picker);assert.equal(picker.querySelector('.askp-custom'),null);assert.equal(sent.some(m=>m.type==='answerQuestion'),false);picker.querySelector('.askp-opt').click();assert.equal(sent.some(m=>m.type==='answerQuestion'),false);picker.querySelector('.askp-submit').click();assert.ok(sent.some(m=>m.type==='answerQuestion'&&m.requestId==='17'&&m.answers.confirm==='继续'));assert.deepEqual(errors,[]);});
test('服务端取消提问时选项不可再提交',t=>{const {w,sent,emit}=setup(t);emit({kind:'permission_request',requestId:'18',toolName:'AskUserQuestion',input:{questions:[{id:'choice',question:'选择？',options:[{label:'A'}]}]},suggestions:[]});emit({kind:'permission_resolved',requestId:'18',behavior:'deny',auto:true});const picker=w.document.querySelector('.askp');assert.ok(picker.classList.contains('interaction-cancelled'));assert.ok([...picker.querySelectorAll('button, textarea')].every(x=>x.disabled));assert.equal(sent.some(m=>m.type==='answerQuestion'),false);});
test('派生仅出现在有前序对话的还原点并传递正确 ID',t=>{const {w,sent,emit,errors}=setup(t);emit({kind:'load_history',sessionId:'source',items:[{type:'user',text:'第一轮',images:[]},{type:'assistant_text',text:'答一'},{type:'user',text:'第二轮',images:[]},{type:'assistant_text',text:'答二'}],checkpoints:[{id:'cp1',userText:'第一轮',label:'第一轮'},{id:'cp2',userText:'第二轮',label:'第二轮'}]});const forks=w.document.querySelectorAll('.cp-fork');assert.equal(forks.length,1);forks[0].click();assert.ok(sent.some(m=>m.type==='forkCheckpoint'&&m.checkpointId==='cp2'));assert.deepEqual(errors,[]);});

test('关闭问题只停止本轮，不提交空答案',t=>{const {w,sent,emit}=setup(t);emit({kind:'permission_request',requestId:'19',toolName:'AskUserQuestion',input:{questions:[{id:'detail',question:'提供详情',options:[]}]},suggestions:[]});const picker=w.document.querySelector('.askp');assert.ok(picker.querySelector('.askp-submit').disabled);picker.querySelector('.askp-x').click();assert.ok(sent.some(m=>m.type==='interrupt'));assert.equal(sent.some(m=>m.type==='answerQuestion'),false);});
test('无效提问停止本轮，不自动空答放行',t=>{const {sent,emit,errors}=setup(t);emit({kind:'permission_request',requestId:'20',toolName:'AskUserQuestion',input:{questions:[]},suggestions:[]});assert.ok(sent.some(m=>m.type==='interrupt'));assert.equal(sent.some(m=>m.type==='answerQuestion'),false);assert.deepEqual(errors,[]);});

test('提交答案等待宿主确认，失败保留选择与自由文本并允许重试',t=>{
 const {w,sent,emit,errors}=setup(t);
 emit({kind:'busy',busy:true});
 const request={kind:'permission_request',requestId:'retry',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'提供详情',options:[{label:'A'}]}]},suggestions:[]};
 emit(request);emit(request);assert.equal(w.document.querySelectorAll('.askp').length,1);
 let picker=w.document.querySelector('.askp');let input=picker.querySelector('textarea');
 input.value='我的多行\n回答';input.dispatchEvent(new w.Event('input'));
 picker.querySelector('.askp-submit').click();picker.querySelector('.askp-submit').click();
 assert.equal(sent.filter(m=>m.type==='answerQuestion').length,1);
 assert.ok(w.document.querySelector('.askp'));assert.equal(picker.querySelector('.askp-submit').disabled,true);
 emit({kind:'question_answer_rejected',requestId:'retry',message:'请切换速度后重试'});
 assert.equal(picker.querySelector('textarea').value,'我的多行\n回答');
 assert.match(picker.textContent,/请切换速度后重试/);assert.equal(picker.querySelector('.askp-submit').disabled,false);
 picker.querySelector('.askp-submit').click();emit({kind:'permission_resolved',requestId:'retry',behavior:'allow'});
 assert.equal(w.document.querySelector('.askp'),null);assert.match(w.document.querySelector('.askq-card').textContent,/我的多行/);
 assert.deepEqual(errors,[]);
});

test('待回答明确显示暂停，不显示推理动画，也不自动发送队列',async t=>{
 const {w,sent,emit}=setup(t);emit({kind:'busy',busy:true});
 emit({kind:'permission_request',requestId:'waiting',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'选择？',options:[]}]},suggestions:[]});
 emit({kind:'busy',busy:true});
 assert.match(w.document.getElementById('input').placeholder,/已暂停/);
 assert.equal(w.document.querySelector('.working-pill'),null);
 const input=w.document.getElementById('input');input.value='下一件事';w.document.getElementById('btn-send').click();
 await new Promise(r=>setTimeout(r,180));assert.equal(sent.some(m=>m.type==='send'),false);
 assert.equal(w.document.querySelectorAll('.tq-row').length,1);
});

test('点击停止后保持队列，收到后台停止确认才按顺序发送',async t=>{
 const {w,sent,emit}=setup(t);emit({kind:'busy',busy:true});const input=w.document.getElementById('input');
 input.value='已排队';w.document.getElementById('btn-send').click();w.document.getElementById('btn-stop').click();
 assert.match(input.placeholder,/正在停止/);
 input.value='停止期间补充';w.document.getElementById('btn-send').click();
 await new Promise(r=>setTimeout(r,180));assert.equal(sent.some(m=>m.type==='send'),false);
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
 await new Promise(r=>setTimeout(r,180));
 assert.deepEqual(sent.filter(m=>m.type==='send').map(m=>m.text),['已排队']);
 assert.match(w.document.getElementById('task-queue').textContent,/停止期间补充/);
});

test('速度菜单完整展示三档倍率并根据模型能力置灰，保存成功才更新当前状态',t=>{
 const {w,sent,emit,errors}=setup(t);
 emit({kind:'models',models:[{id:'gpt-6-astra',name:'GPT-6 Astra',description:'',efforts:['high'],speedModes:['default','fast']}]});
 emit({kind:'config',model:'gpt-6-astra',effort:'high',permissionMode:'default',speedMode:'default'});
 emit({kind:'speed_context',billing:'chatgpt'});
 const trigger=w.document.getElementById('speed-trigger');trigger.click();
 const menu=w.document.getElementById('speed-menu');
 assert.equal(menu.querySelectorAll('[data-speed]').length,3);
 assert.doesNotMatch(menu.textContent,/购买额度|企业按量|6×|／2×/);
 assert.match(menu.querySelector('[data-speed="default"]').textContent,/1×/);
 assert.match(menu.querySelector('[data-speed="fast"]').textContent,/2.5×/);
 assert.match(menu.querySelector('[data-speed="ultrafast"]').textContent,/8×/);
 assert.equal(menu.querySelector('[data-speed="ultrafast"]').disabled,true);
 menu.querySelector('a').click();assert.equal(sent.at(-1).type,'openExternalLink');assert.match(sent.at(-1).url,/agent-configuration\/speed$/);
 const count=sent.length;menu.querySelector('[data-speed="ultrafast"]').click();assert.equal(sent.length,count);
 menu.querySelector('[data-speed="fast"]').click();assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))),{type:'setSpeedMode',mode:'fast'});
 assert.match(w.document.getElementById('speed-label').textContent,/普通/);
 emit({kind:'config',model:'gpt-6-astra',effort:'high',permissionMode:'default',speedMode:'fast'});
 assert.match(w.document.getElementById('speed-label').textContent,/快速/);
 assert.equal(menu.querySelector('[data-speed="fast"]').getAttribute('aria-pressed'),'true');
 w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.equal(trigger.getAttribute('aria-expanded'),'false');assert.deepEqual(errors,[]);
});
test('超高速能力动态更新，切换模型后不可用状态不伪造为普通；模型菜单显示支持情况',t=>{
 const {w,sent,emit}=setup(t);
 emit({kind:'models',models:[{id:'gpt-6-astra',name:'Astra',description:'',efforts:[],speedModes:['default','fast','ultrafast']},{id:'gpt-6-sol',name:'Sol',description:'',efforts:[],speedModes:['default','fast']}]});
 emit({kind:'config',model:'gpt-6-astra',effort:'',permissionMode:'default',speedMode:'ultrafast'});
 w.document.getElementById('speed-trigger').click();let menu=w.document.getElementById('speed-menu');
 assert.equal(menu.querySelector('[data-speed="ultrafast"]').disabled,false);
 emit({kind:'config',model:'gpt-6-sol',effort:'',permissionMode:'default',speedMode:'ultrafast'});
 assert.equal(menu.querySelector('[data-speed="ultrafast"]').disabled,true);
 assert.match(w.document.getElementById('speed-label').textContent,/超高速.*待确认/);
 emit({kind:'busy',busy:true});menu.querySelector('[data-speed="default"]').click();assert.equal(sent.at(-1).mode,'default');
 assert.equal(sent.some(m=>['setModel','setEffort','stop'].includes(m.type)),false);
 w.document.getElementById('model-trigger').click();
 assert.match(w.document.querySelector('[data-model="gpt-6-astra"]').textContent,/超高速可选/);
 assert.match(w.document.querySelector('[data-model="gpt-6-sol"]').textContent,/超高速未提供/);
});
test('默认模型未确认时不能用目录默认值冒充实际模型，API 提示不套订阅倍率',t=>{
 const {w,emit}=setup(t);
 emit({kind:'models',models:[{id:'gpt-6-astra',name:'Astra',description:'',efforts:[],isDefault:true,speedModes:['default','fast','ultrafast']}]});
 emit({kind:'config',model:'',effort:'',permissionMode:'default',speedMode:'default'});
 w.document.getElementById('speed-trigger').click();const menu=w.document.getElementById('speed-menu');
 assert.equal(menu.querySelector('[data-speed="fast"]').disabled,true);
 emit({kind:'session',sessionId:'s',model:'gpt-6-astra',cwd:'/tmp',tools:[]});
 assert.equal(menu.querySelector('[data-speed="ultrafast"]').disabled,false);
 emit({kind:'speed_context',billing:'api'});
 assert.match(menu.querySelector('[data-speed="ultrafast"]').textContent,/API 定价/);
 assert.doesNotMatch(menu.querySelector('[data-speed="ultrafast"]').textContent,/8×/);
 assert.match(menu.textContent,/API.*不适用/);
});

function manualFrames(w){let next=0;const frames=new Map();w.requestAnimationFrame=f=>{frames.set(++next,f);return next;};w.cancelAnimationFrame=id=>frames.delete(id);return ()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(f=>f(w.performance.now()));};}
test('突发流式片段立即显示文字，同帧只合并一次完整 Markdown 渲染',t=>{
 const {w,emit,errors}=setup(t);const flush=manualFrames(w);
 let renders=0;const desc=Object.getOwnPropertyDescriptor(w.Element.prototype,'innerHTML');
 Object.defineProperty(w.Element.prototype,'innerHTML',{...desc,set(v){if(this.classList.contains('live-committed'))renders++;desc.set.call(this,v);}});
 emit({kind:'busy',busy:true});emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'开头\n'});
 for(let i=0;i<100;i++)emit({kind:'text_delta',text:`第${i}段 **重点**\n`});
 assert.match(w.document.querySelector('.text-seg').textContent,/第99段/,'未执行动画帧也能看到新文字');
 assert.equal(renders,1);flush();assert.equal(renders,2);
 assert.equal(w.document.querySelectorAll('.text-seg strong').length,100);
 emit({kind:'text_delta',text:'末尾内容'});emit({kind:'result',isError:false,durationMs:1,numTurns:1});
 const final=w.document.querySelector('.text-seg').innerHTML;flush();assert.equal(w.document.querySelector('.text-seg').innerHTML,final);assert.match(final,/末尾内容/);assert.deepEqual(errors,[]);
});
test('待渲染时收到完整文本更正或切换块，不会被旧帧回调覆盖',t=>{
 const {w,emit,errors}=setup(t);const flush=manualFrames(w);
 emit({kind:'busy',busy:true});emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'旧文'});emit({kind:'text_delta',text:'旧尾巴'});
 emit({kind:'text_snap',text:'更正后的 **全文**'});flush();assert.doesNotMatch(w.document.querySelector('.text-seg').textContent,/旧/);
 emit({kind:'text_delta',text:'段尾'});emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'第二块'});flush();
 const blocks=w.document.querySelectorAll('.text-seg');assert.match(blocks[0].textContent,/全文.*段尾/);assert.equal(blocks[1].textContent,'第二块');assert.deepEqual(errors,[]);
});
