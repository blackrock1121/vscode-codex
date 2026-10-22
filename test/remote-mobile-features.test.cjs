const {test}=require('node:test');
const assert=require('node:assert/strict');
const {SessionTaskQueue}=require('../dist/test/remote/taskQueue.js');
const {checkedItem,itemRevision,imageChunk,sourceUserIndex,imageSources,RemoteImageReader}=require('../dist/test/remote/timeline.js');
const {transcriptSnapshot}=require('../dist/test/remote/transcript.js');
const task=text=>({text,images:[],files:[],contexts:[],labels:[],imageUris:[]});
test('手机等待队列只派发一次，忙碌时保留，失败暂停且允许恢复',async()=>{
 const queue=new SessionTaskQueue(),a=queue.add(task('A')),b=queue.add(task('B'));let release;
 const sent=[],send=item=>{sent.push(item.text);return new Promise(resolve=>release=resolve);};
 await queue.drain(()=>false,send);assert.equal(sent.length,0);
 const first=queue.drain(()=>true,send);await queue.drain(()=>true,send);assert.deepEqual(sent,['A']);assert.throws(()=>queue.remove(a.id),/QUEUE_DISPATCHING/);
 release(true);await first;assert.equal(queue.items[0].id,b.id);
 await queue.drain(()=>true,async()=>false);assert.equal(queue.paused,true);assert.equal(queue.items.length,1);
 await queue.drain(()=>true,async()=>{assert.fail('暂停不能发送');});queue.paused=false;await queue.drain(()=>true,async()=>true);assert.equal(queue.items.length,0);
});
test('排队图片保留，删除及容量上限防止内存无界增长',()=>{
 const queue=new SessionTaskQueue();for(let i=0;i<30;i++)queue.add(task(String(i)));assert.throws(()=>queue.add(task('overflow')),/QUEUE_FULL/);
 queue.remove(queue.items[0].id);assert.equal(queue.items.length,29);assert.throws(()=>queue.remove('missing'),/QUEUE_CHANGED/);
});
test('历史图片逐块完整读取且拒绝错误指纹、越界和非图片内容',()=>{
 const bytes=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(9000,4)]);
 const item={type:'user',text:'A',images:['data:image/png;base64,'+bytes.toString('base64')]};
 const parts=[];for(let offset=0;offset<bytes.length;){const chunk=imageChunk(item,0,offset);parts.push(Buffer.from(chunk.data,'base64'));assert.ok(Buffer.byteLength(JSON.stringify(chunk))<6500);offset=chunk.next;}
 assert.deepEqual(Buffer.concat(parts),bytes);assert.equal(checkedItem([item],0,itemRevision(item)),item);assert.throws(()=>checkedItem([{...item,text:'B'}],0,itemRevision(item)),/MESSAGE_CHANGED/);
 assert.throws(()=>imageChunk(item,1,0),/IMAGE_NOT_AVAILABLE/);assert.throws(()=>imageChunk(item,0,bytes.length+1),/INVALID_OFFSET/);
 assert.throws(()=>imageChunk({type:'image',src:'https://example.com/private'},0,0),/IMAGE_NOT_AVAILABLE/);
 assert.equal(sourceUserIndex([item,{type:'assistant_text',text:'reply'}],1),0);
});
test('消息按钮携带准确索引与指纹，图片不进入普通快照，帧预算保持有效',()=>{
 const items=[{type:'user',text:'图片',images:['data:image/png;base64,'+'A'.repeat(50000)]},{type:'assistant_text',text:'回答'},{type:'image',src:'data:image/png;base64,AAAA'}];
 const result=transcriptSnapshot(items,{busy:false},{ });
 assert.equal(result.messages[0].imageCount,1);assert.equal(result.messages[0].messageRevision,itemRevision(items[0]));assert.equal(result.messages[1].actionable,true);assert.equal(result.messages[2].imageCount,1);
 assert.ok(!JSON.stringify(result).includes('base64'));assert.ok(Buffer.byteLength(JSON.stringify(result))<=6500);
});

test('中间回复与工具执行中的快照不可重新生成，整轮结束才恢复操作',()=>{
 const items=[{type:'user',text:'开始工作'},{type:'assistant_text',text:'我先检查'},{type:'tool',name:'Bash',input:{command:'test'}}];
 for(const state of [{busy:true},{busy:false,waiting:true}])assert.ok(transcriptSnapshot(items,state,{}).messages.every(m=>!m.actionable));
 assert.equal(transcriptSnapshot(items,{busy:false,waiting:false},{}).messages.find(m=>m.role==='assistant').actionable,true);
});

test('模型生成图片和工具内嵌图片可读取，只接受历史引用的图片文件',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'generated-image-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(7000)]);fs.writeFileSync(path.join(dir,'picture.png'),png);fs.writeFileSync(path.join(dir,'fake.png'),'not a picture');
 const tool={type:'tool',name:'imageGeneration',input:{savedPath:path.join(dir,'picture.png')},result:'{}'},reader=new RemoteImageReader();
 assert.equal(imageSources(tool).length,1);assert.equal((await reader.read(tool,0,0,dir)).total,png.length);
 assert.equal(imageSources({type:'tool',name:'mcp__imagegen',input:{},result:JSON.stringify({content:[{type:'image',mimeType:'image/png',data:png.toString('base64')}]})}).length,1);
 assert.equal(imageSources({type:'assistant_text',text:'![成品](picture.png)'}).length,1);
 await assert.rejects(reader.read({type:'assistant_text',text:'![假图](fake.png)'},0,0,dir),/IMAGE_NOT_AVAILABLE/);
 await assert.rejects(reader.read(tool,2,0,dir),/IMAGE_NOT_AVAILABLE/);
});
