const {test}=require('node:test');
const assert=require('node:assert/strict');
const {RunProgress}=require('../dist/test/remote/runProgress.js');
test('整轮计时跨模型和工具，重复忙碌、快照和额度心跳不伪造进展',()=>{
 const p=new RunProgress();assert.equal(p.snapshot(),null);
 p.observe({kind:'busy',busy:true},1000);const id=p.snapshot().id;
 p.observe({kind:'busy',busy:true},2000);assert.equal(p.snapshot().startedAt,1000);
 p.observe({kind:'tool_input',toolId:'one',name:'Bash',input:{}},3000);assert.equal(p.snapshot().phase,'tools');
 p.observe({kind:'usage',weekPct:40},4000);p.observe({kind:'status',label:'工具仍在输出…'},5000);
 assert.equal(p.snapshot().lastProgressAt,3000);
 p.observe({kind:'activity',label:'命令产生新输出'},6000);assert.equal(p.snapshot().lastProgressAt,6000);
 p.observe({kind:'tool_result',toolUseId:'one',content:'done',isError:false},7000);assert.equal(p.snapshot().phase,'model');
 p.observe({kind:'block_end'},8000);assert.equal(p.snapshot().progress,'模型阶段完成');
 p.observe({kind:'result',isError:false},9000);p.observe({kind:'busy',busy:false},10000);assert.equal(p.snapshot().finishedAt,9000);
 p.observe({kind:'activity',label:'迟到'},11000);assert.equal(p.snapshot().lastProgressAt,8000);
 p.observe({kind:'busy',busy:true},12000);assert.notEqual(p.snapshot().id,id);assert.equal(p.snapshot().startedAt,12000);assert.equal(p.snapshot().tokens,0);
});
test('Token 与桌面口径一致：消息累计归零后继续累加，思考取最大，估算明确标记',()=>{
 const p=new RunProgress();p.observe({kind:'busy',busy:true},1);
 p.observe({kind:'tokens',output:100},2);p.observe({kind:'tokens',output:150},3);p.observe({kind:'tokens',output:20},4);assert.equal(p.snapshot().tokens,170);
 p.observe({kind:'thinking_tokens',tokens:200},5);p.observe({kind:'thinking_tokens',tokens:10},6);assert.equal(p.snapshot().tokens,200);
 p.observe({kind:'text_delta',text:'中'.repeat(300)},7);assert.equal(p.snapshot().tokens,315);assert.equal(p.snapshot().estimated,true);
 p.observe({kind:'tokens',output:300},8);assert.equal(p.snapshot().tokens,450);assert.equal(p.snapshot().estimated,false);
});
test('等待用户期间不误报模型工作，恢复后继续接收真实进展',()=>{
 const p=new RunProgress();p.observe({kind:'busy',busy:true},100);
 p.observe({kind:'permission_request',requestId:'q',toolName:'AskUserQuestion',input:{},suggestions:[]},200);
 p.observe({kind:'activity',label:'等待中'},300);assert.equal(p.snapshot().phase,'waiting');assert.equal(p.snapshot().lastProgressAt,100);
 p.observe({kind:'permission_resolved',requestId:'q',behavior:'allow'},400);assert.equal(p.snapshot().phase,'model');
 p.observe({kind:'text_delta',text:'继续'},500);assert.equal(p.snapshot().lastProgressAt,500);
});
