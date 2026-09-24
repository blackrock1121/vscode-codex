const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');

const calls=[];
let found=[];
const vscode={
  Uri:{parse:url=>({fsPath:decodeURIComponent(new URL(url).pathname),scheme:new URL(url).protocol.slice(0,-1)}),file:p=>({fsPath:p})},
  workspace:{findFiles:async()=>{calls.push('findFiles');return found.map(fsPath=>({fsPath}));},asRelativePath:p=>p,openTextDocument:async p=>{calls.push(['openTextDocument',p]);return {lineCount:2,lineAt:n=>({text:n?'末行':'首行'})};}},
  commands:{executeCommand:async(...args)=>{calls.push(['command',...args]);}},
  env:{openExternal:async uri=>{calls.push(['external',uri.fsPath]);return true;}},
  window:{showTextDocument:async()=>({selection:null,revealRange:()=>{}}),showErrorMessage:m=>calls.push(['error',m]),showWarningMessage:m=>calls.push(['warning',m])},
  Position:class{constructor(line,character){this.line=line;this.character=character;}},
  Selection:class{constructor(start,end){this.start=start;this.end=end;}},
  Range:class{constructor(start,end){this.start=start;this.end=end;}},
  TextEditorRevealType:{InCenter:1},
};
const originalLoad=Module._load;
Module._load=function(id,...args){if(id==='vscode')return vscode;return originalLoad.call(this,id,...args);};
const {ChatViewProvider}=require('../dist/test/panel/chatViewProvider.js');
Module._load=originalLoad;
const proto=ChatViewProvider.prototype;

test('本地链接严格解析路径，不把失效的绝对路径跳到同名文件',async t=>{
  calls.length=0;
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-links-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'docs'));
  const exact=path.join(root,'docs','guide.md');
  await fs.writeFile(exact,'内容');
  const spaced=path.join(root,'a b.pdf');
  await fs.writeFile(spaced,'文档');
  found=[exact];
  const ctx={cwd:()=>root,workspaceDirs:()=>[root]};
  assert.equal(await proto.resolveWorkspaceFile.call(ctx,'docs/guide.md',false),exact);
  assert.equal(await proto.resolveWorkspaceFile.call(ctx,`file://${exact}`,false),exact);
  assert.equal(await proto.resolveWorkspaceFile.call(ctx,`file://${spaced.replace(/ /g,'%20')}`,false),spaced);
  assert.equal(await proto.resolveWorkspaceFile.call(ctx,path.join(root,'missing','guide.md'),false),undefined);
  assert.equal(await proto.resolveWorkspaceFile.call(ctx,'other/guide.md',false),undefined);
  assert.equal(await proto.resolveWorkspaceFile.call(ctx,'guide.md',false),exact);
  assert.equal(calls.filter(c=>c==='findFiles').length,2);
});

test('图片在 VS Code 预览，办公文档用系统应用，文本保留行号',async()=>{
  calls.length=0;
  const ctx={resolveWorkspaceFile:async p=>p,codeColumn:()=>2,output:{appendLine:()=>{}}};
  await proto.openFile.call(ctx,{},'/tmp/image.jpg');
  assert.ok(calls.some(c=>Array.isArray(c)&&c[0]==='command'&&c[1]==='vscode.open'&&c[2].fsPath==='/tmp/image.jpg'),JSON.stringify(calls));
  await proto.openFile.call(ctx,{},'/tmp/report.pdf');
  await proto.openFile.call(ctx,{},'/tmp/report.docx');
  assert.ok(calls.some(c=>Array.isArray(c)&&c[0]==='external'&&c[1]==='/tmp/report.pdf'));
  assert.ok(calls.some(c=>Array.isArray(c)&&c[0]==='external'&&c[1]==='/tmp/report.docx'));
  await proto.openFile.call(ctx,{},'/tmp/guide.md',99);
  assert.ok(calls.some(c=>Array.isArray(c)&&c[0]==='openTextDocument'&&c[1]==='/tmp/guide.md'));
  assert.equal(calls.some(c=>Array.isArray(c)&&c[0]==='error'),false);
});
