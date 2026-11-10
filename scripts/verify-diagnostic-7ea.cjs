// 对指定测试构建注入同一读失败+关闭失败，量化锁残留带来的下一次刷新等待。
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const Module=require('node:module'),load=Module._load;
const root=path.resolve(process.argv[2]??path.join(__dirname,'..'));
let api;
try {
  Module._load=function(name,...args){return name==='vscode'?{window:{},Uri:{},ViewColumn:{}}:load.call(this,name,...args);};
  api=require(path.join(root,'dist/test/diagnostic-safety.js'));
} finally {Module._load=load;}
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-7ea-lock-')),ledger=new api.DiagnosticLedger(dir);
  const read=fs.promises.readFile,open=fs.promises.open;
  let failing=false;
  const result={version:require(path.join(root,'package.json')).version};
  try {
    await ledger.sync([]);
    fs.promises.readFile=async(...args)=>{
      if(failing&&String(args[0]).endsWith('ledger.json'))throw Object.assign(Error('injected'),{code:'EACCES'});
      return read(...args);
    };
    fs.promises.open=async(...args)=>{
      const handle=await open(...args);
      if(String(args[0]).endsWith('ledger.lock')){
        const close=handle.close.bind(handle);
        handle.close=async()=>{await close();if(failing)throw Object.assign(Error('injected'),{code:'EIO'});};
      }
      return handle;
    };
    failing=true;
    try{await ledger.sync([]);}catch(error){result.propagatedCode=error.code;}
    result.staleLock=fs.existsSync(path.join(ledger.dir,'ledger.lock'));
    failing=false;
    const start=performance.now();
    try{await ledger.sync([]);result.retry='completed';}catch{result.retry='failed';}
    result.retryMs=Math.round((performance.now()-start)*100)/100;
    if(process.argv.includes('--expect-fixed')){
      assert.equal(result.propagatedCode,'EACCES');assert.equal(result.staleLock,false);assert.equal(result.retry,'completed');
    }
    console.log(JSON.stringify(result));
  } finally {
    fs.promises.readFile=read;fs.promises.open=open;
    fs.rmSync(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
