# Codex Copilot

基于 `claude-chat-main` 的 Copilot 风格 VS Code 编程助手。界面与交互复用原项目，底层重写为本机 **Codex app-server**，复用 Codex 自己的登录与账号能力。

QQ 机器人、SLS 日志查询已移除。不发送主动缓存预热消息；打开已有会话时只提前建立连接并恢复会话。

## 安装

要求 VS Code 1.90+，本机已安装 Codex CLI。当前协议与真实集成测试基于 **codex-cli 0.156.1**；旧版本可能缺少分页历史、指定轮次派生及删除接口，请先升级。

```bash
code --install-extension release/vscode-codex.vsix --force
```

也可在扩展面板选择“从 VSIX 安装”，选取 `release/vscode-codex.vsix`。安装后打开可信任的项目，点击活动栏 Codex 图标，新建会话。

- 已在本机 Codex 登录：直接复用。
- 未登录：命令面板运行 **Codex: 登录账号**，浏览器完成官方登录。
- CLI 找不到：配置 `codexChat.codexPath` 为可执行文件绝对路径。
- 账号详情：命令面板运行 **Codex: 查看账号状态**。

插件不读取或另存 OAuth 密钥，不把 ChatGPT 订阅转成 API Key。实际用量与可用模型由 Codex 和账号决定。SSH、容器和远程工作区需要在扩展运行所在环境安装、登录 Codex。

## 功能

- 流式聊天、Markdown、代码高亮、可折叠思考、工具卡片及审批。
- 多会话标签页、恢复历史、重命名、置顶、批量删除、重开关闭的标签。
- 动态模型列表、推理强度、权限模式、全局追加指令与项目 `AGENTS.md`。
- 文件选择和拖入、选中代码附加、图片粘贴、大图、复制和保存。
- 文件／行号／符号引用跳转，代码块复制和发送到终端。
- 随时停止、消息队列、编辑重发、最后一条回复重新生成。
- 聊天内容搜索、提问目录、长历史分段展示、草稿恢复及输入历史。
- 文件改动汇总、原生 diff、逐个或全部保留／回滚。
- 每轮还原点、对话回退、从历史节点派生独立会话。
- `/help`、`/clear`、`/compact`、`/model`、`/effort`、`/usage`。
- 订阅用量、服务端报告的上下文占用；没有报告时不猜模型容量。
- 连接预启动、后台连接保留、轮次超时检测、界面心跳恢复、本地日志。
- 可选 webhook 完成／等待输入通知，以及从本项目仓库检查更新。

配置项在设置中搜索 `codexChat`。快捷键：`Cmd/Ctrl+Shift+I` 聚焦输入；`Cmd/Ctrl+Shift+L` 添加选区；聊天内 `Cmd/Ctrl+F` 搜索。

## 权限和回滚

| 模式 | 实际行为 |
| --- | --- |
| 按需审批 `default` | 只读沙箱；Codex 请求写入／额外权限时显示审批 |
| 自动编辑 `acceptEdits` | 允许工作区写入；额外权限仍需审批 |
| 只读 `plan` | 只读沙箱，不允许提权 |
| 完全访问 `bypassPermissions` | 不设沙箱限制，不请求审批；仅在明确需要时选择 |

修改权限、模型或推理强度对**下一轮**生效，不改变已经执行中的操作。Codex 的只读模式不是 Claude 的规划协议，不保证先展示计划再执行。

每轮发送前默认保存工作区中已打开的脏文件，再读取文本文件基线。快照单文件上限 2 MB，每轮总上限 64 MB，每个根目录最多扫描 20,000 个文件；跳过二进制、符号链接以及 `.git`、依赖、常见构建目录。工作区外路径没有自动回滚保障。快照不等同于 Git 备份；回滚前请确认自己的后续编辑是否要保留。

大型项目可在工作区设置中配置 `codexChat.snapshotExclude`，例如 `["coverage/**", "**/*.log"]`。规则相对于工作区根目录，`*` 匹配一层、`**` 可跨目录；排除路径不会纳入“已更改文件”及“还原到此处”的文件回滚。未排除但因体积、格式或上限跳过的路径会在“Codex Chat”输出通道列出原因，同一批路径只提示一次。

原生历史由 `thread/read` / 分页接口读取，回退使用官方 `thread/fork`，旧会话归档作为恢复退路；用户主动删除使用官方归档后删除接口。插件不直接改写 Codex 的数据库或 JSONL。

其他入口创建的历史没有本插件文件快照，只能回退对话。终端代码块的“执行”按钮、外部程序的副作用，以及数据库／远程服务修改不属于文件回滚范围。

## 开发与验证

```bash
npm ci
npm run check-types
npm run build
npm test
npm run package
```

按 F5 启动扩展开发宿主。真实账号集成测试会发送简短模型请求、使用少量账号用量，并自动清理自己的测试会话：

```bash
npm run smoke
node scripts/smoke-process.cjs
npm run smoke:question
```

测试覆盖真实协议握手、登录读取、模型列表、对话、分页历史、派生、改名、删除，以及适配层真实工具审批、临时文件修改和续聊。自动测试另外覆盖错误处理、图片历史、回滚、消息与界面交互。`smoke:question` 使用 `gpt-6-astra`、medium 推理和绕过权限，分别验证新会话及恢复会话：问题展示前后端确认中断，在尚未回答时销毁并重建进程，恢复问题后等待 65 秒不执行工具，提交答案后才续轮写入测试文件。等待状态保存在插件存储目录，取消、回答或会话已续聊后会清除；私密回答在聊天历史中遮蔽。DOM 测试不替代 VS Code 中的视觉和快捷键验收。

日志位于 `~/.codex-chat/logs/`；命令面板“Codex: 打开日志文件夹”可直达。插件快照保存在 VS Code 扩展全局存储中。

## 发布

远程仓库：`git@github.com:blackrock1121/vscode-codex.git`。按项目 `AGENTS.md` 的发布闭环，每次功能或缺陷修复通过验证后同步打包、提交、推送并安装到本机 VS Code。

更新功能读取仓库根目录 `package.json` 与 `release/vscode-codex.vsix`，发布时两者需要同步更新并推送。私有仓库的未认证 GitHub 请求无法读取更新，需手动分发 VSIX。没有发布新包前，自动更新不会安装任何本地未推送改动。

## 来源和许可证

界面与通用功能源自 [TomHusky/claude-chat](https://github.com/TomHusky/claude-chat)，保留 [MIT 许可证](LICENSE.md)。参考源码 `claude-chat-main` 仅保留在本地，不进入新仓库和 VSIX。

Codex 接入依据 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 与本机 CLI 生成的协议类型。此项目是独立插件，并非 OpenAI 或 GitHub 官方扩展。

图标使用 OpenAI 的 GPT／Blossom 标志，商标与图形归 OpenAI 所有。图标来源为本机官方 `openai.chatgpt` 扩展资源；本插件仍为独立项目。
