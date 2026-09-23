/**
 * Message contract between the extension host and the webview.
 * Imported by both `src/panel/*` (Node) and `src/webview/*` (browser),
 * so it must stay free of any runtime imports.
 */

/** Minimal monochrome line icons (stroke = currentColor). Shared by host + webview. */
const _s = (p: string, fill = false): string =>
  `<svg viewBox="0 0 16 16" ${fill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"'}>${p}</svg>`;

export const ICONS: Record<string, string> = {
  add: _s('<path d="M8 3.5v9M3.5 8h9"/>'),
  send: _s('<path d="M8 12.5V4M4.6 7.4 8 4l3.4 3.4"/>'),
  stop: _s('<rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/>', true),
  attach: _s('<path d="M11.6 7.1 6.8 11.9a2.3 2.3 0 0 1-3.25-3.25l5.2-5.2a1.4 1.4 0 0 1 2 2L5.6 10.7a.5.5 0 0 1-.7-.7l4.5-4.5"/>'),
  terminal: _s('<rect x="2.5" y="3" width="11" height="10" rx="1.6"/><path d="M5 7l2 1.6-2 1.6"/><path d="M8.6 10.4h2.9"/>'),
  search: _s('<circle cx="7" cy="7" r="3.8"/><path d="M9.9 9.9 13 13"/>'),
  web: _s('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11"/><path d="M8 2.5c2.3 2.2 2.3 8.8 0 11"/><path d="M8 2.5c-2.3 2.2-2.3 8.8 0 11"/>'),
  task: _s('<rect x="3" y="3" width="10" height="10" rx="2.2"/><path d="M6 8.2 7.3 9.5 10.2 6.4"/>'),
  tool: _s('<rect x="3.5" y="3.5" width="9" height="9" rx="2.2"/>'),
  file: _s('<path d="M4 2.5h4.5L12 6v7.5H4z"/><path d="M8.5 2.5V6H12"/>'),
  copy: _s('<rect x="5.4" y="5.4" width="7.1" height="7.1" rx="1.6"/><path d="M3.5 10.4V4a.5.5 0 0 1 .5-.5h6.4"/>'),
  play: _s('<path d="M5 3.8v8.4l7-4.2z"/>'),
  update: _s('<path d="M12.7 8a4.7 4.7 0 1 1-1.4-3.35"/><path d="M12.9 2.8v2.4h-2.4"/>'),
  undo: _s('<path d="M5.5 4.2 2.5 7l3 2.8"/><path d="M2.7 7h6.1a4.1 4.1 0 0 1 0 8.2H6.7"/>'),
  // Directional/confirm glyphs — the UI used to draw these with text characters
  // ("⌄", "‹", "›", "✓"), which pick up the UI font's own metrics and sit off-centre.
  chevron: _s('<path d="M4.5 6.5 8 10l3.5-3.5"/>'),
  chevronLeft: _s('<path d="M9.5 4.5 6 8l3.5 3.5"/>'),
  chevronRight: _s('<path d="M6.5 4.5 10 8l-3.5 3.5"/>'),
  check: _s('<path d="M3.5 8.4 6.3 11.2 12.5 5"/>'),
  // git-fork：从一点派生分支（还原点分割线上的「派生新会话」）
  fork: _s('<circle cx="4.5" cy="3.9" r="1.7"/><circle cx="11.5" cy="3.9" r="1.7"/><circle cx="8" cy="12.1" r="1.7"/><path d="M4.5 5.6v.3a2.7 2.7 0 0 0 2.7 2.7h1.6a2.7 2.7 0 0 0 2.7-2.7v-.3"/><path d="M8 8.6v1.8"/>'),
  // four-point sparkle — the model picker's glyph
  model: _s('<path d="M8 2.2 9.5 6.5 13.8 8 9.5 9.5 8 13.8 6.5 9.5 2.2 8 6.5 6.5z"/>'),

};



// ---- Extension host -> webview --------------------------------------------

