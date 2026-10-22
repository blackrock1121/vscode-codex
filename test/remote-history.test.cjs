const {test}=require('node:test');
const assert=require('node:assert/strict');
const {transcriptSnapshot}=require('../dist/test/remote/transcript.js');
const {parseCommand}=require('../dist/test/remote/command.js');
test('历史游标在工具追加及用量/状态刷新后仍可前翻，修改前缀必须重置',()=>{
 const items=[{type:'assistant_text',text:'此前的重要解释。'.repeat(300)},...Array.from({length:15},(_,i)=>({type:'tool',name:'Bash',input:{command:'命令'+i+'x'.repeat(100)},result:''}))];
 const first=transcriptSnapshot(items,{busy:true,run:{tokens:100}},{});assert.ok(first.start>0);assert.ok(first.messages.every(m=>m.role==='tool'));
 const query={end:first.start,revision:first.historyCursor};
 const newer=[...items,{type:'assistant_text',text:'新的说明'}];
 const previous=transcriptSnapshot(newer,{busy:true,run:{tokens:500},usage:{weekPct:57}},query);
 assert.equal(previous.reset,false);assert.equal(previous.end,first.start);assert.ok(previous.start<first.start);
 const changed=[{type:'assistant_text',text:'前文已被修改'},...items.slice(1)];assert.equal(transcriptSnapshot(changed,{busy:false},query).reset,true);
 const now=Date.now();assert.doesNotThrow(()=>parseCommand({version:1,commandId:'c',deviceId:'d',issuedAt:now,expiresAt:now+10000,target:{windowId:'w',workspaceId:'p',sessionId:'s'},operation:{kind:'session.snapshot',...query}},now));
});
test('长中文正文分页切片可无损拼接，包括角色前缀、换行、emoji 和空白',()=>{
 const text=('正文🙂\n\n'+ ' '.repeat(1800)).repeat(4)+'全文结束',items=[{type:'assistant_text',text}],parts=[];
 let page=transcriptSnapshot(items,{busy:true},{});
 for(let i=0;;i++){
  assert.ok(i<100);assert.ok(Buffer.byteLength(JSON.stringify(page))<=6500);
  for(const m of page.messages){assert.equal(m.text.length,m.sliceEnd-m.sliceStart);assert.equal(m.sliceTotal,text.length);assert.ok(m.text.isWellFormed());parts.push(m);}
  if(!page.start)break;page=transcriptSnapshot(items,{busy:true,run:{tokens:i}},{end:page.start,revision:page.historyCursor});assert.equal(page.reset,false);
 }
 parts.sort((a,b)=>a.sliceStart-b.sliceStart);assert.equal(parts.map(p=>p.text).join(''),text);
});
