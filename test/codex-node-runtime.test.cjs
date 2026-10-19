const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CodexRpc,codexSpawnEnvironment}=require('../dist/test/codex/rpc.js');
const sparsePath=process.platform==='darwin'?'/usr/bin:/bin:/usr/sbin:/sbin':'';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-node-')),file=path.join(dir,'codex');
 fs.writeFileSync(file,`#!/usr/bin/env node\nrequire(${JSON.stringify(path.resolve('test/fake-codex.cjs'))});\n`,{mode:0o755});
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,file};
}
test('GUI 未加载 nvm PATH 时，使用 Codex 同安装目录 node 完成真实子进程握手',async t=>{
 const {dir,file}=fixture(t);fs.symlinkSync(process.execPath,path.join(dir,'node'));
 const env={PATH:sparsePath,KEEP_SETTING:'unchanged'},launch=codexSpawnEnvironment(file,env);
 assert.equal(env.PATH,sparsePath);assert.equal(launch.PATH.split(path.delimiter)[0],dir);assert.equal(launch.KEEP_SETTING,'unchanged');
 const rpc=new CodexRpc(file,dir,env);t.after(()=>rpc.disposeAndWait());await rpc.start();
 assert.deepEqual(await rpc.request('echo',{working:true}),{working:true});assert.equal(rpc.isClosed,false);
});
test('CLI 存在但 node 缺失时显示明确依赖错误，管理连接也不隐藏原因',async t=>{
 const {dir,file}=fixture(t),rpc=new CodexRpc(file,dir,{PATH:''});t.after(()=>rpc.disposeAndWait());
 await assert.rejects(rpc.start(),error=>error.code==='ENOENT'&&/找不到 Node.js/.test(error.message));assert.equal(rpc.isClosed,true);
});
test('原生可执行文件、不可读路径与现有 PATH 不被替换，用户环境不被修改',t=>{
 const {dir,file}=fixture(t);fs.symlinkSync(process.execPath,path.join(dir,'node'));
 const env={PATH:dir+path.delimiter+sparsePath};assert.equal(codexSpawnEnvironment(file,env),env);
 assert.equal(codexSpawnEnvironment(process.execPath,env),env);
 assert.equal(codexSpawnEnvironment(path.join(dir,'missing'),env),env);
 assert.equal(codexSpawnEnvironment('custom-codex',env),env);
});
