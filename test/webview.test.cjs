const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const source=fs.readFileSync('src/panel/chatViewProvider.ts','utf8');
function setup(t,sessionId){
 const section=source.slice(source.indexOf('  private html('));
 const raw=section.match(/return (?:\/\* html \*\/ )?`([\s\S]*?)`;\s*\n\s+}/)[1];
 const html=raw.replace(/\$\{[^}]+\}/g,'').replace(/<script[^>]*><\/script>/g,'');
 const sent=[],errors=[],states=[],resizeObservers=[];
 const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true,url:'https://webview.test/'});
 t.after(()=>dom.window.close());
 const w=dom.window; w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>states.at(-1)??{},setState:s=>states.push(JSON.parse(JSON.stringify(s)))});
 if(sessionId)w.document.body.dataset.sessionId=sessionId;
 w.ResizeObserver=class{constructor(callback){this.callback=callback;this.targets=[];resizeObservers.push(this);}observe(target){this.targets.push(target);}disconnect(){this.targets=[];}};
 w.IntersectionObserver=class{observe(){}disconnect(){}};
 w.HTMLElement.prototype.scrollIntoView=function(){};
 w.HTMLElement.prototype.scrollTo=function(){};
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 w.document.queryCommandSupported=()=>false;
 w.addEventListener('error',e=>errors.push(e.message));
 w.eval(fs.readFileSync('media/webview.js','utf8'));
 const emit=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 return {w,sent,errors,emit,states,resizeObservers,resize:target=>resizeObservers.filter(o=>o.targets.includes(target)).forEach(o=>o.callback())};
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
test('重载历史首屏直接显示恢复状态，失败可重试且草稿不丢失',t=>{
 const {w,sent,emit,states,errors}=setup(t,'restored');
 const input=w.document.getElementById('input'),send=w.document.getElementById('btn-send');
 assert.match(w.document.querySelector('.history-status').textContent,/正在恢复历史/);
 assert.equal(w.document.querySelector('.empty-state'),null);
 assert.deepEqual(states.at(-1),{sessionId:'restored'});
 input.value='等加载时先写草稿';input.dispatchEvent(new w.Event('input'));
 input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 assert.equal(send.disabled,true);assert.equal(sent.some(m=>m.type==='send'),false);
 assert.equal(input.value,'等加载时先写草稿');
 emit({kind:'history_status',sessionId:'restored',error:'暂时连接失败 <script>'});
 assert.equal(w.document.querySelector('.history-status').getAttribute('role'),'alert');
 assert.match(w.document.querySelector('.history-status').textContent,/<script>/);
 assert.equal(w.document.querySelector('.history-status script'),null);
 w.document.querySelector('.history-retry').click();
 assert.equal(sent.filter(m=>m.type==='reloadHistory').length,1);
 emit({kind:'load_history',sessionId:'restored',items:[{type:'user',text:'旧问题'},{type:'assistant_text',text:'旧回答'}],checkpoints:[]});
 assert.equal(w.document.querySelector('.history-status'),null);assert.equal(send.disabled,false);
 assert.equal(input.value,'等加载时先写草稿');
 send.click();assert.equal(sent.find(m=>m.type==='send').text,'等加载时先写草稿');
 assert.deepEqual(errors,[]);
});
test('新会话保留欢迎页，清空正在加载的历史也解除旧绑定',t=>{
 const {w,emit,states}=setup(t);
 assert.ok(w.document.querySelector('.empty-state'));
 emit({kind:'history_status',sessionId:'old'});
 assert.equal(w.document.querySelector('.empty-state'),null);
 emit({kind:'load_history',items:[],checkpoints:[]});
 assert.ok(w.document.querySelector('.empty-state'));assert.equal(w.document.querySelector('.history-status'),null);
 assert.deepEqual(states.at(-1),{});assert.equal(w.document.getElementById('btn-send').disabled,false);
});
test('工具密集历史按完整轮次限制首屏，逐批展开后消息和还原点完整且无重复',async t=>{
 const {w,emit,errors}=setup(t),items=[],checkpoints=[];
 for(let turn=0;turn<4;turn++){
  items.push({type:'user',text:`问题${turn}`});checkpoints.push({id:`cp${turn}`,label:`问题${turn}`,userText:`问题${turn}`});
  for(let n=0;n<65;n++)items.push({type:'tool',toolId:`tool${turn}-${n}`,name:'Bash',input:{command:'echo ok'},result:'ok'});
  items.push({type:'assistant_text',text:`回答${turn}`});
 }
 emit({kind:'load_history',sessionId:'dense',items,checkpoints});
 assert.equal(w.document.querySelectorAll('.msg.user').length,1);
 assert.equal(w.document.querySelectorAll('.tool-card').length,65);
 assert.equal(w.document.querySelector('.msg.user').dataset.checkpointId,'cp3');
 const latest=w.document.querySelector('.msg.user');
 for(let count=2;count<=4;count++){
  w.document.querySelector('.history-expand').click();
  await imageReady(()=>w.document.querySelectorAll('.msg.user').length===count);
  assert.equal(w.document.querySelectorAll('.tool-card').length,count*65);
 }
 assert.equal(w.document.querySelector('.history-expand'),null);
 assert.deepEqual([...w.document.querySelectorAll('.msg.user')].map(n=>n.dataset.checkpointId),['cp0','cp1','cp2','cp3']);
 assert.equal(w.document.querySelectorAll('.msg.user')[3],latest,'展开旧历史不重绘最近消息');
 assert.deepEqual(errors,[]);
});
test('超长单轮保持完整，轻量历史仍显示最近二十轮',t=>{
 const {w,emit}=setup(t),items=[{type:'user',text:'完整一轮'}];
 for(let i=0;i<130;i++)items.push({type:'assistant_text',text:`片段${i}`});
 emit({kind:'load_history',sessionId:'one',items,checkpoints:[]});
 assert.equal(w.document.querySelectorAll('.text-seg').length,130);
 assert.equal(w.document.querySelector('.history-expand'),null);
 emit({kind:'load_history',sessionId:'many',items:Array.from({length:25},(_,i)=>[{type:'user',text:`问题${i}`},{type:'assistant_text',text:`回答${i}`}]).flat(),checkpoints:[]});
 assert.equal(w.document.querySelectorAll('.msg.user').length,20);
 assert.ok(w.document.querySelector('.history-expand'));
});
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
test('回复标题正常显示但不再占用目录空间',t=>{
 const {w,emit,errors}=setup(t);
 emit({kind:'load_history',sessionId:'no-outline',items:[
  {type:'user',text:'解释一下'},
  {type:'assistant_text',text:'## 原因\n内容\n### 细节\n说明\n## 结论\n完成'},
 ],checkpoints:[]});
 assert.deepEqual([...w.document.querySelectorAll('.msg.assistant .text-seg h2')].map(h=>h.textContent),['原因','结论']);
 assert.equal(w.document.querySelector('.reply-toc'),null);
 assert.deepEqual(errors,[]);
});
test('常用工具实时默认折叠、点击整行展开，完成后保留手动状态',t=>{
 const {w,emit,errors}=setup(t);
 emit({kind:'tool_input',toolId:'bash',name:'Bash',input:{command:'echo hello\necho world',description:'检查输出'}});
 const bash=w.document.querySelector('.tool-card[data-tool-id="bash"]');
 const toggle=bash.querySelector('.tool-toggle');
 assert.equal(bash.classList.contains('collapsed'),true);
 assert.equal(toggle.getAttribute('aria-expanded'),'false');
 assert.equal(bash.querySelector('.tool-sub').textContent,'检查输出');
 toggle.click();assert.equal(bash.classList.contains('collapsed'),false);
 emit({kind:'tool_result',toolUseId:'bash',content:'hello\nworld',isError:false});
 assert.equal(bash.classList.contains('collapsed'),false,'手动展开在完成后保持');
 assert.match(bash.querySelector('.tool-meta').textContent,/2 行/);
 toggle.click();assert.equal(bash.classList.contains('collapsed'),true);
 assert.equal(toggle.tagName,'BUTTON');
 emit({kind:'tool_input',toolId:'search',name:'WebSearch',input:{query:'索引优化'}});
 emit({kind:'tool_result',toolUseId:'search',content:'Links: [{"title":"结果","url":"https://example.com"}]',isError:false});
 const search=w.document.querySelector('.tool-card[data-tool-id="search"]');
 assert.equal(search.classList.contains('collapsed'),true);
 assert.equal(search.querySelector('.tool-sub').textContent,'索引优化');
 assert.match(search.querySelector('.tool-meta').textContent,/1 条/);
 search.querySelector('.tool-toggle').click();
 assert.equal(search.querySelectorAll('.search-hit').length,1);
 assert.deepEqual(errors,[]);
});
test('历史工具和报错默认折叠，待确认工具仍展开',t=>{
 const {w,emit,errors}=setup(t);
 emit({kind:'load_history',items:[
  {type:'user',text:'检查'},
  {type:'tool',toolId:'old',name:'Bash',input:{command:'echo old'},result:'old',isError:false},
  {type:'tool',toolId:'failed',name:'Bash',input:{command:'exit 1'},result:'失败原因',isError:true},
 ],checkpoints:[]});
 assert.equal(w.document.querySelector('.tool-card[data-tool-id="old"]').classList.contains('collapsed'),true);
 const failed=w.document.querySelector('.tool-card[data-tool-id="failed"]');
 assert.equal(failed.classList.contains('collapsed'),true);
 assert.match(failed.querySelector('.tool-why').textContent,/失败/);
 failed.querySelector('.tool-toggle').click();
 assert.match(failed.querySelector('.tool-result-body').textContent,/失败原因/);
 emit({kind:'permission_request',requestId:'approval',toolName:'Bash',input:{command:'rm demo'},suggestions:[]});
 const approval=w.document.querySelector('.tool-card[data-tool-id="approval"]');
 assert.equal(approval.classList.contains('collapsed'),false);
 assert.ok(approval.querySelector('.perm-bar'));
 assert.deepEqual(errors,[]);
});
test('两次 Bash 就成组，思考事件不占行且每条命令可继续展开',t=>{
 const {w,emit,errors}=setup(t);
 emit({kind:'tool_input',toolId:'b1',name:'Bash',input:{command:'echo 1'}});
 emit({kind:'tool_result',toolUseId:'b1',content:'1',isError:false});
 emit({kind:'block_start',blockType:'thinking'});
 emit({kind:'thinking_delta',text:'检查下一步'});
 emit({kind:'block_end'});
 emit({kind:'tool_input',toolId:'b2',name:'Bash',input:{command:'echo 2'}});
 emit({kind:'tool_result',toolUseId:'b2',content:'2',isError:false});
 const group=w.document.querySelector('.tool-group-step');
 assert.ok(group,'两次调用就合并');
 assert.equal(group.querySelector('.tool-group-count').textContent,'2 次');
 emit({kind:'tool_input',toolId:'b3',name:'Bash',input:{command:'echo 3'}});
 assert.equal(group.classList.contains('collapsed'),true);
 assert.equal(group.querySelector('.tool-group-count').textContent,'3 次');
 const items=[...group.querySelector('.tool-group-items').children];
 assert.deepEqual(items.map(item=>item.querySelector('.tool-sub').textContent),['echo 1','echo 2','echo 3']);
 assert.equal(w.document.querySelector('.think-node'),null);
 group.querySelector('.tool-group-toggle').click();
 assert.equal(group.classList.contains('collapsed'),false);
 const child=group.querySelector('.tool-card[data-tool-id="b2"]');
 assert.equal(child.classList.contains('collapsed'),true);
 child.querySelector('.tool-toggle').click();
 assert.equal(child.classList.contains('collapsed'),false);
 emit({kind:'tool_result',toolUseId:'b3',content:'3',isError:false});
 assert.match(group.querySelector('.tool-group-status').textContent,/3 完成/);
 emit({kind:'tool_input',toolId:'b4',name:'Bash',input:{command:'echo 4'}});
 assert.equal(group.querySelectorAll('.tool-group-items > .foldable-step').length,4);
 assert.equal(group.classList.contains('collapsed'),false,'继续执行不覆盖手动展开');
 emit({kind:'block_start',blockType:'thinking'});
 emit({kind:'block_end'});
 assert.equal(w.document.querySelector('.think-node'),null);
 emit({kind:'tool_input',toolId:'b5',name:'Bash',input:{command:'echo 5'}});
 assert.equal(group.querySelectorAll('.tool-group-items > .foldable-step').length,5);
 assert.deepEqual(errors,[]);
});
test('任意不同工具连续两次立即合并，第三种工具继续加入同一组',t=>{
 for(const names of [
  ['Bash','WebSearch','mcp__example__lookup'],
  ['Read','Grep','Glob'],
  ['Skill','Agent','TodoWrite'],
  ['mcp__example__first','mcp__example__second','future-tool'],
 ]){
  const {w,emit,errors}=setup(t);
  names.forEach((name,index)=>{
   emit({kind:'tool_input',toolId:'any'+index,name,input:{command:'echo ok',query:'资料',file_path:'/project/a.ts',pattern:'test',skill:'test',todos:[]}});
   if(index===0){
    assert.equal(w.document.querySelector('.tool-group-step'),null);
    emit({kind:'tool_result',toolUseId:'any0',content:'ok',isError:false});
   }else{
    const groups=w.document.querySelectorAll('.tool-group-step');
    assert.equal(groups.length,1);
    assert.equal(w.document.querySelectorAll('.msg-body > .step').length,1);
    assert.equal(groups[0].querySelectorAll('.tool-card').length,index+1,'第二次调用即合并，无需同类工具重复');
    assert.equal(groups[0].classList.contains('collapsed'),true);
    assert.match(groups[0].querySelector('.tool-group-status').textContent,/1 完成/);
   }
  });
  assert.deepEqual([...w.document.querySelectorAll('.tool-group-items .tool-card')].map(card=>card.dataset.toolName),names);
  assert.deepEqual(errors,[]);
 }
});
test('历史中的读取、搜索、技能和自定义工具连续合并，交互问题仍可直接回答',t=>{
 const {w,emit,errors}=setup(t);
 const names=['Read','Grep','Glob','Skill','Agent','TodoWrite','mcp__example__lookup','Bash','WebSearch'];
 emit({kind:'load_history',items:[{type:'user',text:'检查项目'},...names.map((name,index)=>({type:'tool',toolId:'all-history'+index,name,input:{file_path:'/project/a.ts',skill:'test',pattern:'test',command:'echo ok',query:'资料'},result:'ok',isError:false}))],checkpoints:[]});
 const group=w.document.querySelector('.tool-group-step');
 assert.equal(w.document.querySelectorAll('.msg-body > .step').length,1);
 assert.deepEqual([...group.querySelectorAll('.tool-card')].map(card=>card.dataset.toolName),names);
 assert.match(group.querySelector('.tool-group-status').textContent,/9 完成/);
 assert.equal(group.classList.contains('collapsed'),true);
 emit({kind:'permission_request',requestId:'all-question',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'选择方案',options:[{label:'方案一'},{label:'方案二'}]}]},suggestions:[]});
 const question=w.document.querySelector('.askp');
 assert.ok(question);
 assert.equal(question.closest('.tool-group-step'),null);
 emit({kind:'tool_input',toolId:'after-question1',name:'Read',input:{file_path:'/project/b.ts'}});
 emit({kind:'tool_input',toolId:'after-question2',name:'mcp__example__lookup',input:{query:'核对'}});
 assert.equal(w.document.querySelectorAll('.tool-group-step').length,2);
 assert.deepEqual(errors,[]);
});
test('历史已回答问题独立显示，前后的工具分别合组',t=>{
 const {w,emit,errors}=setup(t);
 emit({kind:'load_history',items:[
  {type:'user',text:'检查历史问答边界'},
  {type:'tool',toolId:'before-q1',name:'Read',input:{file_path:'/project/a.ts'},result:'a',isError:false},
  {type:'tool',toolId:'before-q2',name:'Bash',input:{command:'echo before'},result:'before',isError:false},
  {type:'tool',toolId:'answered-q',name:'AskUserQuestion',input:{questions:[{question:'选择方案',options:[{label:'A'}]}]},result:'"选择方案" = "A"',isError:false},
  {type:'tool',toolId:'after-q1',name:'Bash',input:{command:'echo after'},result:'after',isError:false},
  {type:'tool',toolId:'after-q2',name:'Read',input:{file_path:'/project/b.ts'},result:'b',isError:false},
 ],checkpoints:[]});
 const question=w.document.querySelector('.askq-card');
 assert.equal(question.closest('.tool-group-step'),null);
 assert.equal(question.dataset.toolName,'AskUserQuestion');
 assert.match(question.textContent,/选择方案.*A/);
 const groups=[...w.document.querySelectorAll('.tool-group-step')];
 assert.equal(groups.length,2);
 assert.deepEqual(groups.map(group=>[...group.querySelectorAll('.tool-card')].map(card=>card.dataset.toolId)),[['before-q1','before-q2'],['after-q1','after-q2']]);
 assert.ok(groups.every(group=>group.querySelector('.tool-group-count').textContent.startsWith('2 次')));
 assert.deepEqual(errors,[]);
});
test('原生计划更新已完成调用，步骤进行中样式保留，轮次结束不残留执行中摘要',t=>{
 const {w,emit,errors}=setup(t);
 const {CodexProcess}=require('../dist/test/codex/process.js');
 const p=new CodexProcess({codexPath:'/unused',cwd:process.cwd(),permissionMode:'default'},
  {emit,onPermission:()=>{},onSessionId:()=>{},onClose:()=>{}});
 t.after(()=>p.dispose());
 p.busy=true;emit({kind:'busy',busy:true});
 p.notification({method:'turn/plan/updated',params:{plan:[{step:'检查项目',status:'in_progress'}]}});
 const plan=w.document.querySelector('[data-tool-id="plan"]');
 assert.ok(plan.querySelector('.todo-item.doing'),'计划步骤继续显示进行中');
 assert.equal(plan.classList.contains('running'),false,'更新计划操作本身已经完成');
 const command={id:'plan-bash',type:'commandExecution',command:'echo ok',aggregatedOutput:'ok',exitCode:0};
 p.notification({method:'item/started',params:{item:command}});
 p.notification({method:'item/completed',params:{item:command}});
 const group=plan.closest('.tool-group-step');
 assert.equal(group.querySelector('.tool-group-status').textContent,'2 完成');
 p.notification({method:'turn/plan/updated',params:{plan:[{step:'检查项目',status:'completed'}]}});
 assert.equal(plan.querySelector('.todo-item.doing'),null);
 assert.ok(plan.querySelector('.todo-item.done'));
 p.notification({method:'turn/completed',params:{turn:{id:'plan-turn',status:'completed'}}});
 assert.equal(group.querySelector('.tool-group-status').textContent,'2 完成');
 assert.equal(group.querySelector('.running'),null);
 assert.deepEqual(errors,[]);
});
test('交错的 Bash 和文件修改合成一组，正文断开，末尾两次 Bash 也合并',t=>{
 const {w,emit,errors}=setup(t);
 const names=['Bash','Bash','Edit','Bash','Bash','Edit','Write'];
 names.forEach((name,index)=>emit({kind:'tool_input',toolId:'mix'+index,name,
  input:name==='Bash'?{command:'echo '+index}:{file_path:'/project/a.ts',old_string:'a',new_string:'b',content:'b'}}));
 const first=w.document.querySelector('.tool-group-step');
 assert.ok(first);
 assert.equal(first.dataset.groupKind,'mixed');
 assert.equal(first.classList.contains('collapsed'),true);
 assert.equal(first.querySelector('.tool-name').textContent,'工具调用');
 assert.equal(first.querySelector('.tool-group-count').textContent,'7 次 · 4 Bash · 3 文件修改');
 first.querySelector('.tool-group-toggle').click();
 assert.deepEqual([...first.querySelectorAll('.tool-group-items > .step .tool-name')].map(el=>el.textContent),names);
 first.querySelector('.tool-group-toggle').click();
 emit({kind:'tool_result',toolUseId:'mix3',content:'未找到匹配',isError:true});
 assert.equal(first.classList.contains('collapsed'),true);
 assert.match(first.querySelector('.tool-group-status').textContent,/1 失败/);
 emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'下一步'});
 emit({kind:'tool_input',toolId:'tail1',name:'Bash',input:{command:'echo tail1'}});
 emit({kind:'tool_input',toolId:'tail2',name:'Bash',input:{command:'echo tail2'}});
 const groups=w.document.querySelectorAll('.tool-group-step');
 assert.equal(groups.length,2);
 assert.equal(groups[1].dataset.groupKind,'bash');
 assert.equal(groups[1].querySelector('.tool-group-count').textContent,'2 次');
 emit({kind:'load_history',items:[
  {type:'user',text:'历史操作'},
  {type:'tool',toolId:'past-bash',name:'Bash',input:{command:'echo old'},result:'old',isError:false},
  {type:'tool',toolId:'past-edit',name:'Edit',input:{file_path:'/project/a.ts',old_string:'a',new_string:'b'},result:'ok',isError:false},
 ],checkpoints:[]});
 const historical=w.document.querySelector('.tool-group-step');
 assert.equal(historical.dataset.groupKind,'mixed');
 assert.equal(historical.querySelector('.tool-group-count').textContent,'2 次 · 1 Bash · 1 文件修改');
 assert.deepEqual(errors,[]);
});
test('网页搜索与 Bash 交错调用合为一组，保留结果、错误和手动展开状态',t=>{
 const {w,emit,errors}=setup(t);
 const names=['WebSearch','WebSearch','Bash','WebSearch','WebSearch'];
 names.forEach((name,index)=>{
  emit({kind:'tool_input',toolId:'web-mix'+index,name,input:name==='Bash'?{command:'echo verify'}:{query:'官方说明 '+index}});
  emit({kind:'tool_result',toolUseId:'web-mix'+index,content:index===3?'搜索失败':name==='Bash'?'verify':'Links: [{"title":"官方说明","url":"https://example.com/docs"}]',isError:index===3});
 });
 const group=w.document.querySelector('.tool-group-step');
 assert.equal(w.document.querySelectorAll('.msg-body > .step').length,1);
 assert.equal(group.querySelector('.tool-name').textContent,'工具调用');
 assert.equal(group.querySelector('.tool-group-count').textContent,'5 次 · 1 Bash · 4 网页检索');
 assert.equal(group.classList.contains('collapsed'),true);
 assert.match(group.querySelector('.tool-group-status').textContent,/4 完成 · 1 失败/);
 group.querySelector('.tool-group-toggle').click();
 assert.deepEqual([...group.querySelectorAll('.tool-card')].map(card=>card.dataset.toolName),names);
 const search=group.querySelector('[data-tool-id="web-mix0"]');
 search.querySelector('.tool-toggle').click();
 assert.equal(search.querySelector('.search-hit').href,'https://example.com/docs');
 assert.equal(group.querySelector('[data-tool-id="web-mix2"] .tool-sub').textContent,'echo verify');
 const failed=group.querySelector('[data-tool-id="web-mix3"]');
 failed.querySelector('.tool-toggle').click();
 assert.match(failed.querySelector('.tool-result-body').textContent,/搜索失败/);
 emit({kind:'tool_input',toolId:'web-fetch',name:'WebFetch',input:{url:'https://example.com/docs'}});
 assert.equal(group.classList.contains('collapsed'),false);
 assert.equal(group.querySelector('.tool-group-count').textContent,'6 次 · 1 Bash · 5 网页检索');
 emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'核对结果'});
 for(let i=0;i<2;i++)emit({kind:'tool_input',toolId:'web-tail'+i,name:i?'WebFetch':'WebSearch',input:{query:'继续',url:'https://example.com'}});
 const tail=w.document.querySelectorAll('.tool-group-step')[1];
 assert.equal(tail.dataset.groupKind,'web');
 assert.equal(tail.querySelector('.tool-name').textContent,'网页检索');
 assert.equal(tail.querySelector('.tool-group-count').textContent,'2 次');
 assert.equal(tail.classList.contains('edit'),false);
 assert.deepEqual(errors,[]);
});
test('历史搜索、网页读取、Bash 与修改按原顺序合并，正文分隔分组',t=>{
 const {w,emit,errors}=setup(t);
 emit({kind:'load_history',items:[
  {type:'user',text:'核对资料并修改'},
  {type:'tool',toolId:'history-search',name:'WebSearch',input:{query:'资料'},result:'Links: [{"title":"资料","url":"https://example.com"}]',isError:false},
  {type:'thinking',text:'继续检查'},
  {type:'tool',toolId:'history-fetch',name:'WebFetch',input:{url:'https://example.com'},result:'网页正文',isError:false},
  {type:'tool',toolId:'history-bash',name:'Bash',input:{command:'echo checked'},result:'checked',isError:false},
  {type:'tool',toolId:'history-edit',name:'Edit',input:{file_path:'/project/a.ts',old_string:'a',new_string:'b'},result:'ok',isError:false},
  {type:'assistant_text',text:'修改完成，再次核对'},
  {type:'tool',toolId:'history-tail1',name:'WebSearch',input:{query:'核对'},result:'结果',isError:false},
  {type:'tool',toolId:'history-tail2',name:'WebFetch',input:{url:'https://example.com'},result:'网页结果',isError:false},
 ],checkpoints:[]});
 const groups=w.document.querySelectorAll('.tool-group-step');
 assert.equal(groups.length,2);
 assert.equal(groups[0].querySelector('.tool-group-count').textContent,'4 次 · 1 Bash · 1 文件修改 · 2 网页检索');
 assert.deepEqual([...groups[0].querySelectorAll('.tool-card')].map(card=>card.dataset.toolId),['history-search','history-fetch','history-bash','history-edit']);
 assert.equal(groups[0].classList.contains('collapsed'),true);
 assert.equal(groups[1].dataset.groupKind,'web');
 assert.match(groups[1].querySelector('.tool-group-status').textContent,/2 完成/);
 assert.deepEqual(errors,[]);
});
test('搜索加入混合组后到达的审批仍独立显示，前后工具按顺序重新分组',t=>{
 const {w,emit,errors}=setup(t);
 for(const [index,name] of ['Bash','WebSearch','WebFetch','Bash'].entries()){
  emit({kind:'tool_input',toolId:'web-approval'+index,name,input:{command:'echo ok',query:'资料',url:'https://example.com'}});
 }
 emit({kind:'permission_request',requestId:'approve-web',toolUseId:'web-approval1',toolName:'WebSearch',input:{query:'资料'},suggestions:[]});
 const approval=w.document.querySelector('[data-tool-id="web-approval1"]');
 assert.equal(approval.closest('.tool-group-step'),null);
 assert.equal(approval.classList.contains('collapsed'),false);
 assert.ok(approval.querySelector('.perm-bar'));
 assert.equal(w.document.querySelector('[data-tool-id="web-approval0"]').closest('.tool-group-step'),null);
 const group=w.document.querySelector('.tool-group-step');
 assert.equal(group.querySelector('.tool-group-count').textContent,'2 次 · 1 Bash · 1 网页检索');
 assert.deepEqual([...group.querySelectorAll('.tool-card')].map(card=>card.dataset.toolId),['web-approval2','web-approval3']);
 assert.deepEqual(errors,[]);
});
test('读取工具继续加入 Bash 组，正文断开，失败保留在组内而待确认独立显示',t=>{
 const {w,emit,errors}=setup(t);
 for(let i=1;i<=3;i++)emit({kind:'tool_input',toolId:'first'+i,name:'Bash',input:{command:'echo '+i}});
 const first=w.document.querySelector('.tool-group-step');
 assert.ok(first);
 emit({kind:'tool_result',toolUseId:'first2',content:'命令失败',isError:true});
 const failed=w.document.querySelector('.tool-card[data-tool-id="first2"]');
 assert.equal(failed.closest('.tool-group-step'),first);
 assert.equal(first.classList.contains('collapsed'),true);
 assert.equal(failed.classList.contains('collapsed'),true);
 assert.match(first.querySelector('.tool-group-status').textContent,/1 失败/);
 first.querySelector('.tool-group-toggle').click();
 failed.querySelector('.tool-toggle').click();
 assert.match(failed.querySelector('.tool-result-body').textContent,/命令失败/);
 first.querySelector('.tool-group-toggle').click();
 emit({kind:'tool_result',toolUseId:'first1',content:'1',isError:false});
 assert.equal(first.classList.contains('collapsed'),true);
 emit({kind:'tool_input',toolId:'read',name:'Read',input:{file_path:'/project/a.ts'}});
 emit({kind:'tool_input',toolId:'lone',name:'Bash',input:{command:'echo alone'}});
 assert.equal(w.document.querySelector('.tool-card[data-tool-id="lone"]').closest('.tool-group-step'),first);
 assert.equal(first.querySelector('.tool-group-count').textContent,'5 次 · 4 Bash · 1 其他工具');
 emit({kind:'block_start',blockType:'text'});
 emit({kind:'text_delta',text:'这是正文'});
 for(let i=1;i<=3;i++)emit({kind:'tool_input',toolId:'next'+i,name:'Bash',input:{command:'echo next'+i}});
 const groups=w.document.querySelectorAll('.tool-group-step');
 assert.equal(groups.length,2);
 const second=groups[1];
 assert.equal(second.querySelectorAll('.tool-group-items > .foldable-step').length,3);
 emit({kind:'permission_request',requestId:'approval-in-group',toolUseId:'next3',toolName:'Bash',input:{command:'echo next3'},suggestions:[]});
 const approval=w.document.querySelector('.tool-card[data-tool-id="next3"]');
 assert.equal(approval.closest('.tool-group-step'),null);
 assert.equal(approval.classList.contains('collapsed'),false);
 assert.equal(w.document.querySelectorAll('.tool-group-step').length,2);
 assert.ok(approval.querySelector('.perm-bar'));
 assert.deepEqual(errors,[]);
});
test('组中途失败只更新摘要，实时和历史都保留可点开的错误详情',t=>{
 const {w,emit,errors}=setup(t);
 for(let i=1;i<=7;i++)emit({kind:'tool_input',toolId:'b'+i,name:'Bash',input:{command:'echo '+i}});
 emit({kind:'tool_result',toolUseId:'b4',content:'sed: file not found',isError:true});
 const groups=w.document.querySelectorAll('.tool-group-step');
 assert.equal(groups.length,1);
 assert.equal(groups[0].classList.contains('collapsed'),true);
 assert.equal(groups[0].querySelectorAll('.tool-group-items > .step').length,7);
 assert.match(groups[0].querySelector('.tool-group-status').textContent,/1 失败/);
 const failed=w.document.querySelector('.tool-card[data-tool-id="b4"]');
 assert.equal(failed.closest('.tool-group-step'),groups[0]);
 assert.equal(failed.classList.contains('collapsed'),true);
 groups[0].querySelector('.tool-group-toggle').click();
 failed.querySelector('.tool-toggle').click();
 assert.match(failed.querySelector('.tool-result-body').textContent,/sed: file not found/);
 emit({kind:'load_history',items:[
  {type:'user',text:'检查错误'},
  ...Array.from({length:7},(_,index)=>({type:'tool',toolId:'h'+index,name:'Bash',input:{command:'echo '+index},result:index===3?'历史失败':'ok',isError:index===3})),
 ],checkpoints:[]});
 const historical=w.document.querySelector('.tool-card[data-tool-id="h3"]');
 assert.ok(historical.closest('.tool-group-step'));
 assert.equal(historical.classList.contains('collapsed'),true);
 assert.match(historical.querySelector('.tool-result-body').textContent,/历史失败/);
 assert.equal(w.document.querySelectorAll('.tool-group-step').length,1);
 assert.deepEqual(errors,[]);
});
test('历史回放按原顺序分组，最后一个折叠组仍是时间线终点',t=>{
 const {w,emit,errors}=setup(t);
 emit({kind:'load_history',items:[
  {type:'user',text:'执行检查'},
  {type:'thinking',text:'先看情况'},
  {type:'tool',toolId:'h1',name:'Bash',input:{command:'echo one'},result:'one',isError:false},
  {type:'thinking',text:'继续'},
  {type:'tool',toolId:'h2',name:'Bash',input:{command:'echo two'},result:'two',isError:false},
  {type:'tool',toolId:'h3',name:'Bash',input:{command:'echo three'},result:'three',isError:false},
 ],checkpoints:[]});
 const group=w.document.querySelector('.tool-group-step');
 assert.ok(group);
 assert.equal(group.classList.contains('collapsed'),true);
 assert.equal(group.querySelectorAll('.tool-group-items > .foldable-step').length,3);
 const body=w.document.querySelector('.msg.assistant .msg-body');
 assert.equal([...body.children].filter(el=>el.classList.contains('step')).length,1);
 assert.equal(body.querySelector('.think-node'),null);
 assert.deepEqual(errors,[]);
});
test('两次文件修改就成组，保留每个文件的差异入口',t=>{
 const {w,emit,sent,errors}=setup(t);
 emit({kind:'tool_input',toolId:'e1',name:'Edit',input:{file_path:'/project/src/a.ts',old_string:'a',new_string:'b'}});
 emit({kind:'tool_result',toolUseId:'e1',content:'ok',isError:false});
 emit({kind:'tool_input',toolId:'e2',name:'Edit',input:{file_path:'/project/src/a.ts',old_string:'b',new_string:'c'}});
 emit({kind:'tool_result',toolUseId:'e2',content:'ok',isError:false});
 const group=w.document.querySelector('.tool-group-step[data-group-kind="edit"]');
 assert.ok(group,'两次修改就合并');
 assert.match(group.querySelector('.tool-group-count').textContent,/2 次/);
 emit({kind:'tool_input',toolId:'e3',name:'Write',input:{file_path:'/project/src/b.ts',content:'new'}});
 emit({kind:'tool_result',toolUseId:'e3',content:'ok',isError:false});
 assert.equal(group.classList.contains('collapsed'),true);
 assert.match(group.querySelector('.tool-group-count').textContent,/3 次 · 2 文件/);
 assert.match(group.querySelector('.tool-group-status').textContent,/3 完成/);
 group.querySelector('.tool-group-toggle').click();
 assert.deepEqual([...group.querySelectorAll('.tool-group-items > .step .tool-name')].map(el=>el.textContent),['Edit','Edit','Write']);
 group.querySelector('.tool-card[data-tool-id="e3"] .file-chip').click();
 assert.ok(sent.some(m=>m.type==='openDiff' && m.path==='/project/src/b.ts'));
 assert.deepEqual(errors,[]);
});
test('读取加入编辑组，正文断开，失败详情默认收起，待确认独立显示',t=>{
 const {w,emit,errors}=setup(t);
 for(let i=1;i<=3;i++)emit({kind:'tool_input',toolId:'edit'+i,name:'Edit',input:{file_path:'/project/a.ts',old_string:'a',new_string:String(i)}});
 const first=w.document.querySelector('.tool-group-step[data-group-kind="edit"]');
 assert.ok(first);
 assert.match(first.querySelector('.tool-group-count').textContent,/3 次 · .*a\.ts/);
 emit({kind:'tool_result',toolUseId:'edit2',content:'修改失败',isError:true});
 const failed=w.document.querySelector('.tool-card[data-tool-id="edit2"]');
 assert.equal(failed.closest('.tool-group-step'),first);
 assert.equal(first.classList.contains('collapsed'),true);
 assert.equal(failed.classList.contains('error-details-collapsed'),true);
 first.querySelector('.tool-group-toggle').click();
 failed.querySelector('.tool-error-toggle').click();
 assert.equal(failed.classList.contains('error-details-collapsed'),false);
 assert.match(failed.querySelector('.tool-result-body').textContent,/修改失败/);
 failed.querySelector('.tool-error-toggle').click();
 assert.equal(failed.classList.contains('error-details-collapsed'),true);
 emit({kind:'tool_input',toolId:'read',name:'Read',input:{file_path:'/project/a.ts'}});
 emit({kind:'tool_input',toolId:'single',name:'Edit',input:{file_path:'/project/b.ts',old_string:'a',new_string:'b'}});
 assert.equal(w.document.querySelector('.tool-card[data-tool-id="single"]').closest('.tool-group-step'),first);
 assert.equal(first.querySelector('.tool-group-count').textContent,'5 次 · 4 文件修改 · 1 其他工具');
 emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'继续修改'});
 for(let i=1;i<=3;i++)emit({kind:'tool_input',toolId:'later'+i,name:'MultiEdit',input:{file_path:'/project/c.ts',edits:[{old_string:'a',new_string:'b'}]}});
 const groups=w.document.querySelectorAll('.tool-group-step');
 assert.equal(groups.length,2);
 emit({kind:'permission_request',requestId:'edit-approval',toolUseId:'later3',toolName:'MultiEdit',input:{file_path:'/project/c.ts'},suggestions:[]});
 const approval=w.document.querySelector('.tool-card[data-tool-id="later3"]');
 assert.equal(approval.closest('.tool-group-step'),null);
 assert.ok(approval.querySelector('.perm-bar'));
 assert.deepEqual(errors,[]);
});
test('历史文件修改回放会分组，思考记录不再生成空白节点',t=>{
 const {w,emit,errors}=setup(t);
 emit({kind:'load_history',items:[
  {type:'user',text:'修改文件'},
  {type:'tool',toolId:'old-edit1',name:'Edit',input:{file_path:'/project/a.ts',old_string:'a',new_string:'b'},result:'ok',isError:false},
  {type:'thinking',text:'继续修改'},
  {type:'tool',toolId:'old-edit2',name:'Edit',input:{file_path:'/project/a.ts',old_string:'b',new_string:'c'},result:'ok',isError:false},
  {type:'tool',toolId:'old-edit3',name:'Write',input:{file_path:'/project/b.ts',content:'new'},result:'ok',isError:false},
 ],checkpoints:[]});
 const group=w.document.querySelector('.tool-group-step[data-group-kind="edit"]');
 assert.ok(group);
 assert.equal(group.classList.contains('collapsed'),true);
 assert.match(group.querySelector('.tool-group-count').textContent,/3 次 · 2 文件/);
 assert.equal(group.querySelectorAll('.tool-group-items > .step').length,3);
 assert.equal(w.document.querySelector('.think-node'),null);
 assert.deepEqual(errors,[]);
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
 const flush=manualFrames(w);
 const button=w.document.querySelector('.jump-latest'),composer=w.document.getElementById('composer');
 scroll(100);assert.equal(button.classList.contains('hidden'),false);
 Object.defineProperty(composer,'offsetHeight',{get:()=>350});resize(composer);flush();
 assert.equal(button.style.bottom,'362px');
 assert.equal(messages.scrollTop,100);
 scroll(1400);assert.equal(button.classList.contains('hidden'),true);
 scroll(100);setHeight(400);setViewport(600);resize(messages);flush();
 assert.equal(button.classList.contains('hidden'),true,'内容不足一屏时不显示');
 setHeight(2000);scroll(100);assert.equal(button.classList.contains('hidden'),false);
 setHeight(400);emit({kind:'load_history',items:[],checkpoints:[]});
 assert.equal(button.classList.contains('hidden'),true);
 assert.equal(w.document.querySelectorAll('.jump-latest').length,1);
});
test('阅读历史时中间事件不跳底，完整回复结束后才提示有新回复',async t=>{
 const {w,emit,errors}=setup(t),{messages,scroll,setHeight}=scrollFixture(w);
 const button=w.document.querySelector('.jump-latest');
 const badge=button.querySelector('.jump-new-reply');
 scroll(100);
 emit({kind:'busy',busy:true});
 emit({kind:'block_start',blockType:'tool_use',toolId:'tool-1',toolName:'Bash'});
 emit({kind:'permission_request',requestId:'req-1',toolUseId:'tool-1',toolName:'Bash',input:{},suggestions:[]});
 emit({kind:'compacted',trigger:'auto',preTokens:1000,postTokens:500});
 emit({kind:'notice',message:'仍在处理中'});
 emit({kind:'block_start',blockType:'text'});
 emit({kind:'text_delta',text:'部分 agent 回复'});
 setHeight(2300);
 await new Promise(r=>setTimeout(r,40));
 assert.equal(messages.scrollTop,100);
 assert.equal(badge.classList.contains('hidden'),true,'中间输出不算完整回复');
 emit({kind:'block_end'});
 assert.equal(badge.classList.contains('hidden'),true);
 emit({kind:'result',isError:false,numTurns:1});
 assert.equal(messages.scrollTop,100);
 assert.equal(badge.classList.contains('hidden'),false);
 assert.equal(badge.textContent,'有新回复');
 button.click();
 assert.equal(messages.scrollTop,1700);
 assert.equal(badge.classList.contains('hidden'),true);
 assert.deepEqual(errors,[]);
});
test('向上滚轮进入阅读状态后，小幅离开底部也不被流式更新拉回',async t=>{
 const {w,emit}=setup(t),{messages,scroll,setHeight}=scrollFixture(w);
 messages.dispatchEvent(new w.WheelEvent('wheel',{deltaY:-25,bubbles:true}));
 scroll(1360); // 只离开底部 40px，仍在旧的自动跟随阈值内
 emit({kind:'busy',busy:true});
 emit({kind:'block_start',blockType:'text'});
 setHeight(2300);
 emit({kind:'text_delta',text:'新内容'});
 await new Promise(r=>setTimeout(r,40));
 assert.equal(messages.scrollTop,1360);
 emit({kind:'result',isError:false});
 assert.equal(w.document.querySelector('.jump-new-reply').classList.contains('hidden'),false);
 scroll(1700);
 assert.equal(w.document.querySelector('.jump-new-reply').classList.contains('hidden'),true);
});
test('打开的选择菜单随窗口缩窄重新定位，矮窗口限制在按钮上方',t=>{
 const {w}=setup(t);
 let width=1280,height=800;
 const composer=w.document.getElementById('composer');
 composer.getBoundingClientRect=()=>({left:0,right:width,width,bottom:height});
 for(const name of ['model','mode','effort']){
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
test('子问题按来源展示且只接受文字，回答保留根任务计时',t=>{
 const {w,emit}=setup(t);
 let now=1000;Object.defineProperty(w.performance,'now',{value:()=>now});
 emit({kind:'busy',busy:true});
 const start=w.document.querySelector('.working-pill').dataset.start;
 now=60000;
 emit({kind:'permission_request',requestId:'child-q',toolName:'AskUserQuestion',agentLabel:'子任务 检查',input:{questions:[{id:'q',question:'继续检查？',options:[{label:'继续'}]}]},suggestions:[]});
 assert.match(w.document.querySelector('.askp-q').textContent,/子任务 检查/);
 assert.equal(w.document.querySelector('.askp input[type=file]'),null);
 emit({kind:'permission_resolved',requestId:'child-q',behavior:'allow'});
 assert.equal(w.document.querySelector('.working-pill').dataset.start,start);
});
test('真实命令或子 Agent 活动清除静默提示，子工具标明来源',t=>{
 const {w,emit,errors}=setup(t);
 emit({kind:'busy',busy:true});
 emit({kind:'tool_input',toolId:'child:cmd',name:'Bash',agentLabel:'子 Agent <测试>',input:{command:'echo ready'}});
 assert.equal(w.document.querySelector('.tool-name').textContent,'Bash · 子 Agent <测试>');
 assert.equal(w.document.querySelector('.tool-name 测试'),null);
 emit({kind:'response_wait',idleMs:50000});
 assert.ok(w.document.querySelector('.wk-wait'));
 emit({kind:'activity',label:'收到命令输出'});
 assert.equal(w.document.querySelector('.wk-wait'),null);
 assert.match(w.document.querySelector('.wk-progress').textContent,/收到命令输出/);
 assert.deepEqual(errors,[]);
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

test('准备阶段停止后显示还原入口，原文和上下文可完整取回，不回滚已有对话',t=>{
 const {w,sent,emit,errors}=setup(t),input=w.document.getElementById('input');
 emit({kind:'load_history',items:[{type:'user',text:'上一轮'},{type:'assistant_text',text:'已有回答'}],checkpoints:[]});
 emit({kind:'context_added',label:'选中代码',text:'const original = 1;'});
 input.value='终止的消息\n第二行';w.document.getElementById('btn-send').click();
 const request=sent.find(m=>m.type==='send');
 w.document.getElementById('btn-stop').click();
 assert.equal(w.document.querySelector('.cp-restore'),null,'宿主确认之前不能假装可还原');
 emit({kind:'send_cancelled',sendId:request.sendId});emit({kind:'busy',busy:false});
 emit({kind:'send_cancelled',sendId:request.sendId});
 assert.equal(w.document.querySelectorAll('.cp-restore').length,1);
 assert.equal(w.document.querySelector('.cp-fork'),null,'未发送消息没有服务端派生点');
 input.value='保留新草稿';w.document.querySelector('.cp-restore').click();
 assert.equal(input.value,'终止的消息\n第二行\n\n保留新草稿');
 assert.deepEqual([...w.document.querySelectorAll('.msg.user')].map(m=>m.dataset.rawText),['上一轮']);
 assert.match(w.document.getElementById('messages').textContent,/已有回答/);
 assert.equal(sent.some(m=>m.type==='restoreCheckpoint'),false);
 w.document.getElementById('btn-send').click();
 assert.match(sent.filter(m=>m.type==='send').at(-1).context,/const original = 1/);
 assert.deepEqual(errors,[]);
});

test('终止消息之后已有实际轮次，还原使用其真实检查点并恢复被终止的原文',t=>{
 const {w,sent,emit,errors}=setup(t),input=w.document.getElementById('input');
 input.value='未发送的原文';w.document.getElementById('btn-send').click();
 const first=sent.find(m=>m.type==='send');
 emit({kind:'send_cancelled',sendId:first.sendId});emit({kind:'busy',busy:false});
 input.value='后来的消息';w.document.getElementById('btn-send').click();
 const second=sent.filter(m=>m.type==='send').at(-1);
 emit({kind:'checkpoint_marker',checkpointId:'actual-cp',userText:second.text,sendId:second.sendId});
 emit({kind:'busy',busy:false});
 w.document.querySelector('.cp-restore').click();
 assert.equal(sent.at(-1).type,'restoreCheckpoint');assert.equal(sent.at(-1).checkpointId,'actual-cp');
 assert.equal(sent.at(-1).draft.text,'未发送的原文');
 assert.equal(w.document.querySelectorAll('.msg.user').length,2,'必须等宿主成功回滚才删界面');
 assert.deepEqual(errors,[]);
});

test('仅图片消息在准备阶段终止后，还原保留原图片和文件附件',t=>{
 const {w,sent,emit,errors}=setup(t);
 const images=[{mediaType:'image/png',data:'iVBORw0KGgo='}];
 emit({kind:'draft',text:'',images,files:['/tmp/original.ts']});
 w.document.getElementById('btn-send').click();
 const first=sent.find(m=>m.type==='send');
 w.document.getElementById('btn-stop').click();
 emit({kind:'send_cancelled',sendId:first.sendId});emit({kind:'busy',busy:false});
 w.document.querySelector('.cp-restore').click();
 assert.equal(w.document.querySelectorAll('.msg.user').length,0);
 w.document.getElementById('btn-send').click();
 const second=sent.filter(m=>m.type==='send').at(-1);
 assert.deepEqual(JSON.parse(JSON.stringify(second.images)),images);
 assert.deepEqual([...second.files],['/tmp/original.ts']);
 assert.deepEqual(errors,[]);
});

test('真实还原点和过期的取消回执按发送身份处理，不重复或挂错消息',t=>{
 const {w,sent,emit,errors}=setup(t),input=w.document.getElementById('input');
 input.value='相同内容';w.document.getElementById('btn-send').click();
 const first=sent.find(m=>m.type==='send');
 emit({kind:'checkpoint_marker',checkpointId:'cp',userText:first.text,sendId:first.sendId});
 emit({kind:'send_cancelled',sendId:first.sendId});emit({kind:'busy',busy:false});
 assert.equal(w.document.querySelectorAll('.cp-restore').length,1);
 input.value='相同内容';w.document.getElementById('btn-send').click();
 emit({kind:'checkpoint_marker',checkpointId:'stale',userText:first.text,sendId:first.sendId});
 assert.equal(w.document.querySelectorAll('.cp-restore').length,1);
 emit({kind:'load_history',items:[],checkpoints:[]});
 emit({kind:'send_cancelled',sendId:sent.filter(m=>m.type==='send').at(-1).sendId});
 assert.equal(w.document.querySelector('.cp-restore'),null);
 assert.deepEqual(errors,[]);
});
test('排队消息可撤回到输入框，保留换行、图片、附件和已有草稿',t=>{const {w,sent,emit,errors}=setup(t);const input=w.document.getElementById('input');emit({kind:'busy',busy:true});emit({kind:'context_added',label:'选中代码',text:'const n = 1'});emit({kind:'attach_files',paths:['/tmp/example.ts']});emit({kind:'draft',text:'',images:[{mediaType:'image/png',data:'aGVsbG8='}]});input.value='第一行\n  缩进第二行\n\n末行  ';w.document.getElementById('btn-send').click();const queue=w.document.getElementById('task-queue');assert.equal(queue.querySelectorAll('.tq-row').length,1);assert.equal(sent.some(m=>m.type==='send'),false);input.value='已有草稿';queue.querySelector('.tq-recall').click();assert.equal(input.value,'第一行\n  缩进第二行\n\n末行  \n\n已有草稿');assert.equal(queue.querySelectorAll('.tq-row').length,0);assert.equal(w.document.activeElement,input);assert.match(w.document.getElementById('context-chips').textContent,/选中代码/);assert.match(w.document.getElementById('file-chips').textContent,/example.ts/);assert.equal(w.document.querySelectorAll('#image-previews .img-preview').length,1);assert.ok(sent.some(m=>m.type==='draft'&&m.text===input.value));assert.deepEqual(errors,[]);});
test('排队图片缩略图与文字同一行，最多两张并显示余量，撤回保留全部图片',t=>{
 const {w,sent,emit,errors}=setup(t),input=w.document.getElementById('input');
 emit({kind:'busy',busy:true});
 emit({kind:'draft',text:'',images:[1,2,3,4].map(n=>({mediaType:'image/png',data:Buffer.from(`image${n}`).toString('base64')}))});
 input.value='带图排队消息';w.document.getElementById('btn-send').click();
 const row=w.document.querySelector('#task-queue .tq-row');
 assert.deepEqual([...row.children].map(node=>node.className),['tq-idx','tq-images','tq-text','tq-recall','tq-del']);
 assert.equal(row.querySelectorAll('.tq-image img').length,2);
 assert.equal(row.querySelector('.tq-image-extra').textContent,'+2');
 assert.match(row.querySelector('.tq-image img').src,/^data:image\/png;base64,/);
 row.querySelector('.tq-image').click();
 assert.equal(w.document.getElementById('lightbox').classList.contains('hidden'),false);
 assert.equal(w.document.querySelectorAll('#task-queue .tq-row').length,1,'查看缩略图不改变队列');
 row.querySelector('.tq-recall').click();
 assert.equal(w.document.querySelectorAll('#image-previews .img-preview').length,4);
 assert.equal(input.value,'带图排队消息');
 assert.equal(sent.some(m=>m.type==='send'),false);
 assert.deepEqual(errors,[]);
});
test('撤回指定排队消息不影响其他排队消息',t=>{const {w,sent,emit}=setup(t);const input=w.document.getElementById('input');emit({kind:'busy',busy:true});for(const text of ['第一条','第二条']){input.value=text;w.document.getElementById('btn-send').click();}const queue=w.document.getElementById('task-queue');queue.querySelectorAll('.tq-recall')[1].click();assert.equal(input.value,'第二条');assert.equal(queue.querySelectorAll('.tq-row').length,1);assert.match(queue.textContent,/第一条/);assert.equal(sent.some(m=>m.type==='send'),false);});
test('快照跳过清单可逐项排除、全部排除或忽略提醒',t=>{const {w,sent,emit,errors}=setup(t);const files=[{path:'/tmp/p/.DS_Store',rel:'.DS_Store',reason:'二进制'},{path:'/tmp/p/media/icon.png',rel:'media/icon.png',reason:'二进制'}];emit({kind:'snapshot_skips',files,total:2});let card=w.document.querySelector('.snapshot-skips');assert.ok(card);assert.equal(card.querySelectorAll('.ss-row').length,2);card.querySelector('.ss-row .ss-action').click();assert.ok(sent.some(m=>m.type==='excludeSnapshotPaths'&&m.paths?.[0]===files[0].path));emit({kind:'snapshot_exclude_result',ok:true,message:'已排除',paths:[files[0].path]});card=w.document.querySelector('.snapshot-skips');assert.equal(card.querySelectorAll('.ss-row').length,1);card.querySelector('.ss-actions .ss-action').click();assert.ok(sent.some(m=>m.type==='excludeSnapshotPaths'&&m.all===true));emit({kind:'snapshot_exclude_result',ok:true,message:'已排除',paths:[files[1].path]});assert.equal(w.document.querySelector('.snapshot-skips'),null);emit({kind:'snapshot_skips',files,total:2});w.document.querySelectorAll('.ss-actions .ss-action')[1].click();assert.equal(w.document.querySelector('.snapshot-skips'),null);assert.deepEqual(errors,[]);});
test('只有周额度时显示已用百分比、每周限额、重置时间和实际套餐',t=>{const {w,emit,errors}=setup(t);emit({kind:'usage',weekPct:93,weekResetAt:1790754733,planType:'pro'});const pill=w.document.getElementById('usage-pill');assert.match(pill.textContent,/周.*93%/);assert.doesNotMatch(pill.textContent,/会话/);pill.click();const menu=w.document.getElementById('usage-menu');assert.match(menu.querySelector('.usage-head').textContent,/每周限额 · ChatGPT Pro 200/);assert.match(menu.querySelector('.usage-metric').textContent,/已使用93%/);assert.doesNotMatch(menu.textContent,/套餐用量|全部模型/);assert.match(menu.textContent,/\d+月\d+日 \d{2}:\d{2} 重置/);assert.doesNotMatch(menu.textContent,/5 小时/);assert.equal(menu.querySelector('.usage-bar span').style.width,'93%');emit({kind:'speed_context',billing:'chatgpt',planType:'prolite'});assert.match(menu.querySelector('.usage-head').textContent,/ChatGPT Pro 100/);emit({kind:'speed_context',billing:'chatgpt',planType:'promax'});assert.match(menu.querySelector('.usage-head').textContent,/ChatGPT Pro 500/);emit({kind:'speed_context',billing:'chatgpt',planType:'plus'});assert.match(menu.textContent,/ChatGPT Plus/);emit({kind:'speed_context',billing:'api'});assert.doesNotMatch(menu.textContent,/ChatGPT Plus/);assert.deepEqual(errors,[]);});
test('重置时间在左，额度和百分比相邻；重置卡列出各自有效期并保留有限详情',t=>{
 const {w,emit,errors}=setup(t),now=Math.floor(Date.now()/1000);
 emit({kind:'usage',weekPct:93,weekResetAt:now+86400,resetCredits:{availableCount:3,cards:[
  {title:'首张',expiresAt:now+3600},{title:'<img src=x>',expiresAt:now+10*86400}
 ]}});
 w.document.getElementById('usage-pill').click();
 const menu=w.document.getElementById('usage-menu'),top=menu.querySelector('.usage-row-top');
 assert.equal(top.children[0].className,'usage-reset');
 assert.equal(top.children[1].className,'usage-metric');
 assert.match(top.children[1].textContent,/已使用93%/);
 assert.match(menu.textContent,/可用 3 张/);
 assert.equal(menu.querySelectorAll('.usage-credit').length,2);
 assert.match(menu.querySelector('.usage-credit').textContent,/首张.*到期/);
 assert.ok(menu.querySelector('.usage-credit').classList.contains('urgent'));
 assert.match(menu.textContent,/另有 1 张未返回有效期/);
 assert.equal(menu.querySelectorAll('img').length,0);
 emit({kind:'usage',weekPct:94});assert.equal(menu.querySelectorAll('.usage-credit').length,2,'推送额度更新不抹掉卡片明细');
 emit({kind:'usage',weekPct:94,resetCredits:{availableCount:2,cards:null}});assert.match(menu.textContent,/可用 2 张/);assert.match(menu.textContent,/接口暂未返回逐张有效期/);
 emit({kind:'usage',weekPct:94,resetCredits:{availableCount:0,cards:[]}});assert.match(menu.textContent,/暂无可用重置卡/);
 emit({kind:'usage',weekPct:94,resetCredits:null});assert.equal(menu.querySelectorAll('.usage-credit').length,0);
 assert.deepEqual(errors,[]);
});
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
test('模型选择器每个系列仅保留最新版本，中文介绍不挤占空间',t=>{
 const {w,emit,sent,errors}=setup(t);
 const model=(id,description='English model description')=>({id,name:id.toUpperCase(),description,efforts:['low','medium','high'],defaultEffort:'medium',speedModes:['default','fast']});
 emit({kind:'models',models:[
  model('gpt-6-sol'),model('gpt-6.1-sol'),model('gpt-5.6-sol'),
  model('gpt-6-astra'),model('gpt-6-luna'),model('gpt-5.6-luna'),model('gpt-5.6-terra'),
  model('gpt-5.9-codex'),model('gpt-5.10-codex-2026-01-01'),model('gpt-5.10-codex'),
  model('custom','自定义中文介绍'),model('another-custom'),
 ]});
 // 已选旧模型仍使用自身能力，不能悄悄切换到新版本。
 emit({kind:'config',model:'gpt-6-sol',effort:'high',permissionMode:'default'});
 w.document.getElementById('model-trigger').click();
 const menu=w.document.getElementById('model-menu');
 assert.deepEqual([...menu.querySelectorAll('[data-model]')].map(e=>e.dataset.model),['','gpt-6.1-sol','gpt-6-astra','gpt-6-luna','gpt-5.6-terra','gpt-5.10-codex','custom','another-custom']);
 assert.doesNotMatch(menu.textContent,/English|普通可选|快速可选|未提供/);
 assert.equal(menu.querySelector('.pick-tag'),null);
 assert.match(menu.textContent,/自定义中文介绍/);
 assert.equal(w.document.getElementById('model-label').textContent,'GPT-6-SOL');
 assert.equal(menu.querySelector('[data-effort]'),null);
 assert.equal(w.document.getElementById('effort-label').textContent,'high');
 assert.equal(sent.filter(m=>m.type==='setModel').length,0);
 menu.querySelector('[data-model="gpt-6.1-sol"]').click();
 assert.ok(sent.some(m=>m.type==='setModel'&&m.model==='gpt-6.1-sol'));
 assert.deepEqual(errors,[]);
});
test('模型命令支持默认别名和完整目录中的旧模型，菜单保持精简',t=>{
 const {w,emit,sent,errors}=setup(t);
 const model=(id,name)=>({id,name,description:'',efforts:['low','medium','high'],defaultEffort:'medium'});
 emit({kind:'models',models:[model('gpt-5.6-sol','GPT-5.6 Sol'),model('gpt-6.1-sol','GPT-6.1 Sol')]});
 const command=text=>{
  const input=w.document.getElementById('input');
  input.value=text;input.dispatchEvent(new w.Event('input'));
  w.document.getElementById('btn-send').click();
 };
 command('/model gpt-5.6-sol');
 assert.equal(w.document.getElementById('model-label').textContent,'默认模型');
 emit({kind:'config',model:'gpt-5.6-sol',effort:'medium',permissionMode:'default'});
 assert.equal(w.document.getElementById('model-label').textContent,'GPT-5.6 Sol');
 command('/model gpt-5.6 sol');
 assert.equal(w.document.getElementById('model-label').textContent,'GPT-5.6 Sol');
 command('/model 默认');
 emit({kind:'config',model:'',effort:'medium',permissionMode:'default'});
 assert.equal(w.document.getElementById('model-label').textContent,'默认模型');
 assert.deepEqual(sent.filter(m=>m.type==='setModel').map(m=>m.model),['gpt-5.6-sol','']);
 assert.doesNotMatch(w.document.getElementById('messages').textContent,/未知模型/);
 w.document.getElementById('model-trigger').click();
 assert.deepEqual([...w.document.querySelectorAll('#model-menu [data-model]')].map(e=>e.dataset.model),['','gpt-6.1-sol']);
 assert.deepEqual(errors,[]);
});
test('推理程度单行短横条支持悬停说明，直接选中模型默认档位',t=>{
 const {w,emit,sent}=setup(t);
 emit({kind:'models',models:[{id:'gpt-6.1-sol',name:'GPT-6.1-Sol',description:'',efforts:['low','medium','high','xhigh','max','ultra'],defaultEffort:'medium',isDefault:true}]});
 emit({kind:'config',model:'gpt-6.1-sol',effort:'high',permissionMode:'default'});
 w.document.getElementById('effort-trigger').click();
 const menu=w.document.getElementById('effort-menu');
 assert.equal(menu.querySelectorAll('.pick-effort .effort-options [data-effort]').length,6);
 assert.equal(menu.querySelector('[data-effort=""]'),null);
 assert.equal(menu.querySelectorAll('.effort-option.filled').length,3);
 for(const option of menu.querySelectorAll('[data-effort]')){
  assert.equal(option.querySelector('.effort-caption').textContent,option.dataset.effort);
  assert.ok(option.title.startsWith(option.dataset.effort+'：'));
  assert.equal(option.getAttribute('aria-label'),option.title);
  assert.ok(option.querySelector('.effort-bar'));
 }
 menu.querySelector('[data-effort="ultra"]').click();
 assert.equal(w.document.getElementById('effort-label').textContent,'high');
 emit({kind:'config',model:'gpt-6.1-sol',effort:'ultra',permissionMode:'default'});
 assert.equal(menu.querySelector('.effort-current').textContent,'推理程度 · ultra');
 assert.equal(menu.querySelectorAll('.effort-option.filled').length,6);
 menu.querySelector('[data-effort="medium"]').click();
 emit({kind:'config',model:'gpt-6.1-sol',effort:'medium',permissionMode:'default'});
 assert.equal(menu.querySelector('.effort-current').textContent,'推理程度 · medium');
 assert.equal(menu.querySelectorAll('.effort-option.filled').length,2);
 assert.ok(sent.some(m=>m.type==='setEffort'&&m.effort==='medium'));
 emit({kind:'config',model:'gpt-6.1-sol',effort:'',permissionMode:'default'});
 assert.equal(menu.querySelector('.effort-current').textContent,'推理程度 · medium');
 assert.equal(menu.querySelector('[data-effort="medium"]').getAttribute('aria-pressed'),'true');
 assert.equal(menu.querySelectorAll('.effort-option.on').length,1);
 assert.equal(menu.querySelectorAll('.effort-option.filled').length,2);
 assert.equal(sent.some(m=>m.type==='setEffort'&&m.effort===''),false);
});
test('新推理档位可随模型列表显示并发送',t=>{const {w,sent,emit}=setup(t);emit({kind:'models',models:[{id:'future',name:'未来模型',description:'',efforts:['medium','future_level'],defaultEffort:'medium',isDefault:true}]});emit({kind:'config',model:'future',effort:'',permissionMode:'default'});w.document.getElementById('effort-trigger').click();const option=w.document.querySelector('[data-effort="future_level"]');assert.ok(option);option.click();assert.ok(sent.some(m=>m.type==='setEffort'&&m.effort==='future_level'));});
test('推理强度按模型列出，支持 max/ultra 并随模型选中默认档位',t=>{
 const {w,sent,emit,errors}=setup(t);
 emit({kind:'models',models:[{id:'gpt-6-sol',name:'GPT-6-Sol',description:'',efforts:['low','medium','high','xhigh','max','ultra'],defaultEffort:'medium',isDefault:true},{id:'gpt-5.5',name:'GPT-5.5',description:'',efforts:['low','medium','high','xhigh'],defaultEffort:'high'}]});
 emit({kind:'config',model:'gpt-6-sol',effort:'high',permissionMode:'default'});
 w.document.getElementById('effort-trigger').click();
 const menu=w.document.getElementById('effort-menu');
 assert.equal(menu.querySelectorAll('[data-effort]').length,6);
 assert.equal(menu.querySelector('[data-effort="high"]').getAttribute('aria-pressed'),'true');
 menu.querySelector('[data-effort="ultra"]').click();
 assert.ok(sent.some(m=>m.type==='setEffort'&&m.effort==='ultra'));
 emit({kind:'config',model:'gpt-6-sol',effort:'ultra',permissionMode:'default'});
 assert.equal(menu.querySelector('[data-effort="ultra"]').getAttribute('aria-pressed'),'true');
 emit({kind:'config',model:'gpt-5.5',effort:'',permissionMode:'default'});
 assert.equal(menu.querySelectorAll('[data-effort]').length,4);
 assert.equal(menu.querySelector('[data-effort="ultra"]'),null);
 assert.equal(menu.querySelector('[data-effort=""]'),null);
 assert.equal(menu.querySelector('[data-effort="high"]').getAttribute('aria-pressed'),'true');
 assert.equal(menu.querySelector('.effort-current').textContent,'推理程度 · high');
 emit({kind:'config',model:'',effort:'',permissionMode:'default'});
 assert.equal(menu.querySelector('[data-effort="medium"]').getAttribute('aria-pressed'),'true');
 assert.equal(menu.querySelector('.effort-current').textContent,'推理程度 · medium');
 assert.deepEqual(errors,[]);
});
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

test('停止确认后明确显示整理还原点，归档完成前不放行队列',async t=>{
 const {w,sent,emit,errors}=setup(t);emit({kind:'busy',busy:true});
 const input=w.document.getElementById('input'),stop=w.document.getElementById('btn-stop');
 input.value='下一条';w.document.getElementById('btn-send').click();stop.click();
 emit({kind:'finalizing'});
 assert.match(input.placeholder,/已停止.*整理文件还原点/);assert.equal(stop.disabled,true);
 assert.doesNotMatch(input.placeholder,/正在停止/);
 await new Promise(r=>setTimeout(r,180));assert.equal(sent.some(m=>m.type==='send'),false);
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
 await new Promise(r=>setTimeout(r,180));
 assert.deepEqual(sent.filter(m=>m.type==='send').map(m=>m.text),['下一条']);
 emit({kind:'busy',busy:true});assert.doesNotMatch(input.placeholder,/整理文件还原点|已停止/);
 assert.equal(stop.disabled,false);assert.deepEqual(errors,[]);
});

test('重新生成回退完成后，无论停止还是正常结束，下一条消息都能直接发送',async t=>{
 for(const stopped of [true,false]){
  const {w,sent,emit,errors}=setup(t),input=w.document.getElementById('input');
  emit({kind:'load_history',sessionId:'source',items:[{type:'user',text:'原问题'},{type:'assistant_text',text:'原回答'}],checkpoints:[{id:'cp',label:'原问题',userText:'原问题'}]});
  w.document.querySelector('.regen').click();
  assert.ok(sent.some(m=>m.type==='editMessage'&&m.checkpointId==='cp'));
  emit({kind:'restoring'});
  assert.equal(w.document.querySelector('.restore-overlay'),null,'重新生成期间不遮挡消息区');
  emit({kind:'restored'});
  emit({kind:'busy',busy:true});emit({kind:'text_delta',text:'重新回答'});
  if(stopped)w.document.getElementById('btn-stop').click();
  emit({kind:'finalizing'});emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
  assert.match(input.placeholder,/给 Codex 发消息/);
  input.value='结束后的新消息';w.document.getElementById('btn-send').click();
  assert.deepEqual(sent.filter(m=>m.type==='send').map(m=>m.text),['结束后的新消息']);
  assert.equal(w.document.querySelectorAll('.tq-row').length,0);
  assert.deepEqual(errors,[]);
 }
});

test('重新生成回退完成只解除还原状态，排队消息仍等新回答停止后按序发送',async t=>{
 const {w,sent,emit,errors}=setup(t),input=w.document.getElementById('input');
 emit({kind:'load_history',items:[{type:'user',text:'原问题'},{type:'assistant_text',text:'原回答'}],checkpoints:[]});
 w.document.querySelector('.regen').click();emit({kind:'restoring'});
 for(const text of ['第一条排队消息','第二条排队消息']){input.value=text;w.document.getElementById('btn-send').click();}
 emit({kind:'restored'});
 await new Promise(r=>setTimeout(r,180));
 assert.equal(sent.some(m=>m.type==='send'),false,'回退完成后仍要等待重新生成的回答');
 emit({kind:'busy',busy:true});w.document.getElementById('btn-stop').click();emit({kind:'finalizing'});
 await new Promise(r=>setTimeout(r,180));assert.equal(sent.some(m=>m.type==='send'),false);
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
 await new Promise(r=>setTimeout(r,180));
 assert.deepEqual(sent.filter(m=>m.type==='send').map(m=>m.text),['第一条排队消息']);
 assert.match(w.document.getElementById('task-queue').textContent,/第二条排队消息/);
 emit({kind:'busy',busy:true});emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
 await new Promise(r=>setTimeout(r,180));
 assert.deepEqual(sent.filter(m=>m.type==='send').map(m=>m.text),['第一条排队消息','第二条排队消息']);
 assert.deepEqual(errors,[]);
});

test('普通还原先空闲后加载历史，回退完成后重新唤醒被暂停的队列',async t=>{
 const {w,sent,emit,errors}=setup(t),input=w.document.getElementById('input');
 emit({kind:'busy',busy:true});input.value='还原后继续';w.document.getElementById('btn-send').click();
 emit({kind:'restoring'});emit({kind:'busy',busy:false});
 await new Promise(r=>setTimeout(r,180));assert.equal(sent.some(m=>m.type==='send'),false);
 emit({kind:'load_history',sessionId:'restored',items:[],checkpoints:[]});
 await new Promise(r=>setTimeout(r,180));
 assert.deepEqual(sent.filter(m=>m.type==='send').map(m=>m.text),['还原后继续']);
 assert.equal(w.document.querySelector('.restore-overlay'),null);
 assert.deepEqual(errors,[]);
});

test('大文件和二进制改动显示说明，仍提供保留和回滚入口',t=>{
 const {w,sent,emit,errors}=setup(t);
 emit({kind:'changed_files',totalAdded:0,totalRemoved:0,files:[
  {path:'/tmp/disk.img',rel:'disk.img',status:'added',added:0,removed:0,diffUnavailable:'large'},
  {path:'/tmp/icon.bin',rel:'icon.bin',status:'added',added:0,removed:0,diffUnavailable:'binary'},
 ]});
 const rows=w.document.querySelectorAll('.cf-row');assert.equal(rows.length,2);
 assert.equal(rows[0].querySelector('.cf-rowstat').textContent,'大文件');
 assert.equal(rows[1].querySelector('.cf-rowstat').textContent,'二进制');
 rows[0].querySelector('.accept').click();rows[1].querySelector('.revert').click();
 assert.ok(sent.some(m=>m.type==='acceptFile'&&m.path==='/tmp/disk.img'));
 assert.ok(sent.some(m=>m.type==='revertFile'&&m.path==='/tmp/icon.bin'));
 assert.deepEqual(errors,[]);
});

test('普通快速闪电只发送当前会话速度，保存回执前保持真实消费状态',t=>{
 const {w,sent,emit,errors}=setup(t);
 emit({kind:'models',models:[{id:'gpt-6.1-sol',name:'Sol',description:'',efforts:['low','medium','high'],speedModes:['default','fast','ultrafast']}]});
 emit({kind:'config',model:'gpt-6.1-sol',effort:'medium',permissionMode:'default',speedMode:'default'});
 emit({kind:'speed_context',billing:'chatgpt'});
 const trigger=w.document.getElementById('speed-trigger');
 assert.equal(trigger.getAttribute('role'),'switch');assert.equal(trigger.getAttribute('aria-checked'),'false');
 assert.equal(w.document.getElementById('speed-menu'),null);
 assert.match(w.document.getElementById("speed-tooltip").textContent,/1×/);assert.match(w.document.getElementById("speed-tooltip").textContent,/2.5×/);assert.match(w.document.getElementById("speed-tooltip").textContent,/2×/);
 assert.doesNotMatch(w.document.getElementById("speed-tooltip").textContent,/提速.*2.5|8×|超高速/);
 trigger.click();trigger.click();
 assert.deepEqual(JSON.parse(JSON.stringify(sent.filter(x=>x.type==='setSpeedMode'))),[{type:'setSpeedMode',mode:'fast'}]);
 assert.equal(trigger.getAttribute('aria-checked'),'false');assert.equal(trigger.disabled,true);
 emit({kind:'config',model:'gpt-6.1-sol',effort:'medium',permissionMode:'default',speedMode:'fast'});
 assert.equal(trigger.getAttribute('aria-checked'),'true');assert.equal(trigger.querySelector('.speed-bolt') !== null,true);assert.match(w.document.getElementById("speed-tooltip").textContent,/快速模式 · 已开启/);
 trigger.click();assert.equal(sent.at(-1).mode,'default');
 assert.equal(sent.some(m=>['setModel','setEffort','stop'].includes(m.type)),false);
 assert.deepEqual(errors,[]);
});
test('快速能力缺失禁用开启，但始终允许从快速切回普通；失败回执恢复开关',t=>{
 const {w,sent,emit}=setup(t);const trigger=w.document.getElementById('speed-trigger');
 emit({kind:'models',models:[{id:'unsupported',name:'模型',description:'',efforts:[],speedModes:['default']}]});
 emit({kind:'config',model:'unsupported',effort:'medium',permissionMode:'default',speedMode:'default'});
 assert.equal(trigger.disabled,true);trigger.click();assert.equal(sent.some(x=>x.type==='setSpeedMode'),false);
 emit({kind:'config',model:'unsupported',effort:'medium',permissionMode:'default',speedMode:'fast'});
 assert.equal(trigger.disabled,false);trigger.click();assert.equal(sent.at(-1).mode,'default');
 emit({kind:'config',model:'unsupported',effort:'medium',permissionMode:'default',speedMode:'fast'});
 assert.equal(trigger.getAttribute('aria-checked'),'true');assert.equal(trigger.disabled,false);
});
test('速度成功反馈不挤占聊天或改变焦点，连续切换只保留最新提示一秒',t=>{
 const {w,emit,errors}=setup(t),advance=manualTimeouts(w);
 const config={kind:'config',model:'gpt-6.1-sol',effort:'medium',permissionMode:'default',speedMode:'default'};
 emit({kind:'models',models:[{id:'gpt-6.1-sol',name:'Sol',description:'',efforts:[],speedModes:['default','fast']}]});
 emit(config);emit({kind:'busy',busy:true});
 emit({kind:'tool_input',toolId:'running',name:'Bash',input:{command:'npm run build'}});
 const {messages,scroll}=scrollFixture(w);scroll(100);
 const working=messages.querySelector('.working-pill'),content=messages.innerHTML;
 const trigger=w.document.getElementById('speed-trigger'),feedback=w.document.getElementById('speed-feedback');
 const input=w.document.getElementById('input');input.focus();
 assert.equal(feedback.hidden,true);
 trigger.click();assert.equal(feedback.hidden,true,'保存回执前不能提前提示成功');
 emit({...config,speedMode:'fast'});assert.equal(feedback.hidden,true,'普通配置广播不应生成成功提示');
 emit({kind:'speed_mode_saved',mode:'fast'});
 assert.equal(feedback.hidden,false);assert.equal(feedback.textContent,'快速模式 · 下轮生效');
 assert.equal(feedback.getAttribute('role'),'status');assert.equal(feedback.getAttribute('aria-live'),'polite');
 assert.equal(messages.contains(feedback),false);assert.equal(messages.innerHTML,content);
 assert.equal(messages.scrollTop,100);assert.equal(w.document.activeElement,input);
 assert.equal(messages.querySelector('.working-pill'),working);
 advance(999);assert.equal(feedback.hidden,false);
 trigger.click();assert.equal(feedback.hidden,true,'新请求期间撤下旧成功提示，避免与保存结果混淆');
 emit(config);emit({kind:'speed_mode_saved',mode:'default'});
 assert.equal(feedback.textContent,'普通模式 · 下轮生效');
 assert.equal(w.document.querySelectorAll('.speed-feedback').length,1);
 advance(1);assert.equal(feedback.hidden,false,'上一次计时到期不能提前撤掉新提示');
 advance(998);assert.equal(feedback.hidden,false);
 advance(1);assert.equal(feedback.hidden,true);assert.equal(feedback.textContent,'');
 assert.equal(messages.querySelectorAll('.notice').length,0);assert.deepEqual(errors,[]);
});
test('短暂反馈与悬浮说明不重叠，离开按钮不提前消失，会话切换或 Escape 可撤下',t=>{
 const {w,emit,errors}=setup(t),advance=manualTimeouts(w);
 const trigger=w.document.getElementById('speed-trigger'),tip=w.document.getElementById('speed-tooltip'),feedback=w.document.getElementById('speed-feedback');
 trigger.dispatchEvent(new w.MouseEvent('mouseenter'));assert.equal(tip.hidden,false);
 emit({kind:'speed_mode_saved',mode:'fast'});assert.equal(tip.hidden,true);assert.equal(feedback.hidden,false);
 trigger.dispatchEvent(new w.MouseEvent('mouseleave'));assert.equal(feedback.hidden,false);
 trigger.dispatchEvent(new w.FocusEvent('focus'));assert.equal(tip.hidden,true);
 w.document.dispatchEvent(new w.Event('scroll'));w.dispatchEvent(new w.Event('resize'));
 assert.equal(feedback.hidden,false);
 w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(feedback.hidden,true);
 trigger.dispatchEvent(new w.MouseEvent('mouseenter'));assert.equal(tip.hidden,false);
 emit({kind:'speed_mode_saved',mode:'default'});
 emit({kind:'load_history',sessionId:'other',items:[]});
 assert.equal(feedback.hidden,true);assert.equal(tip.hidden,true);
 advance(1000);assert.equal(feedback.hidden,true);
 emit({kind:'speed_mode_saved',mode:'fast'});advance(1000);
 trigger.dispatchEvent(new w.MouseEvent('mouseenter'));assert.equal(tip.hidden,false,'提示过期后详细说明仍可查看');
 assert.deepEqual(errors,[]);
});
test('模式保存失败保留错误提醒，不生成成功反馈或误亮闪电',t=>{
 const {w,emit}=setup(t);
 const config={kind:'config',model:'gpt-6.1-sol',effort:'medium',permissionMode:'default',speedMode:'default'};
 emit({kind:'models',models:[{id:'gpt-6.1-sol',name:'Sol',description:'',efforts:[],speedModes:['default','fast']}]});
 emit(config);w.document.getElementById('speed-trigger').click();
 emit({kind:'error',message:'无法保存此会话的速度模式，请重试。'});emit(config);
 assert.equal(w.document.getElementById('speed-feedback').hidden,true);
 assert.equal(w.document.getElementById('speed-trigger').getAttribute('aria-checked'),'false');
 assert.match(w.document.querySelector('.notice.error').textContent,/无法保存此会话的速度模式/);
});
test('窄窗口提示按实际小数宽度留足边距，并随输入区位置变化',t=>{
 const {w,emit,resize}=setup(t),feedback=w.document.getElementById('speed-feedback');
 const flush=manualFrames(w);
 Object.defineProperties(w,{innerWidth:{value:320},innerHeight:{value:500}});
 let top=396;
 w.document.getElementById('speed-trigger').getBoundingClientRect=()=>({left:219.75,top,bottom:top+26});
 feedback.getBoundingClientRect=()=>({width:128.3125,height:34});
 Object.defineProperties(feedback,{offsetWidth:{value:128},offsetHeight:{value:34}});
 emit({kind:'speed_mode_saved',mode:'fast'});
 assert.ok(parseFloat(feedback.style.left)>=8);
 assert.ok(parseFloat(feedback.style.left)+128.3125<=312,'整数尺寸不能使提示侵入窗口右侧边距');
 assert.equal(parseFloat(feedback.style.top)+34,top-8);
 top=300;resize(w.document.getElementById('composer'));flush();
 assert.equal(parseFloat(feedback.style.top)+34,top-8);
});
test('默认模型等待真实会话确认，API 计费不残留订阅额度倍率',t=>{
 const {w,emit}=setup(t);const trigger=w.document.getElementById('speed-trigger');
 emit({kind:'models',models:[{id:'gpt-6.1-sol',name:'Sol',description:'',efforts:[],isDefault:true,speedModes:['default','fast']}]});
 emit({kind:'config',model:'',effort:'medium',permissionMode:'default',speedMode:'default'});
 assert.equal(trigger.disabled,true);
 emit({kind:'session',sessionId:'s',model:'gpt-6.1-sol',cwd:'/tmp',tools:[]});
 assert.equal(trigger.disabled,false);
 emit({kind:'speed_context',billing:'api'});
 assert.match(w.document.getElementById("speed-tooltip").textContent,/API.*不适用/);assert.doesNotMatch(w.document.getElementById("speed-tooltip").textContent,/2.5×|订阅内额度|2×/);
 emit({kind:'speed_context',billing:'chatgpt'});assert.match(w.document.getElementById("speed-tooltip").textContent,/2.5×/);
});
test('推理入口与模型和快速开关同层可见，保存失败回执不改变已选档位',t=>{
 const {w,sent,emit}=setup(t);
 emit({kind:'models',models:[{id:'gpt-6.1-sol',name:'Sol',description:'',efforts:['low','medium','high'],defaultEffort:'medium',speedModes:['default','fast']}]});
 emit({kind:'config',model:'gpt-6.1-sol',effort:'medium',permissionMode:'default',speedMode:'default'});
 const trigger=w.document.getElementById('effort-trigger');
 assert.equal(w.document.getElementById('effort-label').textContent,'medium');
 assert.equal(trigger.parentElement,w.document.getElementById('model-trigger').parentElement);
 assert.equal(trigger.parentElement,w.document.getElementById('speed-trigger').parentElement);
 w.document.getElementById('model-trigger').click();assert.equal(w.document.querySelector('#model-menu [data-effort]'),null);
 trigger.click();const high=w.document.querySelector('#effort-menu [data-effort="high"]');high.click();
 assert.equal(sent.at(-1).effort,'high');assert.equal(w.document.getElementById('effort-label').textContent,'medium');
 assert.ok([...w.document.querySelectorAll('#effort-menu [data-effort]')].every(e=>e.disabled));
 emit({kind:'config',model:'gpt-6.1-sol',effort:'medium',permissionMode:'default',speedMode:'default'});
 assert.equal(w.document.getElementById('effort-label').textContent,'medium');
 assert.equal(w.document.querySelector('#effort-menu [data-effort="high"]').disabled,false);
});

function manualFrames(w){let next=0;const frames=new Map();w.requestAnimationFrame=f=>{frames.set(++next,f);return next;};w.cancelAnimationFrame=id=>frames.delete(id);return ()=>{const callbacks=[...frames.values()];frames.clear();callbacks.forEach(f=>f(w.performance.now()));};}
test('输入区和消息区尺寸通知合并到下一帧，不在观察器中强制布局或重复写入尺寸',t=>{
 const {w,resize}=setup(t),flush=manualFrames(w),composer=w.document.getElementById('composer'),messages=w.document.getElementById('messages');
 let heightReads=0,scrollWrites=0,top=0;
 Object.defineProperty(composer,'offsetHeight',{get:()=>{heightReads++;return 300;}});
 Object.defineProperties(messages,{scrollHeight:{get:()=>2000},clientHeight:{get:()=>600},scrollTop:{get:()=>top,set:value=>{scrollWrites++;top=value;}}});
 const changes=new w.MutationObserver(()=>{});changes.observe(messages,{attributes:true,attributeFilter:['style']});
 for(let i=0;i<100;i++){resize(composer);resize(messages);}
 assert.equal(heightReads,0);assert.equal(scrollWrites,0);assert.equal(changes.takeRecords().length,0);
 flush();assert.equal(heightReads,1);assert.equal(scrollWrites,1);
 assert.equal(messages.style.paddingBottom,'450px');assert.equal(w.document.querySelector('.jump-latest').style.bottom,'312px');
 assert.equal(changes.takeRecords().length,1);
 resize(composer);resize(messages);flush();assert.equal(changes.takeRecords().length,0,'相同尺寸不得反复改样式');changes.disconnect();
});
test('尺寸通知后下一帧前用户开始阅读历史，不得被迟到回调拉到底部',t=>{
 const {w,resize}=setup(t),flush=manualFrames(w),{messages,scroll}=scrollFixture(w);
 resize(w.document.getElementById('composer'));resize(messages);
 messages.dispatchEvent(new w.WheelEvent('wheel',{deltaY:-50}));scroll(100);
 flush();assert.equal(messages.scrollTop,100);assert.equal(w.document.querySelector('.jump-latest').classList.contains('hidden'),false);
});
test('输入区宽度变化合并到下一帧测量，换行引起的高度变化不重复适配',t=>{
 const {w,resize}=setup(t),flush=manualFrames(w),row=w.document.querySelector('.composer-tools');
 let width=240,reads=0;
 Object.defineProperties(row,{clientWidth:{get:()=>width},scrollWidth:{get:()=>{reads++;return 500;}}});
 resize(row);resize(row);resize(row);assert.equal(reads,0,'观察器回调不能同步修改自身尺寸');
 flush();assert.equal(reads,3);assert.equal(row.classList.contains('compact-wrap'),true);
 resize(row);flush();assert.equal(reads,3,'宽度不变的高度通知不触发新一轮折叠测量');
 width=600;resize(row);flush();assert.equal(reads,4);assert.equal(row.classList.contains('compact'),false);
});
function manualTimeouts(w){
 let now=0,next=0;const timers=new Map();
 w.setTimeout=(callback,delay=0)=>{timers.set(++next,{callback,at:now+delay});return next;};
 w.clearTimeout=id=>timers.delete(id);
 return ms=>{
  const end=now+ms;
  for(;;){
   const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
   if(!due)break;
   const [id,timer]=due;now=timer.at;timers.delete(id);timer.callback();
  }
  now=end;
 };
}
function manualSeconds(w){
 let now=0,next=0;const intervals=new Map();
 Object.defineProperty(w.performance,'now',{value:()=>now});
 w.setInterval=f=>{intervals.set(++next,f);return next;};w.clearInterval=id=>intervals.delete(id);
 return seconds=>{now+=seconds*1000;[...intervals.values()].forEach(f=>f());};
}
test('创建完成后等待首个输出显示响应等待，累计耗时和真实进展计时不中断',t=>{
 const {w,emit,errors}=setup(t);const advance=manualSeconds(w);
 emit({kind:'busy',busy:true});
 emit({kind:'status',label:'正在创建 Codex 会话…'});advance(1);
 emit({kind:'session',sessionId:'ready',cwd:'/tmp',model:'test-model',tools:[],resumed:false});
 emit({kind:'busy',busy:true});emit({kind:'status',label:'等待 Codex 响应…'});advance(5);
 assert.equal(w.document.querySelector('.wk-label').textContent,'等待 Codex 响应…');
 assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 6秒');
 assert.equal(w.document.querySelector('.wk-progress').textContent,'尚未收到任务进展 · 已等待 6秒');
 assert.match(w.document.querySelector('.wk-tokens').textContent,/待回传/);
 emit({kind:'block_start',blockType:'thinking'});emit({kind:'thinking_delta',text:'思考进展'});advance(2);
 assert.equal(w.document.querySelector('.wk-label').textContent,'模型思考中…');
 assert.equal(w.document.querySelector('.wk-progress').textContent,'距最近进展 2秒 · 收到思考进展');
 emit({kind:'tool_input',toolId:'ready-tool',name:'Read',input:{file_path:'/tmp/example'}});
 assert.equal(w.document.querySelector('.wk-label').textContent,'正在执行工具…');
 emit({kind:'busy',busy:false});advance(5);
 assert.equal(w.document.querySelector('.working-pill'),null);assert.deepEqual(errors,[]);
});
test('九十六分钟长任务分开展示总耗时与最近思考进展，不靠动画虚构状态',t=>{
 const {w,emit,errors}=setup(t);const advance=manualSeconds(w);
 emit({kind:'busy',busy:true});advance(96*60);
 assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 1小时36分0秒');
 assert.match(w.document.querySelector('.wk-progress').textContent,/尚未收到任务进展/);
 emit({kind:'block_start',blockType:'thinking'});
 emit({kind:'thinking_delta',text:'隐藏的思考内容不得显示'});advance(5);
 assert.equal(w.document.querySelector('.wk-label').textContent,'模型思考中…');
 assert.equal(w.document.querySelector('.wk-progress').textContent,'距最近进展 5秒 · 收到思考进展');
 emit({kind:'busy',busy:true});
 assert.equal(w.document.querySelector('.wk-label').textContent,'模型思考中…','重复 busy 不能覆盖真实阶段');
 advance(5);
 assert.equal(w.document.querySelector('.wk-label').textContent,'模型思考中…','计时动画不能伪造新状态');
 emit({kind:'block_end'});advance(57);
 emit({kind:'response_wait',idleMs:57000});
 assert.equal(w.document.querySelector('.wk-label').textContent,'模型处理中…');
 assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 1小时37分7秒');
 assert.equal(w.document.querySelector('.wk-progress').textContent,'距最近进展 57秒 · 模型阶段完成');
 emit({kind:'usage',weekPct:20});emit({kind:'status',label:'Codex 正在重试请求…'});advance(8);
 assert.match(w.document.querySelector('.wk-progress').textContent,/距最近进展 1分5秒/,'额度、重试不能刷新进展时间');
 emit({kind:'block_start',blockType:'thinking'});emit({kind:'thinking_delta',text:''});
 assert.equal(w.document.querySelector('.wk-progress').textContent,'距最近进展 0秒 · 收到思考进展');
 assert.equal(w.document.querySelector('.wk-wait'),null);
 assert.equal(w.document.querySelector('.think-node'),null);
 assert.doesNotMatch(w.document.getElementById('messages').textContent,/隐藏的思考内容不得显示/);
 emit({kind:'busy',busy:false});advance(60);
 assert.equal(w.document.querySelector('.working-pill'),null);assert.deepEqual(errors,[]);
});
test('并行工具期间模型块结束不显示等待，最后一个工具完成才回到模型状态',t=>{
 const {w,emit}=setup(t);const advance=manualSeconds(w);
 emit({kind:'busy',busy:true});
 for(const id of ['one','two'])emit({kind:'tool_input',toolId:id,name:'Bash',input:{command:'test'}});
 emit({kind:'block_end'});advance(30);
 assert.equal(w.document.querySelector('.wk-label').textContent,'正在执行工具…');
 emit({kind:'tool_result',toolUseId:'one',content:'ok',isError:false});
 assert.equal(w.document.querySelector('.wk-label').textContent,'正在执行工具…');
 advance(12);assert.equal(w.document.querySelector('.wk-progress').textContent,'距最近进展 12秒 · 收到工具结果');
 emit({kind:'tool_result',toolUseId:'two',content:'failed',isError:true});
 assert.equal(w.document.querySelector('.wk-label').textContent,'模型处理中…');
 assert.equal(w.document.querySelector('.wk-progress').textContent,'距最近进展 0秒 · 收到工具结果');
});
test('思考过程只保留运行状态、累计用时和静默提醒，不生成时间线行',t=>{
 const {w,emit}=setup(t);const advance=manualSeconds(w);
 emit({kind:'busy',busy:true});advance(230);
 emit({kind:'block_start',blockType:'thinking'});
 emit({kind:'thinking_delta',text:'已收到的一段思考'});advance(1);
 emit({kind:'block_end'});advance(57);
 emit({kind:'response_wait',idleMs:57000});
 assert.equal(w.document.querySelector('.think-node'),null);
 assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 4分48秒');
 assert.match(w.document.querySelector('.wk-progress').textContent,/距最近进展 57秒/);
 assert.match(w.document.querySelector('.wk-wait').textContent,/后端尚未返回新进展/);
 assert.doesNotMatch(w.document.querySelector('.wk-wait').textContent,/停止|重试|卡死/);
 emit({kind:'response_wait',idleMs:0});
 emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'回复继续'});
 assert.equal(w.document.querySelector('.wk-wait'),null);
 assert.match(w.document.querySelector('.wk-label').textContent,/正在回复/);
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
 emit({kind:'load_history',items:[{type:'thinking',text:'历史思考',secs:1}],checkpoints:[]});
 assert.equal(w.document.querySelector('.think-node'),null);
 assert.equal(w.document.querySelector('.msg.assistant'),null);
});
test('答案提交成功后重新计时，不累计回答前的执行与等待时间',t=>{
 const {w,emit}=setup(t);const advance=manualSeconds(w);
 emit({kind:'busy',busy:true});advance(65);
 emit({kind:'permission_request',requestId:'q-time',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'继续？',options:[]}]},suggestions:[]});
 assert.equal(w.document.querySelector('.working-pill'),null);
 advance(30);
 emit({kind:'permission_resolved',requestId:'q-time',behavior:'allow'});
 emit({kind:'busy',busy:true});
 assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 0秒');
 advance(5);assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 5秒');
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});
 advance(10);emit({kind:'busy',busy:true});
 assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 0秒');
});
test('运行中回退重新回答不会沿用旧轮次的三十多分钟，重试成功才开始计时',t=>{
 const {w,emit,errors}=setup(t);const advance=manualSeconds(w);
 emit({kind:'busy',busy:true});advance(36*60);
 emit({kind:'busy',busy:true});emit({kind:'restoring'});advance(5);
 emit({kind:'load_history',sessionId:'rewound',items:[],checkpoints:[]});
 emit({kind:'busy',busy:true});
 emit({kind:'permission_request',requestId:'q-retry-time',toolName:'AskUserQuestion',input:{questions:[{id:'q',question:'修改答案',options:[]}]},suggestions:[]});
 advance(120);
 emit({kind:'question_answer_rejected',requestId:'q-retry-time',message:'提交失败，请重试'});
 advance(30);assert.equal(w.document.querySelector('.working-pill'),null);
 emit({kind:'permission_resolved',requestId:'q-retry-time',behavior:'allow'});
 emit({kind:'busy',busy:true});
 assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 0秒');
 advance(150);emit({kind:'compacting',trigger:'auto'});
 assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 2分30秒');
 emit({kind:'compacted',trigger:'auto',preTokens:1000,postTokens:500});
 emit({kind:'busy',busy:true});advance(10);
 assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 2分40秒');
 assert.deepEqual(errors,[]);
});
test('普通工具授权和迟到的重复答案确认不会重置计时',t=>{
 const {w,emit}=setup(t);const advance=manualSeconds(w);
 emit({kind:'busy',busy:true});advance(65);
 emit({kind:'permission_request',requestId:'tool-time',toolName:'Bash',input:{command:'echo ok'},suggestions:[]});
 emit({kind:'permission_resolved',requestId:'tool-time',behavior:'allow'});
 emit({kind:'permission_resolved',requestId:'old-question',behavior:'allow'});
 advance(5);assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 1分10秒');
});
test('中途说明后长时间无新事件，状态与秒数持续显示，下一次思考及时接续',t=>{
 const {w,emit,errors}=setup(t);const advance=manualSeconds(w);const flush=manualFrames(w);
 emit({kind:'busy',busy:true});
 assert.match(w.document.querySelector('.wk-tokens').textContent,/待回传/);
 emit({kind:'block_start',blockType:'text'});emit({kind:'text_delta',text:'首轮回归已通过，继续检查。'});flush();
 assert.match(w.document.querySelector('.wk-label').textContent,/正在回复/);
 advance(5);assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 5秒');
 emit({kind:'block_end'});
 assert.match(w.document.querySelector('.wk-label').textContent,/模型处理中/);
 advance(60);assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 1分5秒');
 assert.match(w.document.querySelector('.wk-tokens').textContent,/≈.*tokens/);
 emit({kind:'block_start',blockType:'thinking'});advance(20);
 assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 1分25秒');
 emit({kind:'block_end'});assert.equal(w.document.querySelector('.think-node'),null);
 assert.equal(w.document.querySelector('.msg-body').lastElementChild.className,'working-pill');
 emit({kind:'busy',busy:false});emit({kind:'result',isError:false,numTurns:1});advance(10);
 assert.equal(w.document.querySelector('.working-pill'),null);assert.deepEqual(errors,[]);
});
test('文件工具等待期间也显示计时，重建状态保留已收到的思考 token',t=>{
 const {w,emit}=setup(t);const advance=manualSeconds(w);const flush=manualFrames(w);
 emit({kind:'busy',busy:true});emit({kind:'thinking_tokens',tokens:123});
 emit({kind:'tool_input',toolId:'read',name:'Read',input:{file_path:'/tmp/a.txt'}});
 advance(12);assert.equal(w.document.querySelector('.wk-time').textContent,'本轮总耗时 12秒');
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
 Object.defineProperty(w.Element.prototype,'innerHTML',{...desc,set(v){if(typeof v==='string'&&v.startsWith('<p>开头'))renders++;desc.set.call(this,v);}});
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

test('流式代码、表格和列表的未换行尾部保留在 Markdown 容器内',t=>{
 const {w,emit,errors}=setup(t),flush=manualFrames(w);
 emit({kind:'busy',busy:true});
 emit({kind:'text_delta',text:'代码示例\n\n```ts\nconst answer = '});
 assert.match(w.document.querySelector('.live-committed pre code').textContent,/const answer = /);
 assert.equal(w.document.querySelector('.live-line').textContent,'');
 emit({kind:'text_delta',text:'42;'});
 assert.match(w.document.querySelector('pre code').textContent,/const answer = 42;/,'格式化帧前也不能掉到代码框外');
 emit({kind:'text_delta',text:'\n```\n\n| 列 | 值 |\n| --- | --- |\n| 状态 | 完'});flush();
 assert.equal(w.document.querySelector('tbody td:last-child').textContent,'完');
 emit({kind:'text_delta',text:'成 |\n\n- 第一项\n- **第二项**'});flush();
 assert.equal(w.document.querySelector('tbody td:last-child').textContent,'完成');
 assert.equal(w.document.querySelector('li:last-child strong').textContent,'第二项');
 assert.equal(w.document.querySelector('.live-line').textContent,'');
 assert.deepEqual(errors,[]);
});

test('长回复限频期间即时文字共用一个节点，结束和历史重载取消迟到渲染',t=>{
 for(const ending of ['result','history']){
  const {w,emit,errors}=setup(t),flush=manualFrames(w),advance=manualTimeouts(w);
  emit({kind:'busy',busy:true});emit({kind:'text_delta',text:'长回复'.repeat(4000)});
  for(let i=0;i<100;i++)emit({kind:'text_delta',text:'追加'});
  assert.equal(w.document.querySelector('.live-line').childNodes.length,1);
  assert.ok(w.document.querySelector('.text-seg').textContent.endsWith('追加'.repeat(100)));
  if(ending==='result')emit({kind:'result',isError:false,durationMs:1,numTurns:1});
  else emit({kind:'load_history',items:[{type:'assistant_text',text:'新历史'}],checkpoints:[]});
  const content=w.document.querySelector('.text-seg').innerHTML;
  advance(1000);flush();assert.equal(w.document.querySelector('.text-seg').innerHTML,content);assert.deepEqual(errors,[]);
 }
});

test('追加流式段落复用已显示的图片和代码 DOM，并保留横向滚动位置',t=>{
 const {w,emit,sent,errors}=setup(t),flush=manualFrames(w);
 emit({kind:'busy',busy:true});
 emit({kind:'text_delta',text:'![预览](/tmp/stream-preview.png)\n\n```text\n固定代码\n```\n\n开始'});
 emit({kind:'local_image',path:'/tmp/stream-preview.png',dataUri:'data:image/png;base64,YQ=='});
 const img=w.document.querySelector('.text-seg img'),pre=w.document.querySelector('.text-seg pre');
 img.dispatchEvent(new w.Event('load'));pre.scrollLeft=90;
 for(let i=0;i<8;i++){emit({kind:'text_delta',text:`\n\n追加第${i}段`});flush();}
 assert.equal(w.document.querySelector('.text-seg img'),img);
 assert.equal(w.document.querySelector('.text-seg pre'),pre);assert.equal(pre.scrollLeft,90);
 assert.equal(sent.filter(m=>m.type==='loadLocalImage').length,1);
 assert.equal(w.document.querySelector('.local-image-placeholder'),null);
 emit({kind:'text_snap',text:'更正为短内容'});flush();
 assert.equal(w.document.querySelector('.text-seg img'),null);
 assert.equal(w.document.querySelector('.text-seg pre'),null);
 assert.equal(w.document.querySelector('.text-seg').textContent,'更正为短内容');assert.deepEqual(errors,[]);
});

test('重新生成和清空历史释放已删除消息的监听器及待执行布局回调',t=>{
 const {w,emit,resize,resizeObservers,errors}=setup(t),flush=manualFrames(w);
 emit({kind:'load_history',sessionId:'cleanup',items:[
  {type:'user',text:'问题一'},{type:'assistant_text',text:'回答一'},
  {type:'user',text:'问题二'},{type:'assistant_text',text:'回答二'},
 ],checkpoints:[{id:'cp1',userText:'问题一'},{id:'cp2',userText:'问题二'}]});
 const replies=[...w.document.querySelectorAll('.msg.assistant')];
 const observer=resizeObservers.find(o=>o.targets.includes(replies[1]));
 assert.ok(observer);resize(replies[1]);
 replies[1].querySelector('.regen').click();assert.equal(replies[1].isConnected,false);
 assert.equal(observer.targets.length,0);flush();
 assert.ok(resizeObservers.some(o=>o.targets.includes(replies[0])),'保留的历史仍跟随尺寸变化');
 emit({kind:'busy',busy:false});
 const input=w.document.getElementById('input');input.value='/clear';w.document.getElementById('btn-send').click();
 assert.equal(resizeObservers.some(o=>o.targets.some(n=>n.classList.contains('assistant'))),false);
 flush();assert.deepEqual(errors,[]);
});

test('超大已标语言代码保留全文和复制功能，跳过昂贵的语法高亮',t=>{
 const {w,emit,errors}=setup(t),code='const answer = "完整保留";\n'.repeat(2000);
 emit({kind:'load_history',items:[{type:'assistant_text',text:'```javascript\n'+code+'```'}],checkpoints:[]});
 const block=w.document.querySelector('.code-block');assert.equal(block.querySelector('code').textContent,code);
 assert.equal(block.querySelectorAll('code span').length,0);assert.ok(block.querySelector('[data-action="copy"]'));
 emit({kind:'tool_input',toolId:'large-command',name:'Bash',input:{command:code}});
 const tool=w.document.querySelector('[data-tool-id="large-command"]');
 assert.equal(tool.querySelector('code').textContent,code);assert.equal(tool.querySelectorAll('code span').length,0);
 assert.deepEqual(errors,[]);
});

test('命令和菜单等待保存回执，重复选择不提交，失败保留模型和推理强度',t=>{
 const {w,emit,sent,errors}=setup(t);
 emit({kind:'models',models:[{id:'model-a',name:'模型甲',efforts:['low','medium','high']},{id:'model-b',name:'模型乙',efforts:['low']}]});
 const config={kind:'config',model:'model-a',effort:'high',permissionMode:'default'};
 emit(config);
 const command=text=>{const input=w.document.getElementById('input');input.value=text;input.dispatchEvent(new w.Event('input'));w.document.getElementById('btn-send').click();};
 command('/effort low');command('/effort medium');
 assert.deepEqual(sent.filter(m=>m.type==='setEffort').map(m=>m.effort),['low']);
 assert.equal(w.document.getElementById('effort-label').textContent,'high');
 emit(config); // 模拟保存失败后的真实配置回执
 command('/effort high');
 assert.equal(sent.filter(m=>m.type==='setEffort').length,1);
 w.document.getElementById('model-trigger').click();
 w.document.querySelector('[data-model="model-b"]').click();
 command('/model model-b');
 assert.equal(sent.filter(m=>m.type==='setModel').length,1);
 assert.equal(w.document.getElementById('model-label').textContent,'模型甲');
 assert.equal(w.document.getElementById('effort-label').textContent,'high');
 w.document.getElementById('model-trigger').click();
 assert.ok([...w.document.querySelectorAll('[data-model]')].every(e=>e.disabled));
 emit(config);
 assert.ok([...w.document.querySelectorAll('[data-model]')].every(e=>!e.disabled));
 command('/model model-b');
 emit({...config,model:'model-b',effort:'low'});
 assert.equal(w.document.getElementById('model-label').textContent,'模型乙');
 assert.equal(w.document.getElementById('effort-label').textContent,'low');
 assert.doesNotMatch(w.document.getElementById('messages').textContent,/已切换模型|已切换思考强度/);
 assert.deepEqual(errors,[]);
});

test('闪电提示立即显示，离开、Escape 和滚动立即隐藏，无原生 title',t=>{
 const {w}=setup(t),trigger=w.document.getElementById('speed-trigger'),tip=w.document.getElementById('speed-tooltip');
 assert.equal(trigger.hasAttribute('title'),false);assert.equal(tip.hidden,true);
 trigger.dispatchEvent(new w.MouseEvent('mouseenter'));assert.equal(tip.hidden,false);
 trigger.dispatchEvent(new w.MouseEvent('mouseleave'));assert.equal(tip.hidden,true);
 trigger.dispatchEvent(new w.FocusEvent('focus'));assert.equal(tip.hidden,false);
 w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(tip.hidden,true);
 trigger.dispatchEvent(new w.MouseEvent('mouseenter'));
 w.document.dispatchEvent(new w.Event('scroll'));assert.equal(tip.hidden,true);
});

test('权限图标即时显示当前模式说明，切换更新且打开菜单收起提示',t=>{
 const {w,emit,errors}=setup(t);
 const trigger=w.document.getElementById('mode-trigger'),tip=w.document.getElementById('mode-tooltip');
 assert.equal(trigger.hasAttribute('title'),false);
 emit({kind:'config',permissionMode:'bypassPermissions',speedMode:'default'});
 trigger.dispatchEvent(new w.MouseEvent('mouseenter'));
 assert.equal(tip.hidden,false);assert.match(tip.textContent,/绕过权限/);
 assert.match(trigger.getAttribute('aria-label'),/绕过权限/);
 trigger.dispatchEvent(new w.MouseEvent('mouseleave'));assert.equal(tip.hidden,true);
 trigger.dispatchEvent(new w.FocusEvent('focus'));assert.equal(tip.hidden,false);
 trigger.click();assert.equal(tip.hidden,true);
 emit({kind:'config',permissionMode:'default',speedMode:'default'});
 assert.doesNotMatch(tip.textContent,/绕过权限/);
 assert.deepEqual(errors,[]);
});

test('权限按钮旁的诊断入口在任务执行期间仍可打开诊断中心，保留输入草稿',t=>{
 const {w,sent,emit,errors}=setup(t);
 const button=w.document.getElementById('diagnostics-trigger');
 assert.equal(w.document.getElementById('mode-trigger').nextElementSibling,button);
 assert.equal(button.getAttribute('type'),'button');assert.equal(button.getAttribute('aria-label'),'打开插件诊断中心');
 const input=w.document.getElementById('input');input.value='尚未发送的草稿';
 emit({kind:'busy',busy:true});button.click();
 assert.equal(sent.filter(m=>m.type==='performanceReport').length,1);
 assert.equal(sent.some(m=>m.type==='send'),false);assert.equal(input.value,'尚未发送的草稿');
 assert.equal(button.disabled,true);assert.match(w.document.getElementById('diagnostics-feedback').textContent,/正在打开/);
 const request=sent.find(m=>m.type==='performanceReport');
 emit({kind:'performance_report_result',requestId:request.requestId,ok:true,message:'诊断报告已在编辑器中打开'});
 assert.equal(button.disabled,false);assert.deepEqual(errors,[]);
});

test('诊断虫子图标悬停和键盘聚焦立即说明，移出和 Escape 收起',t=>{
 const {w,errors}=setup(t),button=w.document.getElementById('diagnostics-trigger'),tip=w.document.getElementById('diagnostics-tooltip');
 assert.equal(tip.hidden,true);assert.equal(button.hasAttribute('title'),false);
 button.dispatchEvent(new w.MouseEvent('mouseenter'));assert.equal(tip.hidden,false);assert.match(tip.textContent,/插件诊断中心/);assert.match(tip.textContent,/压缩.*Bash.*子 Agent/);
 assert.equal(button.getAttribute('aria-describedby'),tip.id);
 button.dispatchEvent(new w.MouseEvent('mouseleave'));assert.equal(tip.hidden,true);
 button.dispatchEvent(new w.FocusEvent('focus'));assert.equal(tip.hidden,false);
 w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(tip.hidden,true);assert.deepEqual(errors,[]);
});

test('诊断点击防重复，失败或无响应可重试，旧回执不能覆盖新请求',t=>{
 const {w,sent,emit,errors}=setup(t),button=w.document.getElementById('diagnostics-trigger'),feedback=w.document.getElementById('diagnostics-feedback');
 let expire;const nativeTimeout=w.setTimeout.bind(w);
 w.setTimeout=(fn,ms)=>ms===15000?(expire=fn,77777):nativeTimeout(fn,ms);
 button.click();button.click();assert.equal(sent.filter(m=>m.type==='performanceReport').length,1);assert.equal(feedback.hidden,false);
 const first=sent.find(m=>m.type==='performanceReport');
 emit({kind:'performance_report_result',requestId:first.requestId,ok:false,message:'报告读取失败，请重试'});
 assert.equal(button.disabled,false);assert.match(feedback.textContent,/读取失败/);
 button.click();const second=sent.filter(m=>m.type==='performanceReport').at(-1);assert.notEqual(first.requestId,second.requestId);
 emit({kind:'performance_report_result',requestId:first.requestId,ok:true,message:'过期结果'});
 assert.equal(button.disabled,true);assert.doesNotMatch(feedback.textContent,/过期结果/);
 expire();assert.equal(button.disabled,false);assert.match(feedback.textContent,/未收到诊断响应/);
 assert.equal(w.document.getElementById('messages').textContent.includes('报告读取失败'),false);assert.deepEqual(errors,[]);
});

test('手机发来的图片立即进入桌面消息，正文修正不重复且桌面草稿保留',t=>{
 const {w,emit,errors}=setup(t),input=w.document.getElementById('input');
 input.value='电脑尚未发送的草稿';input.focus();
 const image='data:image/png;base64,iVBORw0KGgo=';
 emit({kind:'remote_user',text:'手机图片',images:[image]});
 const user=w.document.querySelector('.msg.user');
 assert.equal(user.querySelector('img').getAttribute('src'),image);
 assert.equal(input.value,'电脑尚未发送的草稿');
 emit({kind:'block_start',blockType:'text',itemId:'answer'});
 emit({kind:'text_delta',text:'尚未完整'});
 emit({kind:'text_snap',text:'完整而准确的回答'});
 emit({kind:'block_end'});
 const messages=w.document.getElementById('messages').textContent;
 assert.ok(messages.includes('完整而准确的回答'));assert.ok(!messages.includes('尚未完整'));
 assert.equal(messages.split('完整而准确的回答').length-1,1);assert.deepEqual(errors,[]);
});
