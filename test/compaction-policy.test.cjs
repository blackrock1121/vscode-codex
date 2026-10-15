const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {CompactionPolicy,CompactionValidationStore,modelRank,VALIDATION_TOTAL}=require('../dist/test/codex/compactionPolicy.js');
const {ValidationBudget,scoreValidation,validationFixture,validationSchema}=require('../dist/test/codex/compactionValidation.js');
const model=(id,extra={})=>({id,efforts:['medium','xhigh'],speedModes:['default','fast'],...extra});
const result=(extra={})=>({passed:true,baselineModel:'gpt-6.1-sol',baselineMs:1000,candidateMs:900,baselineScore:VALIDATION_TOTAL,candidateScore:VALIDATION_TOTAL,total:VALIDATION_TOTAL,...extra});
const catalog=[model('gpt-6.1-sol',{upgrade:'gpt-6.2-sol'}),model('gpt-6.2-sol'),model('gpt-6-astra')];

test('家族决定层级：Sol/Luna 包括未来版本都沿用会话，未知/模糊名称不猜测',()=>{
 const p=new CompactionPolicy(new CompactionValidationStore());
 for(const source of ['gpt-6-sol','gpt-6.1-sol','gpt-6.2-sol','gpt-7-sol','gpt-6-luna','gpt-6.2-luna','custom-astra','gpt-6','gpt-6-sol-mini','gpt-6-astra-fast']){
  assert.equal(p.select(source,null,catalog),undefined,source);assert.equal(p.pending(source,catalog),undefined,source);
 }
 for(const source of ['gpt-6-astra','gpt-6.2-astra','gpt-7-astra','gpt-6-astra-2026-10-15'])assert.equal(p.select(source,null,catalog).model,'gpt-6.1-sol');
 assert.equal(modelRank('gpt-6.2-sol'),2);assert.equal(modelRank('unknown'),undefined);
});

test('官方后继型号仅列候选，完整质量和耗时通过后自动与手动选择同一新目标',()=>{
 const store=new CompactionValidationStore(),p=new CompactionPolicy(store);
 assert.equal(p.pending('gpt-6-astra',catalog).id,'gpt-6.2-sol');
 assert.equal(p.select('gpt-6-astra',null,catalog).model,'gpt-6.1-sol');
 assert.equal(store.claim('gpt-6.2-sol'),true);store.complete('gpt-6.2-sol',result());
 for(const source of ['gpt-6-astra','gpt-6.2-astra'])assert.deepEqual(p.select(source,'priority',catalog),{model:'gpt-6.2-sol',effort:'xhigh'});
 assert.equal(p.pending('gpt-6-astra',catalog),undefined);
 // 旧推荐关系仍存在时也不会漏掉新一代，6.10 不能按字符串排在 6.2 后。
 const next=[...catalog,model('gpt-6.10-sol')];assert.equal(p.pending('gpt-6-astra',next).id,'gpt-6.10-sol');
 assert.equal(store.claim('gpt-6.10-sol'),true);store.complete('gpt-6.10-sol',result());
 assert.equal(p.select('gpt-6-astra',null,next).model,'gpt-6.10-sol');
});

test('失败/不完整/过慢均保留基线；旧型号消失时沿用会话，不凭空构造替代型号',()=>{
 for(const bad of [undefined,result({passed:false}),result({candidateScore:21}),result({baselineScore:21}),result({candidateMs:2000}),result({total:1,baselineScore:1,candidateScore:1})]){
  const store=new CompactionValidationStore(),p=new CompactionPolicy(store);store.claim('gpt-6.2-sol');store.complete('gpt-6.2-sol',bad);
  assert.equal(p.select('gpt-6-astra',null,catalog).model,'gpt-6.1-sol');
  assert.equal(p.select('gpt-6-astra',null,catalog.filter(m=>m.id!=='gpt-6.1-sol')),undefined);
  assert.equal(store.claim('gpt-6.2-sol'),false);
 }
});