export type ToWebview =
  | { kind: "models"; models: { id: string; name: string; description: string; efforts: string[]; defaultEffort?: string; isDefault?: boolean }[] }
  /** `permissionMode` is the mode the CLI process ACTUALLY runs in (from its
   *  init event) — the picker syncs to this, never to a local guess. */
  | { kind: "session"; sessionId: string; model: string; cwd: string; tools: string[]; resumed?: boolean; permissionMode?: string }
  | { kind: "busy"; busy: boolean }
  /** 还原点回退正在自动停止进行中的回复：界面立刻冻结直播观感并给出过渡提示，
   *  等待随后的 busy:false + load_history 收尾（进程真实退出最长要等 5s）。 */
  | { kind: "restoring" }
  | { kind: "status"; label: string }
  | { kind: "block_start"; blockType: "text" | "thinking" | "tool_use"; toolId?: string; toolName?: string }
  | { kind: "text_delta"; text: string }
  /** 完整消息与 delta 累计不一致时的权威快照：整块替换当前直播文本。 */
  | { kind: "text_snap"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_input"; toolId: string; name: string; displayName?: string; input: Record<string, unknown> }
  | { kind: "tool_input_partial"; toolId: string; name: string; json: string }
  | { kind: "tool_result"; toolUseId: string; content: string; isError: boolean }
  | {
      kind: "permission_request";
      requestId: string;
      toolUseId?: string;
      toolName: string;
      displayName?: string;
      input: Record<string, unknown>;
      description?: string;
      suggestions: PermissionSuggestionView[];
    }
  | { kind: "permission_resolved"; requestId: string; behavior: "allow" | "deny"; auto?: boolean }
  | { kind: "tokens"; output: number }
  | { kind: "thinking_tokens"; tokens: number }
  /** 纯诊断信息：只进输出通道日志，绝不显示到界面。 */
  | { kind: "diag"; message: string }
  /** 看门狗心跳：webview 必须立即回 pong。通道半死（页面活着但消息不通）时
   *  宿主据此发现并重建 webview——否则表现为"永远转圈/按钮全聋"。 */
  | { kind: "ping"; id: number }
  /** 重建 webview 后回填输入框草稿（宿主侧持有，整页重载不丢）；
   *  还原到此处时随草稿带回该轮消息的图片附件。 */
  | { kind: "draft"; text: string; images?: { mediaType: string; data: string }[] }
  | { kind: "update_available"; version: string }
  | { kind: "context"; used: number; total: number }
  | { kind: "refs_validated"; invalid: string[] }
  | { kind: "result"; isError: boolean; costUsd?: number; durationMs?: number; numTurns?: number }
  /** weekModel*: 除 "all models" 外的按模型周限额行（CLI 输出哪个模型就显示哪个，
   *  不写死模型名，以服务端返回为准）。 */
  | { kind: "usage"; sessionPct?: number; sessionResetAt?: number; weekPct?: number; weekResetAt?: number; weekModelPct?: number; weekModelName?: string }
  | { kind: "compacting" }
  | { kind: "compacted"; trigger: string; preTokens: number; postTokens: number }
  /** Subscription quota. `exhausted` blocks further turns until `resetsAt` —
   *  except `modelScoped`（按模型的周限）: switching models can continue, so the
   *  composer must NOT be locked. */
  | { kind: "rate_limit"; level: "warning" | "exhausted"; limitLabel: string; resetsAt?: number; modelScoped?: boolean }
  /** The quota window reset — unlock the composer. */
  | { kind: "rate_limit_cleared" }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string }
  | { kind: "snapshot_skips"; files: { path: string; rel: string; reason: string }[]; total: number }
  | { kind: "snapshot_exclude_result"; ok: boolean; message: string; paths: string[] }
  // Full conversation replacement (switching/restoring sessions)
  | { kind: "load_history"; items: TimelineItem[]; sessionId?: string; checkpoints?: CheckpointSummary[] }
  | { kind: "sessions"; list: SessionSummary[]; activeId?: string; runningIds?: string[] }
  | { kind: "running"; sessionIds: string[] }
  // A restore point was created for the turn just sent (live).
  | { kind: "checkpoint_marker"; checkpointId: string; userText: string }
  /** modEnterToSend：Cmd/Ctrl+Enter 发送、Enter 换行（默认 Enter 发送）。 */
  | { kind: "config"; permissionMode: string; model: string; effort: string; modEnterToSend?: boolean }
  | { kind: "context_added"; label: string; text: string }
  | { kind: "active_file"; path: string | null }
  | { kind: "attach_files"; paths: string[] }
  | { kind: "changed_files"; files: ChangedFile[]; totalAdded: number; totalRemoved: number }
  | { kind: "notify_config"; webhook: string; minSec: number }
  | { kind: "notify_result"; ok: boolean; message: string }
  | { kind: "prefill"; text: string };

export interface ChangedFile {
  path: string; // absolute
  rel: string;
  added: number;
  removed: number;
  status: "added" | "modified" | "deleted";
}

export interface PermissionSuggestionView {
  id: string;
  label: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  /** 用户在会话列表里手动置顶——由宿主根据 globalState 里的置顶集合回填。 */
  pinned?: boolean;
}

export interface CheckpointSummary {
  /** 真实还原点为 uuid；`turn:<行号>` 是从 transcript 合成的还原点（该轮没有文件
   *  快照——由官方插件/其它窗口发出的轮次），只能回退对话，不回滚文件。 */
  id: string;
  synthetic?: boolean;
  label: string;
  createdAt: number;
  userText: string;
  fileCount: number;
}

