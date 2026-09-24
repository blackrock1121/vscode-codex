#!/usr/bin/env node
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const send = m => process.stdout.write(JSON.stringify(m)+'\n');
const note = (method,params) => send({method,params});
let text='';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(!m.method) {
  if(text==='question-with-early-output'){
   note('item/completed',{threadId:'thread-1',item:{type:'agentMessage',id:'early',text:'用户还没回答，我先继续'}});
   note('item/agentMessage/delta',{threadId:'thread-1',itemId:'after-answer',delta:'收到答案后继续'});
   note('item/completed',{threadId:'thread-1',item:{type:'agentMessage',id:'after-answer',text:'收到答案后继续'}});
  }else note('item/completed',{threadId:'thread-1',item:{type:'commandExecution',id:'cmd',command:'echo test',aggregatedOutput:JSON.stringify(m.result),exitCode:0,status:'completed'}});
  note('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});return;
 }
 if(m.method==='initialized')return;
 let result={};
 if(m.method==='account/read')result={account:{type:'chatgpt'},requiresOpenaiAuth:true};
 if(m.method==='thread/start'||m.method==='thread/resume'){
  if(!m.params.dynamicTools?.some(t=>t.name==='AskUserQuestion')){send({id:m.id,error:{code:-32602,message:'缺少 AskUserQuestion 工具'}});return;}
  result={thread:{id:'thread-1'},model:'test-model'};
 }
 if(m.method==='model/list')result={data:[{model:'test-model',displayName:'测试模型',description:'',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
 if(m.method==='thread/list')result={data:[],nextCursor:null};
 if(m.method==='turn/start')result={turn:{id:'turn-1'}};
 if(m.method==='hang')return;
 if(m.method==='malformed'){process.stdout.write('not-json\n');return;}
 if(m.method==='malformed-once'){
  const marker=path.join(process.cwd(),'.malformed-once');
  if(!fs.existsSync(marker)){fs.writeFileSync(marker,'1');process.stdout.write('not-json\n');return;}
 }
 send({id:m.id,result});
 if(m.method==='turn/start'){
  text=m.params.input.find(x=>x.type==='text')?.text||'';
  if(text==='approval'){
   note('item/started',{threadId:'thread-1',item:{type:'commandExecution',id:'cmd',command:'echo test',cwd:'/tmp'}});
   send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'cmd',command:'echo test'}});
  }else if(text==='question'||text==='legacy-question'||text==='question-with-early-output'){
   send({id:17,method:text==='question'?'tool/requestUserInput':'item/tool/requestUserInput',params:{threadId:'thread-1',turnId:'turn-1',itemId:'ask-1',isBlocking:true,questions:[{id:'q1',question:'选择什么？',header:'选择',isOther:true,isSecret:false,options:[{label:'A',description:'选项'}]}]}});
   if(text==='question-with-early-output'){
    note('item/reasoning/textDelta',{threadId:'thread-1',itemId:'early-thinking',delta:'等待期间的思考'});
    note('item/completed',{threadId:'thread-1',item:{type:'reasoning',id:'early-thinking',content:['等待期间的思考']}});
    note('item/agentMessage/delta',{threadId:'thread-1',itemId:'early',delta:'用户还没回答，我先继续'});
   }
  }
  else if(text==='dynamic-question')send({id:18,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'call-1',namespace:null,tool:'AskUserQuestion',arguments:{questions:[{id:'choice',question:'选择什么？',header:'选择',options:[{label:'A',description:'选项'}]}]}}});
  else if(text!=='wait'){
   note('item/agentMessage/delta',{threadId:'thread-1',itemId:'msg',delta:'你好'});
   note('item/completed',{threadId:'thread-1',item:{type:'agentMessage',id:'msg',text:'你好'}});
   note('thread/tokenUsage/updated',{threadId:'thread-1',tokenUsage:{last:{totalTokens:123,outputTokens:2},modelContextWindow:1000}});
   note('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});
  }
 }
 if(m.method==='turn/interrupt')note('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'interrupted'}});
 if(m.method==='thread/compact/start'){
  note('item/completed',{threadId:'thread-1',item:{id:'compact',type:'contextCompaction'}});
  note('turn/completed',{threadId:'thread-1',turn:{id:'compact-turn',status:'completed'}});
 }
});
