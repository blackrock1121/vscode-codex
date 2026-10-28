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
  window:{showTextDocument:async()=>({selection:null,revealRange:range=>calls.push(['revealRange',range])}),showErrorMessage:m=>calls.push(['error',m]),showWarningMessage:m=>calls.push(['warning',m])},
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

test('Finder 菜单定位实际文件，支持空格、中文和行号，拒绝目录及网页',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-finder-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'配置 文件.yaml');
  await fs.writeFile(file,'config');
  const ctx={cwd:()=>root,workspaceDirs:()=>[root],resolveWorkspaceFile:proto.resolveWorkspaceFile};
  found=[];
  for(const ref of [file,'配置 文件.yaml',`file://${encodeURI(file)}#L12`,file+':8']){
    calls.length=0;
    await proto.revealFileInFinder.call(ctx,{codexFilePath:ref});
    assert.deepEqual(calls.filter(c=>Array.isArray(c)&&c[0]==='command'),[['command','revealFileInOS',{fsPath:file}]]);
    assert.equal(calls.some(c=>['openTextDocument','external'].includes(c[0])),false);
  }
  for(const ref of [root,'https://example.com/file.yaml','mailto:a@example.com',path.join(root,'missing.yaml')]){
    calls.length=0;
    await proto.revealFileInFinder.call(ctx,{codexFilePath:ref});
    assert.equal(calls.some(c=>Array.isArray(c)&&c[0]==='command'),false,ref);
  }
  calls.length=0;
  for(const context of [undefined,null,{},'path',{codexFilePath:12}]) await proto.revealFileInFinder.call(ctx,context);
  assert.deepEqual(calls,[]);
  await fs.unlink(file);
  await fs.mkdir(file);
  await proto.revealFileInFinder.call(ctx,{codexFilePath:file});
  assert.equal(calls.some(c=>Array.isArray(c)&&c[0]==='command'),false,'原文件变成目录后不能定位');
});

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

test('安装包和归档文件在文件管理器定位，不按文本打开或执行安装',async()=>{
  calls.length=0;
  const ctx={resolveWorkspaceFile:async p=>p,codeColumn:()=>2,output:{appendLine:()=>{}}};
  for(const file of ['/tmp/codex-remote-probe.apk','/tmp/app.AAB','/tmp/plugin.vsix','/tmp/archive.tar.gz','/tmp/package.zip','/tmp/setup.dmg','/tmp/app.exe']){
    await proto.openFile.call(ctx,{},file);
    assert.ok(calls.some(c=>Array.isArray(c)&&c[0]==='command'&&c[1]==='revealFileInOS'&&c[2].fsPath===file),file);
  }
  assert.equal(calls.some(c=>Array.isArray(c)&&['openTextDocument','external','error'].includes(c[0])),false);
});

test('本地图片读取为 data URI，只接受图片且限制体积',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-local-image-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const jpg=path.join(root,'qr.jpg'),txt=path.join(root,'secret.txt'),large=path.join(root,'large.png');
  await fs.writeFile(jpg,Buffer.from([0xff,0xd8,0xff]));
  await fs.writeFile(txt,'plain text');
  await fs.writeFile(large,Buffer.alloc(4*1024*1024+1));
  const ctx={resolveWorkspaceFile:async p=>p,output:{appendLine:()=>{}}};
  assert.equal(await proto.loadLocalImage.call(ctx,jpg),'data:image/jpeg;base64,/9j/');
  assert.equal(await proto.loadLocalImage.call(ctx,txt),undefined);
  assert.equal(await proto.loadLocalImage.call(ctx,large),undefined);
});

test('带行号的调用代码链接校验与打开一致，且定位到指定行',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-code-link-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'Plug ServiceImpl.java');
  await fs.writeFile(file,Array.from({length:200},(_,i)=>`line ${i+1}`).join('\n'));
  const originalOpen=vscode.workspace.openTextDocument;
  t.after(()=>{vscode.workspace.openTextDocument=originalOpen;});
  vscode.workspace.openTextDocument=async p=>{
    calls.push(['openTextDocument',p]);
    const lines=(await fs.readFile(p,'utf8')).split('\n');
    return {lineCount:lines.length,lineAt:n=>({text:lines[n]})};
  };
  const ctx={cwd:()=>root,workspaceDirs:()=>[root],resolveWorkspaceFile:proto.resolveWorkspaceFile,codeColumn:()=>2,output:{appendLine:()=>{}}};
  for(const [ref,line,end] of [
    [file+':149',149,149],
    [file+':149-153',149,153],
    [file+'#L149-L153',149,153],
    [file+':149:7',149,149],
    ['file://'+file.replace(/ /g,'%20')+':149',149,149],
  ]){
    calls.length=0;
    assert.equal(await proto.fileRefResolves.call(ctx,ref),true,ref);
    await proto.openFile.call(ctx,{},ref);
    assert.ok(calls.some(c=>c[0]==='openTextDocument'&&c[1]===file),ref);
    const range=calls.find(c=>c[0]==='revealRange')?.[1];
    assert.ok(range,ref);
    assert.equal(range.start.line,line-1);
    assert.equal(range.end.line,end-1);
    assert.equal(calls.some(c=>c[0]==='error'||c[0]==='warning'),false);
  }
});