/** 未获得服务端上下文上限时不猜测模型容量。 */
export function contextWindowFor(_model?: string, used = 0): number { return Math.max(used, 1); }

/** Sentinels wrapping the auto-embedded "attached files" context inside a user
 *  message, so the loader can split the real user input from the file dump. */
export const CTX_OPEN = "<user-attached-context>";
export const CTX_CLOSE = "</user-attached-context>";

/** A persisted/rehydratable timeline item (used when reloading a session). */
export type TimelineItem =
  | { type: "user"; text: string; context?: string; images?: string[]; files?: string[] }
  | { type: "image"; src: string } // standalone image (assistant/tool), data: URI
  | { type: "assistant_text"; text: string }
  /** secs：思考耗时（由相邻 transcript 记录的 timestamp 差估算，可能缺失）。 */
  | { type: "thinking"; text: string; secs?: number }
  | {
      type: "tool";
      toolId: string;
      name: string;
      displayName?: string;
      input?: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      permission?: "allow" | "deny" | "pending";
    }
  | { type: "checkpoint"; id: string; label: string }
  | { type: "compaction"; preTokens: number; postTokens: number };

// ---- Webview -> extension host --------------------------------------------

export type FromWebview =
  | { type: "ready" }
  /** fromBanner：点侧边栏「发现新版本」横幅触发，此时才弹安装确认；
   *  否则（手动「检查更新」/自动轮询）只点亮横幅，不打断。 */
  | { type: "checkUpdate"; fromBanner?: boolean }
  | { type: "refreshUsage" }
  | { type: "send"; text: string; context?: string; images?: { mediaType: string; data: string }[]; files?: string[] }
  | { type: "excludeSnapshotPaths"; paths?: string[]; all?: boolean }
  /** 从 OS（Finder 等）拖入工作区外的文件/目录：webview 拿不到绝对路径，只能读出
   *  内容传给宿主，由宿主镜像写盘后再按普通路径附加。rel 含顶层名（如 "dir/a.ts"）。 */
  | { type: "importDropped"; roots: { name: string; isDir: boolean }[]; files: { rel: string; base64: string }[]; skipped?: number }
  | { type: "editMessage"; checkpointId: string; text: string; images?: { mediaType: string; data: string }[] }
  | { type: "interrupt" }
  | { type: "compact" }
  /** /clear：丢弃当前会话上下文，在同一个 tab 里开一段全新的会话。
   *  带 text 时清空后立刻把这条消息发进新上下文。 */
  | { type: "newContext"; text?: string; context?: string; images?: { mediaType: string; data: string }[]; files?: string[] }
  | { type: "permission"; requestId: string; behavior: "allow" | "deny"; suggestionId?: string }
  | { type: "answerQuestion"; requestId: string; answers: Record<string, string | string[]> }
  | { type: "listSessions" }
  | { type: "openSession"; sessionId: string }
  | { type: "newInEditor" }
  | { type: "renameSession"; sessionId: string; title: string }
  /** 会话列表里置顶/取消置顶——宿主把 sessionId 加入/移出 globalState 的置顶集合。 */
  | { type: "pinSession"; sessionId: string; pinned: boolean }
  | { type: "deleteSessions"; sessionIds: string[] }
  | { type: "restoreCheckpoint"; checkpointId: string }
  /** 从该还原点派生一个新会话（复制截断点之前的对话到新 sessionId，新标签页打开；当前会话不动）。 */
  | { type: "forkCheckpoint"; checkpointId: string }
  | { type: "setPermissionMode"; mode: string }
  | { type: "setModel"; model: string }
  | { type: "setEffort"; effort: string }
  | { type: "addContext" }
  | { type: "pickFiles" }
  | { type: "openDiff"; path: string }
  | { type: "acceptFile"; path: string }
  | { type: "revertFile"; path: string }
  | { type: "acceptAll" }
  | { type: "revertAll" }
  | { type: "openFile"; path: string; line?: number; endLine?: number }
  | { type: "openSymbol"; name: string }
  | { type: "validateRefs"; refs: { id: string; path: string }[] }
  | { type: "runInTerminal"; code: string }
  | { type: "copy"; text: string }
  | { type: "saveImage"; dataUri: string }
  /** webview 内部 JS 错误上报——host 记入输出通道（webview 控制台平时看不到）。 */
  | { type: "webviewError"; message: string }
  | { type: "pong"; id: number }
  /** 输入框草稿同步（节流上报），看门狗重建 webview 时由宿主回填。 */
  | { type: "draft"; text: string }
  /** 用户关掉了"用量即将用尽"警告横幅——本重置周期内不再提示（exhausted 不受影响）。 */
  | { type: "dismissRateLimit"; limitLabel: string; resetsAt?: number }
  /** 校验符号引用是否真实存在（LSP 工作区索引）。无效的通过 refs_validated 剥掉链接。 */
  | { type: "validateSymbols"; syms: { id: string; name: string }[] }
  // ---- 推送通知配置面板 ----
  | { type: "notifyLoad" }
  | { type: "notifySave"; webhook: string; minSec: number }
  /** 用表单里的（可能未保存的）地址发一条测试消息。 */
  | { type: "notifyTest"; webhook: string };

