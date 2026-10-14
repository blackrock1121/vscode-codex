const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync('src/panel/chatViewProvider.ts','utf8');
function setup(t){
 const section=source.slice(source.indexOf('  private html('));
 const raw=section.match(/return (?:\/\* html \*\/ )?`([\s\S]*?)`;\s*\n\s+}/)[1];
 const html=raw.replace(/\$\{[^}]+\}/g,'').replace(/<script[^>]*><\/script>/g,'');
 const sent=[],errors=[],states=[],resizeObservers=[];
 const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://webview.test/'});
 t.after(()=>dom.window.close());
 const w=dom.window; w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>states.at(-1)??{},setState:s=>states.push(JSON.parse(JSON.stringify(s)))});
 w.ResizeObserver=class{constructor(callback){this.callback=callback;this.targets=[];resizeObservers.push(this);}observe(target){this.targets.push(target);}disconnect(){this.targets=[];}};
 w.IntersectionObserver=class{observe(){}disconnect(){}};
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.HTMLElement.prototype.scrollTo=function(){};
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 w.document.queryCommandSupported=()=>false;
 w.addEventListener('error',e=>errors.push(e.message));
 w.eval(fs.readFileSync('media/webview.js','utf8'));
 const emit=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 return {w,sent,errors,emit,states,resize:target=>resizeObservers.filter(o=>o.targets.includes(target)).forEach(o=>o.callback())};
}
function scrollFixture(w){
 const messages=w.document.getElementById('messages');
 let height=2000,viewport=600,top=1400;
 Object.defineProperties(messages,{
  scrollHeight:{get:()=>height},clientHeight:{get:()=>viewport},
  scrollTop:{get:()=>top,set:value=>{top=Math.max(0,Math.min(value,height-viewport));}},
 });
 return {messages,setHeight:value=>height=value,setViewport:value=>viewport=value,
  scroll:value=>{messages.scrollTop=value;messages.dispatchEvent(new w.Event('scroll'));}};
}
async function imageReady(predicate){
 for(let n=0;n<100;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}
 assert.fail('图片读取未完成');
}
test('问题卡粘贴图片可单独回答，提交失败保留图片，成功后显示可查看附件',async t=>{
 const {w,sent,emit,errors}=setup(t);
 emit({kind:'permission_request',requestId:'image-q',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'请发截图',options:[]}]},suggestions:[]});
 const input=w.document.querySelector('.askp-input');input.focus();
 const paste=new w.Event('paste',{bubbles:true,cancelable:true});
 Object.defineProperty(paste,'clipboardData',{value:{items:[{type:'image/png',getAsFile:()=>new w.File(['test'],'screen.png',{type:'image/png'})}]}});
 input.dispatchEvent(paste);assert.equal(paste.defaultPrevented,true);assert.equal(w.document.querySelector('.askp-submit').disabled,true);
 await imageReady(()=>w.document.querySelector('.askp-images img'));
 assert.equal(w.document.querySelectorAll('#image-previews img').length,0,'问题图片不能串到聊天输入框');
 assert.equal(w.document.activeElement,w.document.querySelector('.askp-input'));
 w.document.querySelector('.askp-submit').click();const answer=sent.find(m=>m.type==='answerQuestion');
 assert.equal(answer.answers.q,'（见附图）');assert.equal(answer.images.q[0].data,'dGVzdA==');
 emit({kind:'question_answer_rejected',requestId:'image-q',message:'临时错误'});
 assert.equal(w.document.querySelectorAll('.askp-images img').length,1);assert.equal(w.document.querySelector('.askp-submit').disabled,false);
 w.document.querySelector('.askp-submit').click();emit({kind:'permission_resolved',requestId:'image-q',behavior:'allow'});
 assert.equal(w.document.querySelectorAll('.askq-card .msg-images img').length,1);assert.deepEqual(errors,[]);
});
test('选图读取期间翻题不会串题，拖入附件可删除，回填图片可替换',async t=>{
 const {w,sent,emit}=setup(t);
 emit({kind:'permission_request',requestId:'multi-image',toolName:'AskUserQuestion',input:{questions:[{id:'one',question:'图一',options:[]},{id:'two',question:'图二',options:[]}]},
 initialImages:{two:[{mediaType:'image/png',data:'b2xk'}]},suggestions:[]});
 const picker=w.document.querySelector('.askp input[type=file]');
 Object.defineProperty(picker,'files',{value:[new w.File(['first'],'one.png',{type:'image/png'})]});picker.dispatchEvent(new w.Event('change'));
 w.document.querySelectorAll('.askp-nav')[1].click();
 await imageReady(()=>w.document.querySelector('.askp-submit').textContent==='提交');
 assert.equal(w.document.querySelector('.askp-images img').src,'data:image/png;base64,b2xk');
 w.document.querySelector('.askp-images button').click();assert.equal(w.document.querySelector('.askp-submit').disabled,true);
 const drop=new w.Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{files:[new w.File(['second'],'two.png',{type:'image/png'})]}});
 w.document.querySelector('.askp').dispatchEvent(drop);await imageReady(()=>w.document.querySelector('.askp-images img'));
 w.document.querySelector('.askp-submit').click();const answer=sent.find(m=>m.type==='answerQuestion');
 assert.equal(answer.images.one[0].data,'Zmlyc3Q=');assert.equal(answer.images.two[0].data,'c2Vjb25k');
});
test('不支持的图片格式提示原因且不提交，私密问题不展示图片入口',async t=>{
 const {w,sent,emit}=setup(t);
 emit({kind:'permission_request',requestId:'bad-image',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'截图',options:[]}]},suggestions:[]});
 const picker=w.document.querySelector('.askp input[type=file]');Object.defineProperty(picker,'files',{value:[new w.File(['svg'],'file.svg',{type:'image/svg+xml'})]});
 picker.dispatchEvent(new w.Event('change'));await imageReady(()=>!w.document.querySelector('.askp-error').classList.contains('hidden'));
 assert.match(w.document.querySelector('.askp-error').textContent,/仅支持/);assert.equal(sent.some(m=>m.type==='answerQuestion'),false);
 emit({kind:'load_history',items:[],checkpoints:[]});
 emit({kind:'permission_request',requestId:'secret-image',toolName:'AskUserQuestion',input:{questions:[{id:'s',question:'密码',isSecret:true,options:[]}]},initialImages:{s:[{mediaType:'image/png',data:'aGVsbG8='}]},suggestions:[]});
 assert.equal(w.document.querySelector('.askp-add-image'),null);assert.equal(w.document.querySelector('.askp-images img'),null);
});
test('历史长回复按标题层级生成独立目录，忽略用户消息和代码中的伪标题',t=>{
 const {w,emit,errors}=setup(t);
 emit({kind:'load_history',sessionId:'outline',items:[
  {type:'user',text:'# 用户标题'},
  {type:'assistant_text',text:'## 原因\n内容\n### 细节\n内容\n```md\n# 代码里的标题\n```\n## 结论\n完成'},
  {type:'user',text:'第二问'},
  {type:'assistant_text',text:'## 原因\n第二条\n## 结论\n第二条结论'},
  {type:'user',text:'短回复'},
  {type:'assistant_text',text:'## 只有一个标题\n简短内容'},
 ],checkpoints:[]});
 const replies=w.document.querySelectorAll('.msg.assistant');
 assert.deepEqual([...replies[0].querySelectorAll('.reply-toc-item')].map(b=>b.textContent),['原因','细节','结论']);
 assert.equal(replies[0].querySelectorAll('.reply-toc-item')[1].style.getPropertyValue('--toc-depth'),'1');
 assert.deepEqual([...replies[1].querySelectorAll('.reply-toc-item')].map(b=>b.textContent),['原因','结论']);
 assert.equal(replies[2].querySelector('.reply-toc'),null);
 assert.equal(replies[0].querySelector('.reply-toc').open,false);
 assert.equal(replies[0].querySelector('.text-seg').classList.contains('summary-node'),false,'目录不能改变正文的时间线判定');
 w.dispatchEvent(new w.KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}));
 const find=w.document.querySelector('.find-input');find.value='细节';find.dispatchEvent(new w.Event('input'));
 assert.equal(w.document.querySelector('.find-count').textContent,'1 / 1','查找不应把目录标题重复计为正文命中');
 assert.equal(w.document.querySelector('.reply-toc mark'),null);
 assert.deepEqual(errors,[]);
});
test('流式目录保持展开、更新新增标题，正文重绘后仍跳到正确的同名标题且不自动拉回底部',async t=>{
 const {w,emit,errors}=setup(t),{messages,scroll,setHeight}=scrollFixture(w);
 emit({kind:'busy',busy:true});emit({kind:'block_start',blockType:'text'});
 emit({kind:'text_delta',text:'## 同名标题\n第一段\n## 同名标题\n第二段\n'});
 const toc=w.document.querySelector('.reply-toc');
 toc.querySelector('summary').click();assert.equal(toc.open,true);
 toc.querySelectorAll('button')[1].focus();
 toc.querySelector('nav').scrollTop=60;
 const oldHeading=w.document.querySelectorAll('.text-seg h2')[1];
 emit({kind:'text_delta',text:'## 测试结果\n通过\n'});
 await new Promise(r=>setTimeout(r,40));
 assert.equal(toc.open,true);assert.equal(toc.querySelectorAll('button').length,3);
 assert.equal(w.document.activeElement,toc.querySelectorAll('button')[1],'新增标题后保留正在操作的目录焦点');
 assert.equal(toc.querySelector('nav').scrollTop,60);
 assert.equal(oldHeading.isConnected,false);
 const headings=w.document.querySelectorAll('.text-seg h2');
 scroll(100);
 Object.defineProperty(toc,'offsetHeight',{get:()=>30});
 headings[1].getBoundingClientRect=()=>({top:600});
 toc.querySelectorAll('button')[1].click();
 assert.equal(toc.open,false);
 assert.equal(w.document.activeElement,headings[1]);
 assert.equal(messages.scrollTop,618);
 setHeight(2300);emit({kind:'text_delta',text:'后续仍在输出\n'});
 await new Promise(r=>setTimeout(r,40));
 assert.equal(messages.scrollTop,618);
 emit({kind:'result',isError:false,numTurns:1});
 assert.equal(w.document.querySelectorAll('.reply-toc').length,1);
 assert.equal(toc.querySelectorAll('button').length,3);
 assert.deepEqual(errors,[]);
});
test('目录可用 Escape 收起，回复快照删掉标题或切换会话时清理旧目录',t=>{
 const {w,emit}=setup(t);
 emit({kind:'busy',busy:true});emit({kind:'block_start',blockType:'text'});
 emit({kind:'text_delta',text:'## 一\n段落\n## 二\n段落\n'});
 const toc=w.document.querySelector('.reply-toc');toc.querySelector('summary').click();
 toc.querySelector('button').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.equal(toc.open,false);assert.equal(w.document.activeElement,toc.querySelector('summary'));
 emit({kind:'text_snap',text:'无标题的更正回复'});
 assert.equal(w.document.querySelector('.reply-toc'),null);
 emit({kind:'text_snap',text:'## 新标题一\n正文\n## 新标题二\n正文\n'});
 assert.equal(w.document.querySelectorAll('.reply-toc').length,1);
 emit({kind:'load_history',items:[],checkpoints:[]});
 assert.equal(w.document.querySelector('.reply-toc'),null);
});
test('从我的消息查看历史后，一键回到最新回复并恢复流式跟随',async t=>{
 const {w,emit,errors}=setup(t),{messages,scroll,setHeight}=scrollFixture(w);
 const button=w.document.querySelector('.jump-latest');
 assert.equal(button.classList.contains('hidden'),true);
 emit({kind:'load_history',sessionId:'history',items:[
  {type:'user',text:'早先的问题'},{type:'assistant_text',text:'早先的回复'},
  {type:'user',text:'最近的问题'},{type:'assistant_text',text:'最近的回复'},
 ],checkpoints:[]});
 const users=[...messages.querySelectorAll('.msg.user')];
 users.forEach(u=>{Object.defineProperty(u,'offsetParent',{get:()=>messages});u.getBoundingClientRect=()=>({bottom:-10});});
 users[0].scrollIntoView=()=>scroll(100);
 scroll(1400);
 w.document.querySelector('.qb-navbtn').click();
 w.document.querySelector('.msgnav-item').click();
 assert.equal(button.classList.contains('hidden'),false);
 emit({kind:'busy',busy:true});emit({kind:'block_start',blockType:'text'});
 setHeight(2300);emit({kind:'text_delta',text:'新的回复'});
 await new Promise(r=>setTimeout(r,40));
 assert.equal(messages.scrollTop,100,'阅读历史时新输出不能把视口拉走');
 w.document.querySelector('.qb-navbtn').click();
 button.click();
 assert.equal(messages.scrollTop,1700);
 assert.equal(button.classList.contains('hidden'),true);
 assert.equal(w.document.querySelector('.msgnav').classList.contains('hidden'),true);
 // 不派发 scroll，验证点击当下已恢复跟随，避免下一批输出抢在滚动事件之前。
 setHeight(2500);emit({kind:'text_delta',text:'，继续输出'});
 await new Promise(r=>setTimeout(r,40));
 assert.equal(messages.scrollTop,1900);
 assert.equal(button.classList.contains('hidden'),true);
 assert.deepEqual(errors,[]);
});
test('回到底部按钮适配输入区高度、手动滚到底部和切换空会话',t=>{
 const {w,emit,resize}=setup(t),{messages,scroll,setHeight,setViewport}=scrollFixture(w);
 const button=w.document.querySelector('.jump-latest'),composer=w.document.getElementById('composer');
 scroll(100);assert.equal(button.classList.contains('hidden'),false);
 Object.defineProperty(composer,'offsetHeight',{get:()=>350});resize(composer);
 assert.equal(button.style.bottom,'362px');
 assert.equal(messages.scrollTop,100);
 scroll(1400);assert.equal(button.classList.contains('hidden'),true);
 scroll(100);setHeight(400);setViewport(600);resize(messages);
 assert.equal(button.classList.contains('hidden'),true,'内容不足一屏时不显示');
 setHeight(2000);scroll(100);assert.equal(button.classList.contains('hidden'),false);
 setHeight(400);emit({kind:'load_history',items:[],checkpoints:[]});
 assert.equal(button.classList.contains('hidden'),true);
 assert.equal(w.document.querySelectorAll('.jump-latest').length,1);
});
test('打开的选择菜单随窗口缩窄重新定位，矮窗口限制在按钮上方',t=>{
 const {w}=setup(t);
 let width=1280,height=800;
 const composer=w.document.getElementById('composer');
 composer.getBoundingClientRect=()=>({left:0,right:width,width,bottom:height});
 for(const name of ['model','mode','speed']){
  const menu=w.document.getElementById(name+'-menu');
  const trigger=w.document.getElementById(name+'-trigger');
  Object.defineProperty(menu,'offsetParent',{get:()=>composer});
  Object.defineProperty(menu,'offsetWidth',{get:()=>Math.min(320,width-16)});
  trigger.getBoundingClientRect=()=>({left:Math.max(16,(width-660)/2+90),top:height-80});
  width=1280;height=800;trigger.click();
  width=320;height=280;w.dispatchEvent(new w.Event('resize'));
  const left=parseFloat(menu.style.left);
  const bottom=height-parseFloat(menu.style.bottom);
  const maxHeight=parseFloat(menu.style.getPropertyValue('--picker-available-height'));
  assert.ok(left>=8&&left+menu.offsetWidth<=width-8,name+' 菜单应保持在横向边界内');
  assert.ok(maxHeight>0&&bottom-maxHeight>=8,name+' 菜单顶部应留在窗口内');
  assert.ok(bottom<trigger.getBoundingClientRect().top,name+' 菜单不能遮挡触发按钮');
  w.document.getElementById('pick-backdrop').click();
 }
});
test('已打开的额度菜单随窗口缩窄保持在可见范围内',t=>{
 const {w,emit}=setup(t);
 let width=1280,height=800;
 const composer=w.document.getElementById('composer'),menu=w.document.getElementById('usage-menu');
 const trigger=w.document.getElementById('usage-pill');
 composer.getBoundingClientRect=()=>({left:0,right:width,width,bottom:height});
 Object.defineProperty(menu,'offsetParent',{get:()=>composer});
 Object.defineProperty(menu,'offsetWidth',{get:()=>Math.min(280,width-16)});
 trigger.getBoundingClientRect=()=>({right:width-70,top:height-80});
 emit({kind:'usage',weekPct:30});trigger.click();
 width=300;height=280;w.dispatchEvent(new w.Event('resize'));
 const right=width-parseFloat(menu.style.right);
 const bottom=height-parseFloat(menu.style.bottom);
 assert.ok(right<=width-8&&right-menu.offsetWidth>=8);
 assert.ok(bottom-parseFloat(menu.style.getPropertyValue('--picker-available-height'))>=8);
});
test('压缩清除并屏蔽静默警告，完成后保持忙碌且不提前发送队列',async t=>{
 const {w,sent,emit}=setup(t);
 emit({kind:'busy',busy:true});
 assert.match(w.document.querySelector('.wk-label').textContent,/等待 Codex 响应/);
 emit({kind:'response_wait',idleMs:35000});
 assert.ok(w.document.querySelector('.wk-wait'));
 emit({kind:'compacting'});
 assert.match(w.document.querySelector('.wk-label').textContent,/正在压缩上下文/);
 assert.equal(w.document.querySelector('.wk-wait'),null);
 emit({kind:'response_wait',idleMs:75000});
 assert.equal(w.document.querySelector('.wk-wait'),null);
 emit({kind:'response_wait',idleMs:85000});
 assert.equal(w.document.querySelectorAll('.wk-wait').length,0);
 const input=w.document.getElementById('input');input.value='下一项';
 w.document.getElementById('btn-send').click();
 emit({kind:'response_wait',idleMs:0});
 assert.equal(w.document.querySelector('.wk-wait'),null);
 emit({kind:'compacted',trigger:'auto',preTokens:0,postTokens:0});
 assert.match(w.document.querySelector('.wk-label').textContent,/上下文已压缩，等待继续回复/);
 await new Promise(r=>setTimeout(r,180));
 assert.equal(sent.some(e=>e.type==='send'),false);
 emit({kind:'block_start',blockType:'text'});
 emit({kind:'text_delta',text:'压缩后继续回复'});
 assert.match(w.document.querySelector('.wk-label').textContent,/正在回复/);
 emit({kind:'response_wait',idleMs:35000});
 assert.ok(w.document.querySelector('.wk-wait'),'压缩结束后恢复普通等待提示');
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
 assert.equal(w.document.querySelector('.wk-wait'),null);
 await new Promise(r=>setTimeout(r,180));
 assert.deepEqual(sent.filter(e=>e.type==='send').map(e=>e.text),['下一项']);
});
test('重试状态直接显示在回复处，等待用户时移除静默提示',t=>{
 const {w,emit}=setup(t);
 emit({kind:'busy',busy:true});
 emit({kind:'status',label:'Codex 正在重试请求…'});
 assert.match(w.document.querySelector('.wk-label').textContent,/正在重试/);
 emit({kind:'response_wait',idleMs:45000});
 emit({kind:'permission_request',requestId:'q',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'请选择',options:[{label:'A'}]}]},suggestions:[]});
 emit({kind:'response_wait',idleMs:75000});
 assert.equal(w.document.querySelector('.wk-wait'),null);
 assert.equal(w.document.querySelector('.working-pill'),null);
});
test('清空上下文或还原到开头后，持久化状态不再指向旧会话',t=>{
 const {emit,states}=setup(t);
 emit({kind:'session',sessionId:'old',model:'test',cwd:'/tmp'});
 assert.equal(states.at(-1).sessionId,'old');
 emit({kind:'load_history',items:[],checkpoints:[]});
 assert.equal(states.at(-1).sessionId,undefined);
 emit({kind:'load_history',sessionId:'branch',items:[],checkpoints:[]});
 assert.equal(states.at(-1).sessionId,'branch');
});
test('运行中切换设置失败只显示错误，任务和排队消息继续等待真实完成',async t=>{
 const {w,sent,emit}=setup(t);
 emit({kind:'busy',busy:true});
 const input=w.document.getElementById('input');input.value='下一项';
 w.document.getElementById('btn-send').click();
 emit({kind:'error',message:'当前模型不支持该速度',keepBusy:true});
 await new Promise(resolve=>setTimeout(resolve,180));
 assert.equal(sent.some(event=>event.type==='send'),false);
 assert.equal(w.document.querySelectorAll('.tq-row').length,1);
 assert.match(w.document.getElementById('messages').textContent,/不支持该速度/);
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
 await new Promise(resolve=>setTimeout(resolve,180));
 assert.deepEqual(sent.filter(event=>event.type==='send').map(event=>event.text),['下一项']);
});
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
test('调用代码链接在历史和流式回复中分离路径与行号',t=>{
 const {w,sent,emit,errors}=setup(t);
 const java='/Users/duodian/IdeaProjects/game-server/src/main/java/com/game/service/impl/PlugServiceImpl.java';
 const cases=[
  [java+':149',java,149,undefined],
  ['src/main.java:149-153','src/main.java',149,153],
  ['PlugServiceImpl.java:149','PlugServiceImpl.java',149,undefined],
  ['src/main.java:149:7','src/main.java',149,undefined],
  ['src/main.java#L149-L153','src/main.java',149,153],
  ['/tmp/a%20b.java:149','/tmp/a b.java',149,undefined],
  ['file:///tmp/a%20b.java:149','file:///tmp/a%20b.java',149,undefined],
 ];
 const text=cases.map(([href],i)=>`[调用代码${i}](${href})`).join(' ');
 for(const mode of ['history','stream']){
  emit({kind:'load_history',sessionId:mode,items:mode==='history'?[{type:'assistant_text',text}]:[],checkpoints:[]});
  if(mode==='stream'){emit({kind:'busy',busy:true});emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text});}
  const refs=[...w.document.querySelectorAll('.code-ref[data-action="open"]')];
  assert.equal(refs.length,cases.length,mode);
  sent.length=0;
  refs.forEach(e=>e.click());
  assert.deepEqual(sent.filter(m=>m.type==='openFile').map(m=>[m.path,m.line,m.endLine]),cases.map(c=>c.slice(1)),mode);
 }
 assert.deepEqual(errors,[]);
});
test('行内代码与正文中的本地文档路径可点击',t=>{const {w,sent,emit,errors}=setup(t);emit({kind:'load_history',sessionId:'paths',items:[{type:'assistant_text',text:'查看 `/tmp/Quarterly Report.pdf` 和 /tmp/qr.jpg'}],checkpoints:[]});const refs=[...w.document.querySelectorAll('.code-ref[data-action="open"]')];assert.deepEqual(refs.map(e=>e.dataset.path),['/tmp/Quarterly Report.pdf','/tmp/qr.jpg']);refs.forEach(e=>e.click());assert.deepEqual(sent.filter(m=>m.type==='openFile').map(m=>m.path),['/tmp/Quarterly Report.pdf','/tmp/qr.jpg']);assert.deepEqual(errors,[]);});
test('新推理档位可随模型列表显示并发送',t=>{const {w,sent,emit}=setup(t);emit({kind:'models',models:[{id:'future',name:'未来模型',description:'',efforts:['medium','future_level'],defaultEffort:'medium',isDefault:true}]});emit({kind:'config',model:'future',effort:'',permissionMode:'default'});w.document.getElementById('model-trigger').click();const option=w.document.querySelector('[data-effort="future_level"]');assert.ok(option);option.click();assert.ok(sent.some(m=>m.type==='setEffort'&&m.effort==='future_level'));});
test('推理强度按模型列出，支持 max/ultra 并可恢复默认',t=>{const {w,sent,emit,errors}=setup(t);emit({kind:'models',models:[{id:'gpt-6-sol',name:'GPT-6-Sol',description:'',efforts:['low','medium','high','xhigh','max','ultra'],defaultEffort:'medium',isDefault:true},{id:'gpt-5.5',name:'GPT-5.5',description:'',efforts:['low','medium','high','xhigh'],defaultEffort:'medium'}]});emit({kind:'config',model:'gpt-6-sol',effort:'high',permissionMode:'default'});w.document.getElementById('model-trigger').click();let menu=w.document.getElementById('model-menu');assert.equal(menu.querySelectorAll('[data-effort]').length,7);assert.equal(menu.querySelector('[data-effort="high"]').getAttribute('aria-pressed'),'true');menu.querySelector('[data-effort="ultra"]').click();assert.ok(sent.some(m=>m.type==='setEffort'&&m.effort==='ultra'));assert.equal(menu.querySelector('[data-effort="ultra"]').getAttribute('aria-pressed'),'true');emit({kind:'config',model:'gpt-5.5',effort:'',permissionMode:'default'});menu=w.document.getElementById('model-menu');assert.equal(menu.querySelectorAll('[data-effort]').length,5);assert.equal(menu.querySelector('[data-effort="ultra"]'),null);assert.match(menu.querySelector('[data-effort=""]').textContent,/默认.*中/);assert.deepEqual(errors,[]);});
test('提问卡片等待点击提交，按 ID 返回答案且遵守 isOther',t=>{const {w,sent,emit,errors}=setup(t);emit({kind:'permission_request',requestId:'17',toolName:'AskUserQuestion',input:{questions:[{id:'confirm',question:'是否继续？',header:'确认',isOther:false,options:[{label:'继续',description:'确认执行'},{label:'取消',description:'停止'}]}]},suggestions:[]});const picker=w.document.querySelector('.askp');assert.ok(picker);assert.equal(picker.querySelector('.askp-custom'),null);assert.equal(sent.some(m=>m.type==='answerQuestion'),false);picker.querySelector('.askp-opt').click();assert.equal(sent.some(m=>m.type==='answerQuestion'),false);picker.querySelector('.askp-submit').click();assert.ok(sent.some(m=>m.type==='answerQuestion'&&m.requestId==='17'&&m.answers.confirm==='继续'));assert.deepEqual(errors,[]);});
test('服务端取消提问时选项不可再提交',t=>{const {w,sent,emit}=setup(t);emit({kind:'permission_request',requestId:'18',toolName:'AskUserQuestion',input:{questions:[{id:'choice',question:'选择？',options:[{label:'A'}]}]},suggestions:[]});emit({kind:'permission_resolved',requestId:'18',behavior:'deny',auto:true});const picker=w.document.querySelector('.askp');assert.ok(picker.classList.contains('interaction-cancelled'));assert.ok([...picker.querySelectorAll('button, textarea')].every(x=>x.disabled));assert.equal(sent.some(m=>m.type==='answerQuestion'),false);});
test('派生点击立即加载、防重复、阶段更新和收尾均不干扰原会话',t=>{
 const {w,sent,emit,errors}=setup(t);
 emit({kind:'load_history',sessionId:'source',items:[{type:'user',text:'第一轮',images:[]},{type:'assistant_text',text:'答一'},{type:'user',text:'第二轮',images:[]},{type:'assistant_text',text:'答二'}],checkpoints:[{id:'cp1',userText:'第一轮',label:'第一轮'},{id:'cp2',userText:'第二轮',label:'第二轮'}]});
 const forks=w.document.querySelectorAll('.cp-fork');assert.equal(forks.length,1);
 emit({kind:'busy',busy:true});forks[0].click();forks[0].click();
 assert.equal(sent.filter(m=>m.type==='forkCheckpoint'&&m.checkpointId==='cp2').length,1);
 assert.equal(forks[0].disabled,true);
 assert.match(w.document.querySelector('.fork-progress').textContent,/等待确认/);
 assert.ok(w.document.querySelector('.fork-progress .hx-spin'));
 emit({kind:'forking',checkpointId:'cp2',busy:true,label:'正在创建独立会话…'});
 assert.match(w.document.querySelector('.fork-progress').textContent,/创建独立会话/);
 emit({kind:'text_delta',text:'原会话仍在继续'});
 assert.match(w.document.getElementById('messages').textContent,/原会话仍在继续/);
 emit({kind:'forking',checkpointId:'other',busy:false});
 assert.ok(w.document.querySelector('.fork-progress'));
 emit({kind:'forking',checkpointId:'cp2',busy:false});
 assert.equal(w.document.querySelector('.fork-progress'),null);assert.equal(forks[0].disabled,false);
 assert.deepEqual(errors,[]);
});

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