test('收费档位和推理能力必须匹配；手动指定也不能给 Sol/Luna 升级模型',()=>{
 const store=new CompactionValidationStore(),p=new CompactionPolicy(store);
 const plain=[model('gpt-6.1-sol',{speedModes:['default']})];
 assert.ok(p.select('gpt-6-astra','default',plain));assert.equal(p.select('gpt-6-astra','priority',plain),undefined);
 for(const tier of ['flex','auto','ultrafast'])assert.equal(p.select('gpt-6-astra',tier,catalog),undefined);
 assert.equal(p.select('gpt-6-astra',null,[model('gpt-6.1-sol',{efforts:['medium']})]),undefined);
 const explicit=new CompactionPolicy(store,'gpt-6.2-sol');assert.equal(explicit.select('gpt-6-astra',null,catalog),undefined);
 store.claim('gpt-6.2-sol');store.complete('gpt-6.2-sol',result());
 assert.equal(explicit.select('gpt-6-astra',null,catalog).model,'gpt-6.2-sol');
 for(const id of ['gpt-6-sol','gpt-6-luna','unknown'])assert.equal(explicit.select(id,null,catalog),undefined);
});

test('跨实例持久化、原子领取、每天限额和失败记录避免重启/多窗口重复评测',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'compact-policy-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new CompactionValidationStore(dir),b=new CompactionValidationStore(dir);
 assert.equal(a.claim('gpt-6.2-sol'),true);assert.equal(b.claim('gpt-6.2-sol'),false);assert.equal(b.claim('gpt-6.3-sol'),false);
 b.complete('gpt-6.2-sol',result());assert.equal(b.validated('gpt-6.2-sol'),false);
 a.complete('gpt-6.2-sol',result());assert.equal(b.validated('gpt-6.2-sol'),true);
 assert.equal(new CompactionValidationStore(dir).claim('gpt-6.2-sol'),false);
 const rows=fs.readdirSync(dir).map(f=>fs.readFileSync(path.join(dir,f),'utf8')).join('');assert.doesNotMatch(rows,/authorization|历史诊断|port/);
});

test('评测预算跨重试限制生成/输入，普通档、禁用工具、限制输出；测试问题没有答案枚举',()=>{
 let exceeded=0;const b=new ValidationBudget(()=>exceeded++);
 const compact={type:'response.create',input:[{type:'compaction_trigger'}],service_tier:'priority',tools:[{name:'bad'}]};
 for(let i=0;i<4;i++){const out=JSON.parse(b.constrain(Buffer.from(JSON.stringify(i<2?compact:{...compact,input:[]}))));assert.equal(out.max_output_tokens,i<2?20000:2048);assert.deepEqual(out.tools,[]);assert.equal(out.tool_choice,'none');assert.equal(out.service_tier,'default');}
 assert.throws(()=>b.constrain(Buffer.from(JSON.stringify(compact))));assert.equal(exceeded,1);
 const large=new ValidationBudget(()=>exceeded++);assert.throws(()=>large.constrain(Buffer.from(JSON.stringify({input:'x'.repeat(193*1024)}))));
 assert.equal(scoreValidation({}),0);assert.ok(validationFixture().length>25);assert.doesNotMatch(JSON.stringify(validationSchema),/f83a902|4317|enum/);
});


test('预算只统计真正发出的正文，删除的工具目录不误伤新型号；输出总量也拦住重试',()=>{
 const budget=new ValidationBudget(()=>{});
 const out=budget.constrain(Buffer.from(JSON.stringify({tools:[{description:'x'.repeat(250*1024)}],input:[]})));
 assert.ok(budget.bytes<1024);assert.deepEqual(JSON.parse(out).tools,[]);
 const compact=Buffer.from(JSON.stringify({input:[{type:'compaction_trigger'}]}));
 const retry=new ValidationBudget(()=>{});retry.constrain(compact);retry.constrain(compact);assert.throws(()=>retry.constrain(compact));
 assert.equal(retry.generations,3);
 const warmup=new ValidationBudget(()=>{});for(let i=0;i<12;i++)warmup.constrain(Buffer.from('{"generate":false}'));
 assert.throws(()=>warmup.constrain(Buffer.from('{"generate":false}')));assert.equal(warmup.generations,0);
});

test('模型目录保留官方升级关系，忽略隐藏型号和非法升级字段',()=>{
 const {modelChoices}=require('../dist/test/shared.js');
 const list=modelChoices([{model:'gpt-6.1-sol',upgrade:'gpt-6.2-sol',upgradeInfo:{model:'gpt-6.3-sol'}},
  {model:'gpt-6.4-sol',hidden:true},{model:'gpt-6-luna',upgrade:7,upgradeInfo:{model:null}}]);
 assert.equal(list.length,2);assert.equal(list[0].upgrade,'gpt-6.2-sol');assert.equal(list[0].upgradeInfo.model,'gpt-6.3-sol');
 assert.equal(list[1].upgrade,undefined);assert.equal(list[1].upgradeInfo,undefined);
});