/** GPT 标志；图形归 OpenAI 所有，随聊天主题使用单色显示。 */
export const GPT_LOGO = "<svg\n  xmlns=\"http://www.w3.org/2000/svg\"\n  width=\"24\"\n  height=\"24\"\n  fill=\"none\"\n  viewBox=\"0 0 24 24\"\n>\n  <path\n    d=\"M13.798 23.976a5.7 5.7 0 0 1-2.26-.456 6.1 6.1 0 0 1-1.903-1.27 5.7 5.7 0 0 1-1.88.311 5.75 5.75 0 0 1-2.95-.79 6.2 6.2 0 0 1-2.188-2.159q-.81-1.366-.809-3.045 0-.695.19-1.51a6.4 6.4 0 0 1-1.475-2.038A5.95 5.95 0 0 1 0 10.573Q0 9.278.547 8.08q.547-1.2 1.523-2.062a5.5 5.5 0 0 1 2.307-1.223A5.7 5.7 0 0 1 5.472 2.35 6.1 6.1 0 0 1 7.565.623 5.8 5.8 0 0 1 10.206 0q1.19 0 2.26.456a6.1 6.1 0 0 1 1.903 1.27 5.7 5.7 0 0 1 1.88-.311q1.594 0 2.95.79a6 6 0 0 1 2.165 2.159q.832 1.366.832 3.045 0 .695-.19 1.51a6.3 6.3 0 0 1 1.475 2.062q.523 1.15.523 2.422a5.9 5.9 0 0 1-.547 2.493q-.547 1.2-1.546 2.086a5.4 5.4 0 0 1-2.284 1.199 5.56 5.56 0 0 1-1.118 2.445 5.9 5.9 0 0 1-2.07 1.727 5.8 5.8 0 0 1-2.64.623m-5.876-2.997q1.19 0 2.07-.504l4.472-2.589a.53.53 0 0 0 .238-.455v-2.062L8.945 18.7a.96.96 0 0 1-1.047 0l-4.496-2.613a.7.7 0 0 1-.024.168v.287q0 1.224.571 2.254a4.24 4.24 0 0 0 1.642 1.583q1.047.6 2.331.599m.238-3.908a.6.6 0 0 0 .262.072q.118 0 .238-.072l1.784-1.031-5.734-3.357q-.522-.312-.523-.935V6.545a4.3 4.3 0 0 0-1.903 1.63 4.25 4.25 0 0 0-.714 2.398q0 1.176.595 2.254.594 1.08 1.546 1.63zm5.638 5.323q1.26 0 2.284-.576a4.3 4.3 0 0 0 1.618-1.582q.595-1.008.595-2.254v-5.179a.47.47 0 0 0-.238-.431l-1.808-1.055v6.689q0 .624-.524.935l-4.496 2.613a4.3 4.3 0 0 0 2.57.84m.904-8.776v-3.26l-2.688-1.535-2.712 1.535v3.26l2.712 1.535zM7.756 5.97q0-.623.523-.935l4.496-2.613a4.3 4.3 0 0 0-2.569-.84q-1.26 0-2.284.576A4.3 4.3 0 0 0 6.304 3.74q-.57 1.008-.57 2.254v5.155q0 .287.237.455l1.785 1.055zM19.84 17.43a4.16 4.16 0 0 0 1.88-1.63 4.33 4.33 0 0 0 .713-2.397q0-1.176-.595-2.254-.594-1.08-1.546-1.63l-4.449-2.59q-.143-.096-.261-.072a.46.46 0 0 0-.238.072L13.56 7.936l5.758 3.38a.9.9 0 0 1 .38.384q.143.216.143.528zM15.059 5.25q.524-.335 1.047 0l4.52 2.662V7.48q0-1.15-.57-2.181A4.14 4.14 0 0 0 18.46 3.62q-1.023-.623-2.379-.623-1.19 0-2.07.503L9.54 6.09a.53.53 0 0 0-.238.455v2.062z\"\n    fill=\"currentColor\"\n  />\n</svg>\n";
