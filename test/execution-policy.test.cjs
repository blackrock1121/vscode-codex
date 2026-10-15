const {test}=require('node:test');
const assert=require('node:assert/strict');
const {executionMode,executionConfig,executionInstructions}=require('../dist/test/codex/executionPolicy.js');

test('调度默认并行，可显式选择仅工具或保持标准行为',()=>{
 for(const value of [undefined,null,'parallel','invalid',true,2,{}])assert.equal(executionMode(value),'parallel');
 assert.equal(executionMode('tools'),'tools');
 assert.equal(executionMode('standard'),'standard');
 assert.equal(executionInstructions('standard'),'');
 assert.deepEqual(executionConfig('standard'),{});
});

test('并行配置仅限制最多两个子 Agent，不改模型、推理、服务档位或权限',()=>{
 assert.deepEqual(executionConfig('parallel'),{'agents.max_concurrent_threads_per_session':2});
 assert.deepEqual(executionConfig('tools'),{});
 const first=executionConfig('parallel');first['agents.enabled']=true;
 assert.deepEqual(executionConfig('parallel'),{'agents.max_concurrent_threads_per_session':2},'各次配置不得共享可变对象');
 const parallel=executionInstructions('parallel');
 assert.match(parallel,/最多同时 2 个/);
 assert.match(parallel,/继承当前模型、推理强度和权限/);
 assert.match(parallel,/不得强行启用已禁用/);
 const tools=executionInstructions('tools');
 assert.match(tools,/子 Agent 仅在用户或项目指令明确要求时使用/);
 assert.doesNotMatch(tools,/主动使用可用子 Agent/);
});

test('两种优化模式都要求收齐依赖检查最终状态，不能把后台返回当通过',()=>{
 for(const mode of ['parallel','tools']){
  const policy=executionInstructions(mode);
  assert.match(policy,/依赖该检查的构建、启动或测试，必须先收齐前置检查的最终退出码并确认通过/);
  assert.match(policy,/后台会话返回或仍在运行不代表通过/);
  assert.match(policy,/等待期间推进独立工作，不重复启动同一任务/);
  assert.match(policy,/保持用户选择的模型、推理强度、服务档位和权限，不为提速自行调整/);
 }
});

test('失败策略保留证据并区分网络和预期状态，不掩盖失败或绕过权限',()=>{
 for(const mode of ['parallel','tools']){
  const policy=executionInstructions(mode);
  assert.match(policy,/退出码、第一处有效错误和必要的 stderr 摘要/);
  assert.match(policy,/临时网络故障只做有上限的重试，不据此修改业务代码/);
  assert.match(policy,/已知预期的 registry 401 认证挑战/);
  assert.match(policy,/其他认证失败须调查，不绕过权限/);
  assert.match(policy,/禁止用 \|\| true、删除断言或降低标准掩盖失败/);
  assert.match(policy,/不能只加 sleep 或反复放宽期限/);
  assert.match(policy,/不例行重复版本或 --help 检查/);
  assert.ok(policy.length<=1400,'附加指令应保持紧凑，避免持续增加上下文和等待');
 }
});