test('已提交问题卡收到还原点后可重新回答，按钮不会直接提交旧答案',t=>{
 const {w,sent,emit,errors}=setup(t);
 emit({kind:'busy',busy:true});
 emit({kind:'permission_request',requestId:'reanswer',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'安装来源',options:[]}]},suggestions:[]});
 const input=w.document.querySelector('.askp textarea');input.value='旧答案';input.dispatchEvent(new w.Event('input'));
 w.document.querySelector('.askp-submit').click();
 emit({kind:'permission_resolved',requestId:'reanswer',behavior:'allow'});
 emit({kind:'question_checkpoint',requestId:'reanswer',checkpointId:'answer-point'});
 emit({kind:'question_checkpoint',requestId:'reanswer',checkpointId:'answer-point'});
 assert.equal(w.document.querySelectorAll('.askq-reanswer').length,1);
 w.document.querySelector('.askq-reanswer').click();
 assert.equal(sent.at(-1).type,'reanswerQuestion');assert.equal(sent.at(-1).checkpointId,'answer-point');
 assert.equal(sent.filter(m=>m.type==='answerQuestion').length,1);
 assert.deepEqual(errors,[]);
});
test('历史结构化回答显示为可重新回答的卡片，不重复显示原问题或泄露秘密答案',t=>{
 const {w,sent,emit,errors}=setup(t);
 const prefix='用户已回答刚才的问题，请根据以下答案继续原任务：\n';
 const text=prefix+JSON.stringify([{question:'安装来源',answers:['A']},{question:'密码',isSecret:true,answers:['PRIVATE']}]);
 emit({kind:'load_history',sessionId:'source',items:[
  {type:'user',text:'原任务'},
  {type:'tool',toolId:'q',name:'AskUserQuestion',input:{questions:[{question:'安装来源'},{question:'密码'}]},result:'问题原始输出'},
  {type:'user',text},
 ],checkpoints:[{id:'turn:2',synthetic:true,userText:text,label:'回答'}]});
 assert.equal(w.document.querySelectorAll('.askq-card').length,1);
 assert.doesNotMatch(w.document.getElementById('messages').textContent,/PRIVATE|问题原始输出|用户已回答刚才的问题/);
 w.document.querySelector('.askq-reanswer').click();assert.equal(sent.at(-1).checkpointId,'turn:2');
 assert.deepEqual(errors,[]);
});
test('重新回答回填原选择和自由文本，必须主动提交，秘密答案始终留空',async t=>{
 const {w,sent,emit}=setup(t);emit({kind:'busy',busy:true});
 const composer=w.document.getElementById('input');composer.value='排队任务';w.document.getElementById('btn-send').click();
 emit({kind:'restoring'});emit({kind:'load_history',items:[],checkpoints:[]});emit({kind:'busy',busy:true});
 emit({kind:'permission_request',requestId:'restored-q',toolName:'AskUserQuestion',input:{questions:[
  {id:'choice',question:'来源',options:[{label:'A'},{label:'B'}]},
  {id:'text',question:'补充',options:[]},
  {id:'secret',question:'密码',isSecret:true,options:[]},
 ]},initialAnswers:{choice:'B',text:'原答案\n第二行',secret:'PRIVATE'},suggestions:[]});
 assert.match(w.document.querySelector('.askp-opt.on').textContent,/B/);
 w.document.querySelectorAll('.askp-nav')[1].click();
 assert.equal(w.document.querySelector('.askp textarea').value,'原答案\n第二行');
 w.document.querySelectorAll('.askp-nav')[1].click();
 assert.equal(w.document.querySelector('.askp input[type="password"]').value,'');
 assert.equal(w.document.querySelector('.askp-submit').disabled,true);
 await new Promise(r=>setTimeout(r,180));
 assert.equal(sent.some(m=>m.type==='answerQuestion'||m.type==='send'),false);
});
test('还原期间和还原失败后队列不自动发送，用户可撤回并主动续聊',async t=>{
 const {w,sent,emit,errors}=setup(t);const composer=w.document.getElementById('input');
 emit({kind:'busy',busy:true});composer.value='排队任务';w.document.getElementById('btn-send').click();
 emit({kind:'restoring'});emit({kind:'busy',busy:false});
 await new Promise(r=>setTimeout(r,180));assert.equal(sent.some(m=>m.type==='send'),false);
 emit({kind:'error',message:'还原失败'});emit({kind:'busy',busy:false});
 await new Promise(r=>setTimeout(r,180));assert.equal(sent.some(m=>m.type==='send'),false);
 assert.equal(w.document.querySelector('.restore-overlay'),null);
 assert.match(w.document.getElementById('messages').textContent,/排队消息已暂停/);
 w.document.querySelector('.tq-recall').click();w.document.getElementById('btn-send').click();
 assert.deepEqual(sent.filter(m=>m.type==='send').map(m=>m.text),['排队任务']);
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
function manualSeconds(w){
 let now=0,next=0;const intervals=new Map();
 Object.defineProperty(w.performance,'now',{value:()=>now});
 w.setInterval=f=>{intervals.set(++next,f);return next;};w.clearInterval=id=>intervals.delete(id);
 return seconds=>{now+=seconds*1000;[...intervals.values()].forEach(f=>f());};
}
test('思考片段、累计用时和最近静默分开呈现，短暂静默不提示失败重试',t=>{
 const {w,emit}=setup(t);const advance=manualSeconds(w);
 emit({kind:'busy',busy:true});advance(230);
 emit({kind:'block_start',blockType:'thinking'});
 emit({kind:'thinking_delta',text:'已收到的一段思考'});advance(1);
 emit({kind:'block_end'});advance(57);
 emit({kind:'response_wait',idleMs:57000});
 assert.equal(w.document.querySelector('.think-node').textContent,'思考片段');
 assert.equal(w.document.querySelector('.think-node').title,'已收到的一段思考');
 assert.equal(w.document.querySelector('.wk-time').textContent,'累计 4分48秒');
 assert.equal(w.document.querySelector('.wk-wait').textContent,'最近 57秒未收到新进展，仍在等待响应。');
 assert.doesNotMatch(w.document.querySelector('.wk-wait').textContent,/停止|重试|卡死/);
 emit({kind:'response_wait',idleMs:0});
 emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'回复继续'});
 assert.equal(w.document.querySelector('.wk-wait'),null);
 assert.match(w.document.querySelector('.wk-label').textContent,/正在回复/);
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
 emit({kind:'load_history',items:[{type:'thinking',text:'历史思考',secs:1}],checkpoints:[]});
 assert.equal(w.document.querySelector('.think-node').textContent,'思考片段');
});
test('回答问题后重建状态保留本轮累计用时，新一轮重新计时',t=>{
 const {w,emit}=setup(t);const advance=manualSeconds(w);
 emit({kind:'busy',busy:true});advance(65);
 emit({kind:'permission_request',requestId:'q-time',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'继续？',options:[]}]},suggestions:[]});
 assert.equal(w.document.querySelector('.working-pill'),null);
 advance(30);
 emit({kind:'permission_resolved',requestId:'q-time',behavior:'allow'});
 emit({kind:'busy',busy:true});
 assert.equal(w.document.querySelector('.wk-time').textContent,'累计 1分35秒');
 advance(5);assert.equal(w.document.querySelector('.wk-time').textContent,'累计 1分40秒');
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
 advance(10);emit({kind:'busy',busy:true});
 assert.equal(w.document.querySelector('.wk-time').textContent,'累计 0秒');
});
test('中途说明后长时间无新事件，状态与秒数持续显示，下一次思考及时接续',t=>{
 const {w,emit,errors}=setup(t);const advance=manualSeconds(w);const flush=manualFrames(w);
 emit({kind:'busy',busy:true});
 assert.match(w.document.querySelector('.wk-tokens').textContent,/待回传/);
 emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'首轮回归已通过，继续检查。'});flush();
 assert.match(w.document.querySelector('.wk-label').textContent,/正在回复/);
 advance(5);assert.equal(w.document.querySelector('.wk-time').textContent,'累计 5秒');
 emit({kind:'block_end'});
 assert.match(w.document.querySelector('.wk-label').textContent,/等待后续响应/);
 advance(60);assert.equal(w.document.querySelector('.wk-time').textContent,'累计 1分5秒');
 assert.match(w.document.querySelector('.wk-tokens').textContent,/≈.*tokens/);
 emit({kind:'block_start',blockType:'thinking'});advance(20);
 assert.equal(w.document.querySelector('.wk-time').textContent,'累计 1分25秒');
 emit({kind:'block_end'});assert.equal(w.document.querySelector('.think-node').textContent,'思考片段');
 assert.equal(w.document.querySelector('.msg-body').lastElementChild.className,'working-pill');
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});advance(10);
 assert.equal(w.document.querySelector('.working-pill'),null);assert.deepEqual(errors,[]);
});
test('文件工具等待期间也显示计时，重建状态保留已收到的思考 token',t=>{
 const {w,emit}=setup(t);const advance=manualSeconds(w);const flush=manualFrames(w);
 emit({kind:'busy',busy:true});emit({kind:'thinking_tokens',tokens:123});
 emit({kind:'tool_input',toolId:'read',name:'Read',input:{file_path:'/tmp/a.txt'}});
 advance(12);assert.equal(w.document.querySelector('.wk-time').textContent,'累计 12秒');
 assert.equal(w.document.querySelector('.wk-tokens').textContent,'123 tokens');
 flush();assert.equal(w.document.querySelector('.wk-tokens').textContent,'123 tokens');
 emit({kind:'tool_result',toolUseId:'read',content:'ok',isError:false});
 assert.equal(w.document.querySelector('.wk-tokens').textContent,'123 tokens');
});
test('等待用户、停止和错误后，迟到的块结束或计时器不会恢复运行状态',t=>{
 for(const ending of ['question','stop','error']){
  const {w,emit,errors}=setup(t);const advance=manualSeconds(w);
  emit({kind:'busy',busy:true});emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'阶段说明'});
  if(ending==='question')emit({kind:'permission_request',requestId:'q',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'继续？',options:[]}]},suggestions:[]});
  else if(ending==='stop')w.document.getElementById('btn-stop').click();
  else emit({kind:'error',message:'连接失败'});
  emit({kind:'block_end'});advance(60);
  assert.equal(w.document.querySelector('.working-pill'),null,ending);assert.deepEqual(errors,[]);
 }
});
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
