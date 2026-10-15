import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/common";
import { latestModelChoices, modelDescription } from "./modelPicker";
import { parseFileRef } from "../fileRef";
import { parseQuestionReply } from "../codex/events";
import { AnswerImage, QuestionImages, QUESTION_IMAGE_ANSWER, QUESTION_IMAGE_TYPES, QUESTION_IMAGE_MAX_BYTES, validateQuestionImages } from "../questionImages";
import type { FromWebview, TimelineItem, ToWebview, SpeedMode, ModelChoice, BillingKind, ResetCredits, ChangedFile } from "../shared";
import { ICONS as ICON, GPT_LOGO, speedLabel, speedCost, speedGain, supportsSpeed } from "../shared";

// ---------------------------------------------------------------------------
// VS Code bridge
// ---------------------------------------------------------------------------
declare function acquireVsCodeApi(): {
  postMessage(msg: FromWebview): void;
  getState(): unknown;
  setState(s: unknown): void;
};
const vscode = acquireVsCodeApi();
const send = (m: FromWebview) => vscode.postMessage(m);

// Webview 内的 JS 错误平时完全不可见（不进扩展宿主日志）——上报给 host 记进
// "Codex Chat" 输出通道，"界面没反应"这类问题才有迹可循。
window.addEventListener("error", (e) => {
  try {
    vscode.postMessage({ type: "webviewError", message: `${e.message} @${(e as ErrorEvent).filename?.split("/").pop()}:${(e as ErrorEvent).lineno}` });
  } catch { /* 上报本身绝不能再抛 */ }
});
window.addEventListener("unhandledrejection", (e) => {
  try {
    vscode.postMessage({ type: "webviewError", message: `unhandledrejection: ${String((e as PromiseRejectionEvent).reason).slice(0, 300)}` });
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Markdown (fast = per-line while streaming; full = finalized w/ highlighting)
// ---------------------------------------------------------------------------
const mdFast = new MarkdownIt({ html: false, linkify: true, breaks: true });
const mdFull = new MarkdownIt({ html: false, linkify: true, breaks: true });
// markdown-it 默认拒绝 file://，但本地文件链接要交给扩展宿主解析。
for (const md of [mdFast, mdFull]) {
  const validate = md.validateLink.bind(md);
  md.validateLink = (url) => /^file:\/\//i.test(url) || validate(url);
}

const COLLAPSE_THRESHOLD = 6; // code blocks longer than this collapse to a 3-line preview
const MAX_HIGHLIGHT_CHARS = 30_000;

mdFull.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info || "").trim();
  const lang = info.split(/\s+/)[0] || "";
  let body: string;
  if (token.content.length > MAX_HIGHLIGHT_CHARS) {
    body = escapeHtml(token.content);
  } else if (lang && hljs.getLanguage(lang)) {
    try {
      body = hljs.highlight(token.content, { language: lang }).value;
    } catch {
      body = escapeHtml(token.content);
    }
  } else if (token.content.length <= 10_000) {
    try {
      body = hljs.highlightAuto(token.content).value;
    } catch {
      body = escapeHtml(token.content);
    }
  } else {
    // Auto-detection runs EVERY registered grammar — on big unlabeled blocks
    // that visibly stalls the finalize step. Plain text is fine there.
    body = escapeHtml(token.content);
  }
  return wrapCodeBlock(body, lang, token.content, true, true);
};

/**
 * Build the shared code-block HTML (hover copy/run actions + long-code collapse).
 * `highlighted` is the inner HTML for <code>; `raw` is the plain text used for
 * line counting (copy/run read it back from the DOM).
 */
function wrapCodeBlock(highlighted: string, lang: string, raw: string, run: boolean, actions: boolean): string {
  const lineCount = raw.replace(/\n+$/, "").split("\n").length;
  const collapsible = lineCount > COLLAPSE_THRESHOLD;
  const cls = "code-block" + (collapsible ? " collapsible collapsed" : "");
  const runBtn = run ? `<button class="code-act" data-action="run" title="在终端执行">${ICON.play} 执行</button>` : "";
  // A header strip naming the language, carrying copy/run. They used to float
  // over the code and only appear on hover — undiscoverable, and they covered
  // the first line while you were reading it.
  const headHtml = actions
    ? `<div class="code-head"><span class="code-lang">${escapeHtml(lang || "text")}</span>` +
      `<div class="code-actions">${runBtn}<button class="code-act" data-action="copy" title="复制">${ICON.copy} 复制</button></div></div>`
    : "";
  const expandBtn = collapsible
    ? `<button class="code-expand" data-action="toggle-code">${ICON.chevron}展开全部 ${lineCount} 行</button>`
    : "";
  return (
    `<div class="${cls}" data-lines="${lineCount}">` +
    headHtml +
    `<div class="code-body"><pre class="hljs"><code>${highlighted}</code></pre></div>` +
    expandBtn +
    `</div>`
  );
}

/** Highlight + wrap arbitrary code (tool cards: Bash command, JSON, …). No inline
 *  actions — copy/run live in the tool card header instead. */
function codeBlock(code: string, lang: string): string {
  let body: string;
  if (code.length <= MAX_HIGHLIGHT_CHARS && lang && hljs.getLanguage(lang)) {
    try {
      body = hljs.highlight(code, { language: lang }).value;
    } catch {
      body = escapeHtml(code);
    }
  } else {
    body = escapeHtml(code);
  }
  return wrapCodeBlock(body, lang, code, false, false);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const messagesEl = $("messages");
const inputEl = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("btn-send");
const stopBtn = $<HTMLButtonElement>("btn-stop");

const queueHint = $("queue-hint");
const PLACEHOLDER_IDLE = inputEl.placeholder;
const PLACEHOLDER_BUSY = "任务进行中 · 回车将内容加入等待队列";
let waitingQuestionId: string | undefined;
let stopPending = false;
let turnFinalizing = false;
const questionInteractions = new Map<string, { resolve: (behavior: "allow" | "deny") => void; retry: (message: string) => void }>();
const childQuestionIds = new Set<string>();
const statusLine = $("status-line");
const modeTrigger = $("mode-trigger");
const modeIcon = $("mode-icon");
const modeLabel = $("mode-label");
const modeMenu = $("mode-menu");
const modelTrigger = $("model-trigger");
const modelLabel = $("model-label");
const speedTrigger = $("speed-trigger") as HTMLButtonElement;
const speedTip = document.createElement("div");
speedTip.id = "speed-tooltip";
speedTip.className = "speed-tooltip";
speedTip.hidden = true;
speedTip.setAttribute("role", "tooltip");
speedTip.innerHTML = '<div class="speed-tip-heading"></div><div class="speed-tip-row"><span>普通</span><span class="speed-tip-normal"></span></div><div class="speed-tip-row"><span>快速</span><span class="speed-tip-fast"></span></div><div class="speed-tip-note"></div><div class="speed-tip-action"></div>';
document.body.appendChild(speedTip);
const speedFeedback = document.createElement("div");
speedFeedback.id = "speed-feedback";
speedFeedback.className = "speed-feedback";
speedFeedback.hidden = true;
speedFeedback.setAttribute("role", "status");
speedFeedback.setAttribute("aria-live", "polite");
speedFeedback.setAttribute("aria-atomic", "true");
document.body.appendChild(speedFeedback);
let speedFeedbackTimer = 0;
speedTrigger.setAttribute("aria-describedby", speedTip.id);
function positionSpeedPopover(popover: HTMLElement, trigger: HTMLElement = speedTrigger) {
  if (popover.hidden) return;
  const rect = trigger.getBoundingClientRect();
  const { width, height } = popover.getBoundingClientRect();
  popover.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
  const top = rect.top - height - 8;
  popover.style.top = Math.max(8, Math.min(top >= 8 ? top : rect.bottom + 8, window.innerHeight - height - 8)) + "px";
}
function hideSpeedTip() { speedTip.hidden = true; }
function showSpeedTip() {
  hideModeTip();
  if (!speedFeedback.hidden) return; // 保存反馈与详细说明共用位置，避免相互遮挡。
  speedTip.hidden = false;
  positionSpeedPopover(speedTip);
}
function hideSpeedFeedback() {
  window.clearTimeout(speedFeedbackTimer);
  speedFeedbackTimer = 0;
  speedFeedback.hidden = true;
  speedFeedback.textContent = "";
}
function showSpeedFeedback(mode: SpeedMode) {
  hideModeTip();
  hideSpeedFeedback();
  hideSpeedTip();
  speedFeedback.textContent = `${speedLabel(mode)}模式 · 下轮生效`;
  speedFeedback.hidden = false;
  positionSpeedPopover(speedFeedback);
  speedFeedbackTimer = window.setTimeout(hideSpeedFeedback, 1000);
}
function repositionSpeedFeedback() {
  hideSpeedTip();
  positionSpeedPopover(speedFeedback);
}
speedTrigger.addEventListener("mouseenter", showSpeedTip);
speedTrigger.addEventListener("mouseleave", hideSpeedTip);
speedTrigger.addEventListener("focus", showSpeedTip);
speedTrigger.addEventListener("blur", hideSpeedTip);
document.addEventListener("keydown", e => { if (e.key === "Escape") { hideSpeedTip(); hideSpeedFeedback(); } });
window.addEventListener("resize", repositionSpeedFeedback);
document.addEventListener("scroll", repositionSpeedFeedback, true);

const modeTip = document.createElement("div");
modeTip.id = "mode-tooltip";
modeTip.className = "speed-tooltip";
modeTip.hidden = true;
modeTip.setAttribute("role", "tooltip");
modeTip.innerHTML = '<div class="speed-tip-heading"></div><div class="mode-tip-description"></div><div class="speed-tip-action">点击切换权限模式</div>';
document.body.appendChild(modeTip);
modeTrigger.setAttribute("aria-describedby", modeTip.id);
function hideModeTip() { modeTip.hidden = true; }
function showModeTip() {
  if (!modeMenu.classList.contains("hidden")) return;
  hideSpeedFeedback();
  hideSpeedTip();
  modeTip.hidden = false;
  positionSpeedPopover(modeTip, modeTrigger);
}
modeTrigger.addEventListener("mouseenter", showModeTip);
modeTrigger.addEventListener("mouseleave", hideModeTip);
modeTrigger.addEventListener("focus", showModeTip);
modeTrigger.addEventListener("blur", hideModeTip);
document.addEventListener("keydown", e => { if (e.key === "Escape") hideModeTip(); });
window.addEventListener("resize", hideModeTip);
document.addEventListener("scroll", hideModeTip, true);

const effortTrigger = $("effort-trigger") as HTMLButtonElement;
const effortMenu = $("effort-menu");
const modelMenu = $("model-menu");
const pickBackdrop = $("pick-backdrop");
const contextChips = $("context-chips");
const changedFiles = $("changed-files");
const cfList = $("cf-list");
const cfStat = $("cf-stat");
const cfCount = $("cf-count");
const cfHeader = $("cf-header");
const lightbox = $("lightbox");
const lightboxImg = $<HTMLImageElement>("lightbox-img");
const imagePreviews = $("image-previews");
const fileChips = $("file-chips");

// ---------------------------------------------------------------------------
// Live streaming state
// ---------------------------------------------------------------------------
interface LiveBlock {
  type: "text";
  raw: string; // full text received so far (target)
  el: HTMLElement; // the .text-seg wrapper
  committedEl: HTMLElement;
  lineEl: HTMLElement; // 下一次格式化前即时显示的新文字
  blocks: { html: string; nodes: ChildNode[] }[];
  renderedAt: number;
}
let assistantEl: HTMLElement | null = null;
let liveBlock: LiveBlock | null = null;
let pinnedToBottom = true;
let readingHistory = false;
let lastObservedScrollTop = 0;
let turnHasReply = false;
let newReplyAvailable = false;
let isBusy = false;
let turnStartedAt: number | null = null;
/** Subscription quota spent: sending is blocked until the window resets.
 *  Declared up here (not next to its handlers) because `refreshComposerHint()`
 *  reads it and runs during module init — a later `let` would be a TDZ crash. */
let rateLimited = false;
let rlUnlockTimer = 0;
let lastUserEl: HTMLElement | null = null;
let userMsgCount = 0;
const toolCards = new Map<string, HTMLElement>();
const pendingContexts: { label: string; text: string }[] = [];
const pendingImages: { mediaType: string; data: string; uri: string }[] = [];


function ensureAssistant(): HTMLElement {
  if (!assistantEl) {
    messagesEl.querySelector(".empty-state")?.remove();
    assistantEl = el("div", "msg assistant");
    if (isBusy) assistantEl.classList.add("streaming-turn");
    const rail = el("div", "rail");
    const avatar = el("div", "avatar");
    avatar.innerHTML = GPT_LOGO;
    rail.append(avatar);
    const body = el("div", "msg-body");
    // The rail line is anchored INSIDE the body, off its left edge — the dots
    // use the same containing block and the same left arithmetic, so no layout
    // quirk can ever shift one without the other.
    body.appendChild(el("div", "thread-line"));
    assistantEl.append(rail, body);
    messagesEl.appendChild(assistantEl);
  }
  return assistantEl.querySelector(".msg-body") as HTMLElement;
}

function finalizeTurn() {
  finalizeLive();
  removeWorking();
  cancelPendingInteractions();
  if (assistantEl) {
    assistantEl.classList.remove("streaming-turn");
    assistantEl.querySelector(".thread-active")?.remove(); // stop the progress pulse
    const body = assistantEl.querySelector(".msg-body");
    // If the user manually stopped, mark it at the very end of the reply.
    if (body && userStopped) body.appendChild(el("div", "msg-interrupted", "[Request interrupted by user]"));
    // "Empty" must ignore the thread-line/active scaffolding that now lives in
    // the body — a contentless turn (e.g. the /compact summarization pass)
    // otherwise survives as a ghost avatar with an action row.
    if (body && !assistantHasContent(assistantEl)) {
      assistantEl.remove();
    } else if (body) {
      // Mark the final summary text as the closing timeline node (a dot at its
      // start) — but only when it follows earlier content (not the very first item).
      const segs = body.querySelectorAll(".text-seg");
      const last = segs[segs.length - 1];
      // "first content" skips the thread-line/active divs that now live in the
      // body — a lone text reply must NOT get a closing node.
      const firstContent = Array.from(body.children).find(
        (c) => !c.classList.contains("thread-line") && !c.classList.contains("thread-active"),
      );
      if (last && firstContent !== last) last.classList.add("summary-node");
      endTimelineAtLastNode(assistantEl); // stop the line at the last node
      // Footer: a row of borderless icon buttons under the reply.
      if (!body.querySelector(".msg-actions")) {
        body.appendChild(buildReplyActions(assistantEl));
      }
    }
  }
  // Reset unconditionally: if Stop landed after the bubble was already
  // finalized, a sticky flag would stamp "[interrupted]" onto the NEXT turn.
  userStopped = false;
  assistantEl = null;
  liveBlock = null;
}

/** 气泡里除脚手架（时间线、活动脉冲、转圈药丸）外是否还有真正内容。 */
function assistantHasContent(msg: HTMLElement): boolean {
  const body = msg.querySelector(".msg-body");
  return (
    !!body &&
    Array.from(body.children).some(
      (c) => !c.classList.contains("thread-line") && !c.classList.contains("thread-active") && !c.classList.contains("working-pill"),
    )
  );
}

/** The turn is over — any interactive UI still waiting for the user (question
 *  picker `.askp`, permission bar `.perm-bar`) is bound to a dead request:
 *  answering it would silently go nowhere. Freeze it visibly instead. */
function cancelPendingInteractions() {
  Array.from(
    messagesEl.querySelectorAll<HTMLElement>(
      ".askp:not(.interaction-cancelled), .perm-bar:not(.resolved):not(.interaction-cancelled)",
    ),
  ).forEach((box) => {
    box.classList.add("interaction-cancelled");
    Array.from(box.querySelectorAll("button, textarea")).forEach((b) => ((b as HTMLButtonElement | HTMLTextAreaElement).disabled = true));
  });
}

/** Shorten the timeline rail so it ends exactly at the last node (no trailing line). */
function endTimelineAtLastNode(msg: HTMLElement) {
  const line = msg.querySelector(".thread-line") as HTMLElement | null;
  if (!line) return;
  const compute = () => {
    // Grouped tool calls contain nested steps, but the outer group owns the
    // timeline dot. A collapsed inner step must never extend the rail.
    const nodes = msg.querySelectorAll(".msg-body > .step, .msg-body > .text-seg.summary-node");
    const last = nodes[nodes.length - 1] as HTMLElement | undefined;
    if (!last) {
      line.style.display = "none";
      return;
    }
    line.style.display = "";
    const aTop = msg.getBoundingClientRect().top;
    const lineTop = line.getBoundingClientRect().top - aTop;
    // dot centers differ by node kind: steps anchor at 9.5px, the closing
    // summary dot at 11.5px (13px×1.7 first line) — end the line on the right one.
    const dotY = last.classList.contains("summary-node") ? 11.5 : 9.5;
    const endY = last.getBoundingClientRect().top - aTop + dotY;
    line.style.flex = "0 0 auto";
    line.style.height = Math.max(0, endY - lineTop) + "px";
  };
  compute();
  // The pixel height goes stale when content below reflows (code highlighting,
  // expanding a tool result, images loading). Recompute on any size change so
  // the line always connects every node exactly.
  if (!railObservers.has(msg)) {
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (msg.isConnected) compute(); });
    });
    observer.observe(msg);
    railObservers.set(msg, () => { observer.disconnect(); cancelAnimationFrame(raf); });
  }
}
const railObservers = new Map<HTMLElement, () => void>();
/** 删除/重载消息时同时释放观察器和待执行帧，避免保留整棵旧消息 DOM。 */
function pruneRailObservers() {
  for (const [msg, dispose] of railObservers) {
    if (msg.isConnected) continue;
    dispose();
    railObservers.delete(msg);
  }
}

/** 同一帧合并流事件；长回复降低格式化频率，文字仍即时追加。 */
let liveRenderRAF = 0;
let liveRenderTimer = 0;
function cancelLiveRender() {
  if (liveRenderRAF) cancelAnimationFrame(liveRenderRAF);
  window.clearTimeout(liveRenderTimer);
  liveRenderRAF = 0;
  liveRenderTimer = 0;
}
function scheduleLiveRender() {
  if (liveRenderRAF || liveRenderTimer || !liveBlock) return;
  const interval = liveBlock.raw.length < 8000 ? 0 : Math.min(160, liveBlock.raw.length / 200);
  const delay = interval - (performance.now() - liveBlock.renderedAt);
  if (delay > 0) {
    liveRenderTimer = window.setTimeout(() => {
      liveRenderTimer = 0;
      liveRenderRAF = requestAnimationFrame(() => { liveRenderRAF = 0; renderLive(); });
    }, delay);
    return;
  }
  liveRenderRAF = requestAnimationFrame(() => { liveRenderRAF = 0; renderLive(); });
}
function renderLive() {
  if (!liveBlock) return;
  const block = liveBlock;
  const env = {};
  // 按完整 Markdown 结构解析，未换行的代码/列表/表格尾部也属于原容器。
  const tokens = mdFast.parse(block.raw, env);
  let index = 0;
  for (let from = 0; from < tokens.length;) {
    let to = from, depth = 0;
    do { depth += tokens[to++].nesting; } while (to < tokens.length && depth > 0);
    const html = mdFast.renderer.render(tokens.slice(from, to), mdFast.options, env).trimEnd();
    from = to;
    if (!html) continue;
    const previous = block.blocks[index];
    if (previous?.html !== html) {
      // 未变化的块不重建，保留图片、选择范围及代码块的横向滚动位置。
      const holder = document.createElement("div");
      holder.innerHTML = html;
      linkifyRefs(holder, false);
      hydrateLocalImages(holder);
      const nodes = Array.from(holder.childNodes);
      const anchor = previous?.nodes[0] ?? null;
      for (const node of nodes) block.committedEl.insertBefore(node, anchor);
      previous?.nodes.forEach(node => node.remove());
      block.blocks[index] = { html, nodes };
    }
    index++;
  }
  for (const stale of block.blocks.splice(index)) stale.nodes.forEach(node => node.remove());
  block.lineEl.textContent = "";
  // 下一帧之前的即时文字也跟随当前行，避免每个 delta 临时掉到代码框外/新段落。
  const lastToken = tokens[tokens.length - 1];
  const closedFence = lastToken?.type === "fence" &&
    new RegExp(`(?:^|\\n) {0,3}${lastToken.markup[0]}{${lastToken.markup.length},}[ \\t]*$`).test(block.raw);
  const tailBlock = block.blocks[index - 1]?.nodes.slice().reverse().find(node => node instanceof HTMLElement) as HTMLElement | undefined;
  const candidates = tailBlock ? [tailBlock, ...Array.from(tailBlock.querySelectorAll<HTMLElement>("p, li, td, th, h1, h2, h3, h4, h5, h6, pre > code"))] : [];
  const target = !block.raw.endsWith("\n") && !closedFence
    ? candidates.reverse().find(node => node.matches("p, li, td, th, h1, h2, h3, h4, h5, h6, pre > code")) : undefined;
  (target ?? block.el).appendChild(block.lineEl);
  block.renderedAt = performance.now();
  scheduleLiveLayout();
}

/** The model occasionally leaks its internal tool-call XML into plain prose
 *  (degenerate output after long context/compaction). It's stored that way in
 *  the transcript — fold it into a fenced block so it reads as raw syntax
 *  instead of broken paragraphs. */
function foldLeakedToolXml(text: string): string {
  // Require a real </invoke>: an open-ended `|$` alternative made a single
  // prose mention of "<invoke name=" swallow the entire rest of the reply.
  // And never touch text that already has fences — we'd break the existing one.
  if (text.includes("```") || !/<invoke name=[\s\S]*?<\/invoke>/.test(text)) return text;
  return text.replace(/<invoke name=[\s\S]*?<\/invoke>/g, (blk) => "\n```xml\n" + blk.trim() + "\n```\n");
}

/** Snap the live block to its full text, rendered with syntax highlighting. */
function finalizeLive() {
  cancelLiveRender();
  if (!liveBlock) return;
  liveBlock.el.innerHTML = mdFull.render(foldLeakedToolXml(liveBlock.raw));
  linkifyRefs(liveBlock.el);
  hydrateLocalImages(liveBlock.el);
  updateActiveLine();
  maybeScroll();
}

/** Position the pulsing "active" progress segment so it starts at the last
 *  timeline node (dot) and runs down to the current bottom of the thread. */
let liveLayoutRAF = 0;
function scheduleLiveLayout() {
  if (liveLayoutRAF) return;
  liveLayoutRAF = requestAnimationFrame(() => {
    liveLayoutRAF = 0;
    updateActiveLine();
    maybeScroll();
  });
}
function updateActiveLine() {
  if (!assistantEl || !assistantEl.classList.contains("streaming-turn")) return;
  const rail = assistantEl.querySelector(".rail") as HTMLElement | null;
  const body = assistantEl.querySelector(".msg-body") as HTMLElement | null;
  const line = assistantEl.querySelector(".thread-line") as HTMLElement | null;
  if (!rail || !body || !line) return;
  let active = assistantEl.querySelector(".thread-active") as HTMLElement | null;
  if (!active) {
    active = el("div", "thread-active");
    body.appendChild(active); // same containing block as line + dots
  }
  // body and rail share the same top (the row stretches both), but measure the
  // active line's actual parent to be exact.
  const railTop = body.getBoundingClientRect().top;
  // Last node = the last visible step dot, else the avatar (first node).
  const dots = assistantEl.querySelectorAll(".msg-body .step .step-dot");
  let startY: number;
  const visibleDots = Array.from(dots).filter((d) => (d as HTMLElement).offsetParent !== null);
  if (visibleDots.length) {
    const r = (visibleDots[visibleDots.length - 1] as HTMLElement).getBoundingClientRect();
    startY = r.top + r.height / 2 - railTop;
  } else {
    const av = rail.querySelector(".avatar") as HTMLElement;
    const r = av.getBoundingClientRect();
    startY = r.top + r.height / 2 - railTop;
  }
  // Bottom = where the work currently IS: the live "working" pill if present
  // (so the glow reaches the bottom of a running tool's card), otherwise the
  // bottom of the last real content node — but NOT a trailing interactive box
  // (the option picker / permission box), which can be very tall.
  const pill = assistantEl.querySelector(".msg-body > .working-pill") as HTMLElement | null;
  let bottomY: number;
  if (pill) {
    bottomY = pill.getBoundingClientRect().bottom - railTop;
  } else {
    const content = assistantEl.querySelectorAll(".msg-body > .step, .msg-body > .text-seg, .msg-body > .msg-images");
    const lastContent = content[content.length - 1] as HTMLElement | undefined;
    bottomY = lastContent
      ? lastContent.getBoundingClientRect().bottom - railTop
      : rail.getBoundingClientRect().bottom - railTop - 2;
  }
  active.style.top = `${startY}px`;
  active.style.removeProperty("bottom");
  active.style.height = `${Math.max(0, bottomY - startY)}px`;
}

// -- Shared 1s ticker: updates the "思考中 · Ns · N tokens" pill ------------
let tickTimer = 0;
let turnTokens = 0; // exact output tokens (only arrives at each message's end)
let turnEst = 0; // live estimate from streamed chars (the CLI doesn't stream counts)
let turnThinkTokens = 0; // real thinking-token count from the CLI (system/thinking_tokens)
let msgTokenBase = 0; // sum of PREVIOUS messages' finals within this turn
let lastMsgTokens = 0; // the current message's cumulative count so far
function fmtTokens(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
}
function pillTokenText(n: number): string {
  if (n <= 0) return "token 待回传";
  const estimated = Math.round(turnEst) > Math.max(turnTokens, turnThinkTokens);
  return `${estimated ? "≈" : ""}${fmtTokens(Math.round(n))} tokens`;
}
// The CLI reports tokens in coarse jumps (≈50 at a time); showing them raw
// makes the counter lurch. Ease the DISPLAYED value toward the real target on
// each frame so it climbs smoothly, like the official panel.
let tokenTarget = 0; // authoritative count
let tokenShown = 0; // what's on screen (fractional, floored to display)
let tokenRAF = 0;
function paintTokens() {
  const tk = assistantEl?.querySelector(".working-pill .wk-tokens") as HTMLElement | null;
  if (!tk) { tokenRAF = 0; return; }
  const diff = tokenTarget - tokenShown;
  // approach ~18%/frame, but always move at least 1 so it can't stall just shy
  if (Math.abs(diff) < 1) {
    tokenShown = tokenTarget;
    tk.textContent = pillTokenText(tokenShown);
    tokenRAF = 0;
    return;
  }
  tokenShown += diff * 0.18 + Math.sign(diff);
  tk.textContent = pillTokenText(tokenShown);
  tokenRAF = requestAnimationFrame(paintTokens);
}
function setPillTokens() {
  // 真实思考 token > 精确输出 token > 字符估算：优先展示 CLI 报的真实数，退回估算。
  tokenTarget = Math.max(turnTokens, turnThinkTokens, Math.round(turnEst));
  if (!tokenRAF) tokenRAF = requestAnimationFrame(paintTokens);
}
/** Reset the eased counter when a new turn's pill appears (no carry-over tween). */
function resetTokenTween() {
  tokenTarget = 0;
  tokenShown = 0;
  if (tokenRAF) { cancelAnimationFrame(tokenRAF); tokenRAF = 0; }
}
function onTokens(output: number) {
  // `output` is cumulative WITHIN one assistant message; a turn with tool loops
  // has several messages. A drop in the counter = a new message started — bank
  // the previous message's final so the turn total is a true sum, not a max.
  if (output < lastMsgTokens) msgTokenBase += lastMsgTokens;
  lastMsgTokens = output;
  turnTokens = msgTokenBase + output;
  setPillTokens();
}
/** The CLI only reports tokens at message end, so estimate live from streamed
 *  text (CJK ≈ 1 token/char, latin ≈ 1 token/4 chars) for a growing counter. */
function addStreamEst(text: string) {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) || 0) >= 0x3000) cjk++;
    else other++;
  }
  turnEst += cjk * 1.05 + other / 4;
  setPillTokens();
}

const ctxGauge = $("ctx-gauge");
const ctxTooltip = $("ctx-tooltip");
ctxTooltip.addEventListener("click", (event) => event.stopPropagation());
function positionContextTooltip() {
  const rect = ctxGauge.getBoundingClientRect();
  const width = ctxTooltip.getBoundingClientRect().width;
  ctxTooltip.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  ctxTooltip.style.bottom = `${window.innerHeight - rect.top + 8}px`;
}
for (const event of ["mouseenter", "focus"]) ctxGauge.addEventListener(event, () => {
  ctxGauge.classList.remove("tooltip-dismissed");
  positionContextTooltip();
});
window.addEventListener("resize", positionContextTooltip);
ctxGauge.addEventListener("keydown", (event) => {
  if (event.key === "Escape") ctxGauge.classList.add("tooltip-dismissed");
});
let lastCtxTotal = 1_000_000; // remembered so we can repaint the gauge after a /compact
let compacting = false;
/** Circular context-usage gauge next to the mode picker (hidden below 10%).
 *  Clicking it runs /compact to summarize and shrink the conversation. */
function updateContextGauge(used: number, total: number) {
  if (total > 0) lastCtxTotal = total;
  const pct = Math.max(0, Math.min(100, Math.round((used / total) * 100)));
  if (pct < 10) {
    ctxGauge.classList.add("hidden");
    return;
  }
  ctxGauge.classList.remove("hidden");
  ctxGauge.style.setProperty("--pct", String(pct));
  ctxGauge.style.setProperty("--cg-color", pct >= 85 ? "#e5534b" : pct >= 60 ? "#e0a33e" : "#d97757");
  const lbl = ctxGauge.querySelector(".cg-pct") as HTMLElement | null;
  if (lbl) lbl.textContent = String(pct);
  ctxGauge.setAttribute("aria-label", `上下文已用 ${pct}%，${used.toLocaleString("zh-CN")} tokens，点击压缩`);
  const detail = (label: string, value: number) =>
    `<span class="ctx-detail"><span>${label}</span><span><strong>${fmtTokens(value)}</strong><small>${value.toLocaleString("zh-CN")} tokens</small></span></span>`;
  ctxTooltip.innerHTML = `<span class="ctx-heading">上下文使用情况 <strong>${pct}%</strong></span>` +
    detail("已使用", used) + detail("总容量", total) + detail("剩余", Math.max(0, total - used)) +
    `<span class="ctx-hint">1k = 1,000 tokens · 按最新上报值更新</span><span class="ctx-hint ctx-action">点击圆环压缩上下文</span>`;
  positionContextTooltip();
}
ctxGauge.addEventListener("click", () => {
  if (compacting || isBusy) return; // already working
  send({ type: "compact" });
});

const usagePill = $<HTMLButtonElement>("usage-pill");
/** Reset-time countdown, compact enough to sit inside the quota banner's pill. */
function resetCountdownShort(resetAt?: number): string | undefined {
  if (!resetAt) return undefined;
  const mins = Math.round((resetAt * 1000 - Date.now()) / 60000);
  if (mins <= 0) return "即将重置";
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h` : `${mins}m`;
}
/** Codex subscription windows, present only when returned by app-server. */
type UsageData = {
  sessionPct?: number;
  sessionResetAt?: number;
  weekPct?: number;
  weekResetAt?: number;
  /** 按模型的周限额（仅在服务端提供时显示）。 */
  weekModelPct?: number;
  weekModelName?: string;
};
let lastUsageData: UsageData = {};
let lastResetCredits: ResetCredits | null = null;
function availableResetCredits(): { count: number; cards: NonNullable<ResetCredits["cards"]> | null } | null {
  const summary = lastResetCredits;
  if (!summary) return null;
  const cards = summary.cards?.filter(card => typeof card.expiresAt !== "number" || card.expiresAt > Date.now() / 1000) ?? null;
  const expired = summary.cards ? summary.cards.length - (cards?.length ?? 0) : 0;
  return { count: Math.max(cards?.length ?? 0, summary.availableCount - expired), cards };
}
let currentPlanType: string | undefined;
const PLAN_NAMES: Record<string, string> = {
  free: "ChatGPT Free", go: "ChatGPT Go", plus: "ChatGPT Plus", pro: "ChatGPT Pro 200",
  prolite: "ChatGPT Pro 100", promax: "ChatGPT Pro 500", team: "ChatGPT Team",
  business: "ChatGPT Business", enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu", edu_plus: "ChatGPT Edu Plus", edu_pro: "ChatGPT Edu Pro",
};
function currentPlanName(): string | undefined {
  return currentPlanType && Object.hasOwn(PLAN_NAMES, currentPlanType) ? PLAN_NAMES[currentPlanType] : undefined;
}
const usageMenu = $("usage-menu");
function renderUsage(sessionPct?: number, sessionResetAt?: number, weekPct?: number, weekResetAt?: number, weekModelPct?: number, weekModelName?: string) {
  lastUsageData = { sessionPct, sessionResetAt, weekPct, weekResetAt, weekModelPct, weekModelName };
  // Dim label + bright number, no mini bars — the pill is a glance value, the
  // full bars live one click away in the popover.
  const item = (key: string, value: string) =>
    `<span class="up-item"><span class="up-key">${key}</span><span class="up-pct">${value}</span></span>`;
  const parts: string[] = [];
  if (typeof sessionPct === "number") parts.push(item("会话", `${sessionPct}%`));
  if (typeof weekPct === "number") parts.push(item("周", `${weekPct}%`));
  const resetCards = availableResetCredits();
  if (!parts.length && resetCards?.count) parts.push(item("重置卡", `${resetCards.count} 张`));
  if (!parts.length) {
    usagePill.classList.add("hidden");
    usageMenu.classList.add("hidden");
    return;
  }
  usagePill.classList.remove("hidden");
  const peak = Math.max(sessionPct ?? 0, weekPct ?? 0);
  usagePill.style.setProperty("--u-color", peak >= 90 ? "#e5534b" : peak >= 70 ? "#e0a33e" : "var(--vscode-textLink-foreground, #4a9eff)");
  usagePill.classList.toggle("warn", peak >= 70);
  usagePill.innerHTML = parts.join("");
  refitComposer(); // the pill's arrival changes the row's natural width
  usagePill.title = "Codex 订阅用量 · 点击查看详情";
  if (!usageMenu.classList.contains("hidden")) buildUsageMenu(); // live-refresh while open
}

function cnReset(resetAt?: number): string {
  if (typeof resetAt !== "number") return "";
  const date = new Date(resetAt * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} 重置`;
}
function usageRow(label: string, pct: number | undefined, resetText: string): string {
  const has = typeof pct === "number";
  const p = has ? Math.max(0, Math.min(100, pct as number)) : 0;
  const shown = has ? `${pct}%` : "—";
  const warn = p >= 90 ? " warn-high" : p >= 70 ? " warn-mid" : "";
  // 左边是下次重置时间；右边将额度名与已用百分比紧挨着展示。
  return (
    `<div class="usage-row${warn}">` +
    `<div class="usage-row-top">${resetText ? `<span class="usage-reset">${resetText}</span>` : ""}` +
    `<span class="usage-metric"><span class="usage-name">${label}</span><span class="usage-pct">${shown}</span></span></div>` +
    `<div class="usage-bar"><span style="width:${p}%"></span></div>` +
    `</div>`
  );
}
function creditExpiry(expiresAt?: number | null): string {
  if (expiresAt === null) return "长期有效";
  if (typeof expiresAt !== "number") return "有效期未提供";
  const date = new Date(expiresAt * 1000);
  if (Number.isNaN(date.getTime())) return "有效期未提供";
  const year = date.getFullYear() === new Date().getFullYear() ? "" : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} 到期`;
}
function resetCreditsHtml(): string {
  const visible = availableResetCredits();
  if (!visible) return "";
  const now = Date.now() / 1000;
  const { count, cards } = visible;
  let html = `<div class="usage-credits"><div class="usage-credits-head"><span>重置卡</span><span>可用 ${count} 张</span></div>`;
  if (!count) html += `<div class="usage-credits-note">暂无可用重置卡</div>`;
  else if (!cards?.length) html += `<div class="usage-credits-note">接口暂未返回逐张有效期</div>`;
  else {
    cards.forEach((card, index) => {
      const urgency = typeof card.expiresAt === "number" ? card.expiresAt - now : Infinity;
      const warn = urgency <= 24 * 3600 ? " urgent" : urgency <= 7 * 24 * 3600 ? " soon" : "";
      html += `<div class="usage-credit${warn}"><span class="usage-credit-title" title="${escapeHtml(card.title || `重置卡 ${index + 1}`)}">${escapeHtml(card.title || `重置卡 ${index + 1}`)}</span><span class="usage-credit-expiry">${creditExpiry(card.expiresAt)}</span></div>`;
    });
    if (count > cards.length) html += `<div class="usage-credits-note">另有 ${count - cards.length} 张未返回有效期</div>`;
  }
  return html + `</div>`;
}
/** Expanded weekly usage panel — mirrors the official Plan-usage popover. */
function buildUsageMenu() {
  const d = lastUsageData;
  const plan = currentPlanName();
  let html = `<div class="pick-head usage-head">每周限额${plan ? ` · ${plan}` : ""}</div>`;
  if (typeof d.sessionPct === "number") html += usageRow("5 小时限额", d.sessionPct, cnReset(d.sessionResetAt));
  if (typeof d.weekPct === "number") html += usageRow("已使用", d.weekPct, cnReset(d.weekResetAt));
  // 按模型的周限额行：CLI 输出了才显示（模型名由服务端提供）。
  // 模型名来自解析 CLI 的 stdout——外部字符串进 innerHTML 必须转义。
  if (typeof d.weekModelPct === "number") {
    html += usageRow(`仅 ${escapeHtml(d.weekModelName || "特定模型")}`, d.weekModelPct, "");
  }
  html += resetCreditsHtml();
  usageMenu.innerHTML = html;
}
/** Anchor the popover directly above the usage pill (right edges aligned). */
function positionUsageMenu() {
  const parent = usageMenu.offsetParent as HTMLElement | null;
  if (!parent) return;
  const pill = usagePill.getBoundingClientRect();
  const pr = parent.getBoundingClientRect();
  usageMenu.style.left = "auto";
  usageMenu.style.right = `${Math.max(8, Math.min(pr.right - pill.right, pr.width - usageMenu.offsetWidth - 8))}px`;
  usageMenu.style.bottom = `${pr.bottom - pill.top + 6}px`;
  usageMenu.style.setProperty("--picker-available-height", `${Math.max(0, pill.top - 14)}px`);
}
usagePill.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = !usageMenu.classList.contains("hidden");
  closePickers();
  if (!open) {
    buildUsageMenu();
    usageMenu.classList.remove("hidden");
    positionUsageMenu();
    pickBackdrop.classList.remove("hidden");
    send({ type: "refreshUsage" }); // pull fresh numbers; renderUsage rebuilds the open panel
  }
});
function formatElapsed(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分${seconds % 60}秒`;
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
function paintWorkingTime(wk: HTMLElement): number {
  const now = performance.now();
  const elapsed = Math.max(0, Math.floor((now - Number(wk.dataset.start ?? now)) / 1000));
  const time = wk.querySelector(".wk-time");
  if (time) time.textContent = `本轮总耗时 ${formatElapsed(elapsed)}`;
  const recent = wk.querySelector(".wk-progress");
  const idle = Math.max(0, Math.floor((now - Number(wk.dataset.progressAt ?? now)) / 1000));
  if (recent) recent.textContent = wk.dataset.progress
    ? `距最近进展 ${formatElapsed(idle)} · ${wk.dataset.progress}`
    : `尚未收到任务进展 · 已等待 ${formatElapsed(idle)}`;
  return elapsed;
}
/** 只记录真实任务事件；计时动画、额度刷新和重试提示不代表任务有进展。 */
function recordWorkingProgress(label: string) {
  if (!isBusy || stoppingView || waitingQuestionId || glowState === "waiting") return;
  const wk = assistantEl?.querySelector(".working-pill") as HTMLElement | null;
  if (!wk) return;
  wk.dataset.progressAt = String(performance.now());
  wk.dataset.progress = label;
  wk.querySelector(".wk-wait")?.remove();
  paintWorkingTime(wk);
}
function showModelOrToolWorking() {
  showWorking(assistantEl?.querySelector(".tool-card.running") ? "正在执行工具…" : "模型处理中…");
}
function startTick() {
  if (tickTimer) return;
  tickTimer = window.setInterval(() => {
    const wk = assistantEl?.querySelector(".working-pill") as HTMLElement | null;
    if (!wk) {
      clearInterval(tickTimer);
      tickTimer = 0;
      return;
    }
    paintWorkingTime(wk);
    updateActiveLine(); // keep the active glow tracking the pill as content grows
  }, 1000);
}

// The composer floats over the transcript, so the transcript's bottom padding
// must clear the composer's REAL height (changed-files panel, queue, chips all
// change it) — otherwise the last messages hide behind the input.
const composerEl = $("composer");
const jumpLatestBtn = el("button", "jump-latest hidden") as HTMLButtonElement;
jumpLatestBtn.type = "button";
jumpLatestBtn.title = "跳到最新已输出的末尾，并跟随后续输出";
jumpLatestBtn.innerHTML = `${ICON.chevron}<span>跳到底部</span><span class="jump-new-reply hidden">有新回复</span>`;
messagesEl.parentElement!.appendChild(jumpLatestBtn);
jumpLatestBtn.addEventListener("click", () => {
  closeMsgNav();
  scrollToBottom();
});

function updateJumpLatest() {
  const away = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight >= 80;
  jumpLatestBtn.classList.toggle("hidden", !away);
  jumpLatestBtn.querySelector(".jump-new-reply")?.classList.toggle("hidden", !away || !newReplyAvailable);
}

if (composerEl && "ResizeObserver" in window) {
  new ResizeObserver(() => {
    const wasPinned = pinnedToBottom;
    // +114：正文最后一条要完全越过渐隐幕布（其上探 34px）再留出约两行的
    // 呼吸空间——直播时状态药丸是最后一行，贴着输入框会显得压迫。
    messagesEl.style.paddingBottom = `${composerEl.offsetHeight + 150}px`;
    jumpLatestBtn.style.bottom = `${composerEl.offsetHeight + 12}px`;
    positionSpeedPopover(speedFeedback);
    if (wasPinned) messagesEl.scrollTop = messagesEl.scrollHeight;
    updateJumpLatest();
  }).observe(composerEl);
}
if ("ResizeObserver" in window) new ResizeObserver(() => maybeScroll()).observe(messagesEl);

/** Auto-scroll only when the user is already near the bottom. */
function maybeScroll() {
  if (pinnedToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  updateJumpLatest();
}
messagesEl.addEventListener("scroll", () => {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  // A small upward wheel move may still be inside the 80px follow threshold.
  // Keep reading mode until the user moves down again or clicks the jump button.
  if (readingHistory && messagesEl.scrollTop > lastObservedScrollTop && nearBottom) readingHistory = false;
  pinnedToBottom = nearBottom && !readingHistory;
  lastObservedScrollTop = messagesEl.scrollTop;
  if (pinnedToBottom) newReplyAvailable = false;
  updateJumpLatest();
  updateQuestionBar();
});
// Stop following on the first upward wheel event, before the next stream update.
messagesEl.addEventListener("wheel", event => {
  if (event.deltaY < 0) {
    readingHistory = true;
    pinnedToBottom = false;
    lastObservedScrollTop = messagesEl.scrollTop;
  } else if (event.deltaY > 0) readingHistory = false;
}, { passive: true });

// ---------------------------------------------------------------------------
// 顶部「我的消息」导航：悬浮栏点开后列出本会话所有用户消息，点某条跳到对应
// 位置；滚动阅读时弹窗里的高亮项跟随当前所在的那条提问。
// ---------------------------------------------------------------------------
const questionBar = el("div", "question-bar hidden");
const qbThumbsEl = el("span", "qb-thumbs");
const qbTextEl = el("span", "qb-text");
const qbNavBtn = el("button", "qb-navbtn") as HTMLButtonElement; // 右侧「我的消息」按钮
qbNavBtn.innerHTML = `<span class="qb-ico"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.4h10M3 8h7M3 11.6h4.5"/></svg></span>我的消息`;
questionBar.append(qbThumbsEl, qbTextEl, qbNavBtn);
messagesEl.parentElement!.insertBefore(questionBar, messagesEl);
// 点横栏本体：跳回当前提问（保持原行为）；点「我的消息」按钮：开消息列表弹窗。
questionBar.addEventListener("click", () => qbTarget?.scrollIntoView({ behavior: "smooth", block: "start" }));
qbNavBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  navOpen ? closeMsgNav() : openMsgNav();
});

const msgNav = el("div", "msgnav hidden");
messagesEl.parentElement!.appendChild(msgNav);

let navOpen = false;
let qbTarget: HTMLElement | null = null; // 当前视口所属的用户消息

/** 可见的用户消息（排除折叠历史里 display:none 的）。 */
function visibleUserMsgs(): HTMLElement[] {
  return Array.from(messagesEl.querySelectorAll<HTMLElement>(".msg.user")).filter((u) => u.offsetParent !== null);
}

function buildMsgNav() {
  const msgs = visibleUserMsgs();
  msgNav.innerHTML = "";
  const head = el("div", "msgnav-head");
  head.append(el("span", "mn-title", "跳到我发的消息"), el("span", "mn-count", String(msgs.length)));
  msgNav.appendChild(head);
  const list = el("div", "msgnav-list");
  msgs.forEach((u, i) => {
    const raw = (u.dataset.rawText || "").trim();
    const imgs = u.querySelectorAll(".msg-images img").length;
    const label = raw.replace(/\s+/g, " ") || (imgs ? `[图片 ${imgs}]` : "(空消息)");
    const row = el("div", "msgnav-item" + (u === qbTarget ? " on" : ""));
    row.dataset.idx = String(i);
    row.append(el("span", "mn-bar"), el("span", "mn-idx", String(i + 1).padStart(2, "0")), el("span", "mn-text", label));
    row.onclick = () => {
      u.scrollIntoView({ behavior: "smooth", block: "start" });
      closeMsgNav();
    };
    list.appendChild(row);
  });
  msgNav.appendChild(list);
}

/** 高亮弹窗里对应当前提问的那一项，并把它滚到弹窗可视区内。 */
function syncNavActive() {
  if (!navOpen) return;
  const msgs = visibleUserMsgs();
  const idx = qbTarget ? msgs.indexOf(qbTarget) : -1;
  const rows = Array.from(msgNav.querySelectorAll<HTMLElement>(".msgnav-item"));
  rows.forEach((r, i) => r.classList.toggle("on", i === idx));
  if (idx >= 0 && rows[idx]) rows[idx].scrollIntoView({ block: "nearest" });
}

function openMsgNav() {
  buildMsgNav();
  navOpen = true;
  msgNav.classList.remove("hidden");
  // 横栏现在是限宽居中的悬浮条，弹窗按钮的实际位置随面板宽度变——
  // 打开时按按钮矩形锚定，右缘对齐按钮右缘。
  const host = messagesEl.parentElement as HTMLElement;
  const hr = host.getBoundingClientRect();
  const br = qbNavBtn.getBoundingClientRect();
  msgNav.style.top = `${br.bottom - hr.top + 6}px`;
  msgNav.style.right = `${Math.max(8, hr.right - br.right)}px`;
  qbNavBtn.classList.add("on");
  syncNavActive();
}
function closeMsgNav() {
  navOpen = false;
  msgNav.classList.add("hidden");
  qbNavBtn.classList.remove("on");
}

let qbRAF = 0;
function updateQuestionBar() {
  if (qbRAF) return; // 滚动事件很密，rAF 合并到每帧一次
  qbRAF = requestAnimationFrame(() => {
    qbRAF = 0;
    // 已完全滚出可视区顶部的最后一条用户消息，就是当前可见回复所属的提问。
    const topEdge = messagesEl.getBoundingClientRect().top + (questionBar.offsetHeight || 34) + 4;
    let cur: HTMLElement | null = null;
    for (const u of visibleUserMsgs()) {
      if (u.getBoundingClientRect().bottom < topEdge) cur = u;
      else break;
    }
    const text = cur?.dataset.rawText?.trim() || "";
    const imgs = cur ? Array.from(cur.querySelectorAll<HTMLImageElement>(".msg-images img")) : [];
    if (!cur || (!text && !imgs.length)) {
      qbTarget = null;
      if (navOpen) closeMsgNav();
      questionBar.classList.add("hidden");
      return;
    }
    if (qbTarget !== cur) {
      // 只在归属的提问变化时重建内容，滚动过程中不反复动 DOM
      qbTarget = cur;
      qbTextEl.textContent = text.replace(/\s+/g, " ");
      qbThumbsEl.innerHTML = "";
      for (const im of imgs.slice(0, 4)) {
        const t = document.createElement("img");
        t.src = im.src;
        qbThumbsEl.appendChild(t);
      }
      qbThumbsEl.classList.toggle("hidden", !imgs.length);
    }
    questionBar.classList.remove("hidden");
    syncNavActive();
  });
}

// ---------------------------------------------------------------------------
// Incoming messages
// ---------------------------------------------------------------------------
window.addEventListener("message", (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  // After Stop, swallow the tail of the dying turn (deltas already in the pipe
  // would re-open a bubble and keep "typing"). Lifecycle events still flow.
  if (
    stoppingView &&
    (m.kind === "block_start" ||
      m.kind === "block_end" ||
      m.kind === "text_delta" ||
      m.kind === "text_snap" ||
      m.kind === "thinking_delta" ||
      m.kind === "tool_input" ||
      m.kind === "tool_input_partial" ||
      m.kind === "activity" ||
      m.kind === "status" ||
      m.kind === "tokens" ||
      m.kind === "thinking_tokens")
  ) {
    return;
  }
  switch (m.kind) {
    case "ping":
      send({ type: "pong", id: m.id }); // 看门狗心跳——必须无条件立即回
      return;
    case "draft":
      // 看门狗重建后回填草稿；用户已经打了新内容就绝不覆盖。
      if (!inputEl.value && m.text) {
        inputEl.value = m.text;
        autoResize();
      }
      // 还原带回的图片附件回填成可删的图片 chip；已有待发图片时不叠加。
      if (m.images?.length && !pendingImages.length) {
        for (const im of m.images) {
          const uri = `data:${im.mediaType};base64,${im.data}`;
          pendingImages.push({ mediaType: im.mediaType, data: im.data, uri });
          addImagePreview(uri);
        }
      }
      refreshComposerHint();
      return;
    case "session":
      actualSpeedModel = m.model;
      syncPickers();
      statusLine.textContent = `模型 ${m.model} · ${m.cwd}`;
      // The CLI reports the mode its process actually runs in — trust it over
      // our local guess, so the picker can never claim "Auto" while the
      // process is really asking for every permission.
      if (m.permissionMode && m.permissionMode !== currentMode) {
        currentMode = m.permissionMode;
        syncPickers();
      }
      // Persist the tab↔session binding so a window reload restores THIS tab to
      // THIS conversation (and never two tabs onto one session = two processes).
      if (m.sessionId) vscode.setState({ sessionId: m.sessionId });
      break;
    case "busy":
      if (!m.busy && m.restoring === false && restoreInProgress) hideRestoring();
      setBusy(m.busy);
      break;
    case "finalizing":
      turnFinalizing = true;
      stopPending = false;
      removeWorking();
      statusLine.textContent = userStopped ? "已停止 · 正在整理文件还原点…" : "回复已结束 · 正在整理文件还原点…";
      refreshComposerHint();
      break;
    case "restoring":
      // 还原正在自动停止本轮：进程真实退出要等 1~5s，宿主动手杀之前先发这条，
      // 让界面零延迟进入「已停止、正在还原」的过渡态——否则流被静默后药丸还在
      // 转，看起来就是卡死几秒。composer 保持锁定（等 busy:false 解锁），这几
      // 秒里回车的消息照常进等待队列，还原完成后会发进回退后的会话。
      // 注意不置 userStopped：还原走整页重载收尾，不该给某轮盖「已中断」标记。
      freezeLiveStream();
      setGlow("idle");
      statusLine.textContent = restoringRegen ? "正在重新生成…" : isBusy ? "正在停止回复并还原…" : "正在还原…";
      showRestoring();
      break;
    case "restored":
      hideRestoring();
      break;
    case "forking":
      if (m.busy) showForking(m.checkpointId, m.label);
      else if (forkingCheckpoint === m.checkpointId) hideForking();
      break;
    case "status":
      // Host-driven transient hint (e.g. cold-start context loading). Cleared
      // as soon as the stream produces anything, or when the turn ends.
      statusLine.textContent = m.label;
      if (isBusy && m.label) showWorking(m.label);
      break;
    case "activity":
      recordWorkingProgress(m.label);
      break;
    case "response_wait":
      assistantEl?.querySelector(".wk-wait")?.remove();
      if (m.idleMs >= 30000 && isBusy && !compacting && !stoppingView && !waitingQuestionId && glowState !== "waiting") {
        const wk = assistantEl?.querySelector(".working-pill") as HTMLElement | null;
        if (wk) {
          wk.dataset.progressAt = String(performance.now() - m.idleMs);
          paintWorkingTime(wk);
        }
        const hint = el("span", "wk-wait", "后端尚未返回新进展；仅凭静默无法确认是否卡住。");
        hint.setAttribute("role", "status");
        assistantEl?.querySelector(".working-pill")?.appendChild(hint);
        maybeScroll();
      }
      break;
    case "block_start":
      statusLine.textContent = "";
      onBlockStart(m.blockType, m.toolId, m.toolName);
      break;
    case "block_end":
      finalizeLive();
      liveBlock = null;
      if (isBusy) showModelOrToolWorking();
      break;
    case "text_delta":
      onTextDelta(m.text);
      break;
    case "text_snap":
      cancelLiveRender();
      // 完整消息与 delta 累计不一致时的权威快照：整块替换重排。
      if (!liveBlock) onBlockStart("text");
      liveBlock!.raw = m.text;
      if (m.text.trim()) turnHasReply = true;
      renderLive();
      break;
    case "thinking_delta":
      addStreamEst(m.text); // not displayed, but grows the live token estimate
      break;
    case "tokens":
      onTokens(m.output);
      break;
    case "thinking_tokens":
      // 真实思考 token 累计数（单调递增）——盖掉字符估算，让思考阶段的数字更准。
      turnThinkTokens = Math.max(turnThinkTokens, m.tokens);
      setPillTokens();
      break;
    case "context":
      updateContextGauge(m.used, m.total);
      break;
    case "refs_validated":
      for (const id of m.invalid) {
        const e = messagesEl.querySelector(`[data-ref-id="${id}"]`) as HTMLElement | null;
        if (e) unlinkRef(e);
      }
      break;
    case "local_image":
      localImagePending.delete(m.path);
      localImageCache.set(m.path, m.dataUri ?? null);
      for (const img of Array.from(messagesEl.querySelectorAll<HTMLImageElement>("img[data-local-src]"))) {
        if (img.dataset.localSrc === m.path) showLocalImage(img, m.dataUri);
      }
      break;
    case "tool_input":
      // app-server 可直接发完整工具输入，没有单独的 block_start。
      if (isBusy && !toolCards.has(m.toolId)) onBlockStart("tool_use", m.toolId, m.name);
      updateToolInput(m.toolId, m.name, m.input);
      if (m.agentLabel) {
        const card = toolCards.get(m.toolId);
        const title = card?.querySelector(".tool-name");
        if (title) title.textContent = `${m.displayName || m.name} · ${m.agentLabel}`;
      }
      break;
    case "tool_input_partial":
      if (m.name === "AskUserQuestion") updatePreparingQuestions(m.json);
      else updateToolPartial(m.toolId, m.name, m.json);
      break;
    case "tool_result":
      setToolResult(m.toolUseId, m.content, m.isError);
      if (isBusy && !compacting) showModelOrToolWorking();
      break;
    case "permission_request":
      assistantEl?.querySelector(".wk-wait")?.remove();
      setGlow("waiting"); // parked on the user — the rim pulses faster
      if (m.toolName === "AskUserQuestion") {
        if (m.agentLabel) childQuestionIds.add(m.requestId);
        waitingQuestionId = m.requestId;
        statusLine.textContent = m.agentLabel ? `${m.agentLabel}等待回答` : "已暂停 · 等待提交问题答案";
        removeWorking();
        if (assistantEl) assistantEl.classList.remove("streaming-turn");
        refreshComposerHint();
      }
      attachPermission(m);
      break;
    case "permission_resolved":
      if (waitingQuestionId === m.requestId) {
        // 答案提交成功会启动新的回答轮次；重新回答可能一直保持 busy，
        // 不能依赖 busy 的切换重置计时，否则会沿用回退前的旧起点。
        if (m.behavior === "allow" && !childQuestionIds.has(m.requestId)) turnStartedAt = performance.now();
        waitingQuestionId = undefined;
        statusLine.textContent = "";
      }
      if (isBusy) setGlow("running"); // answered — back to work
      resolvePermission(m.requestId, m.behavior);
      if (childQuestionIds.delete(m.requestId) && isBusy && !waitingQuestionId) showModelOrToolWorking();
      refreshComposerHint();
      break;
    case "question_answer_rejected":
      questionInteractions.get(m.requestId)?.retry(m.message);
      if (waitingQuestionId === m.requestId) setGlow("waiting");
      break;
    case "question_checkpoint":
      for (const card of Array.from(messagesEl.querySelectorAll<HTMLElement>(".askq-card"))) {
        if (card.dataset.requestId === m.requestId) attachReanswer(card, m.checkpointId);
      }
      break;
    case "result":
      // A turn the user cancelled is not a failure: no red rim.
      if (userStopped) setGlow("idle");
      else setGlow(m.isError ? "error" : "done");
      if (turnHasReply && !userStopped && !pinnedToBottom) newReplyAvailable = true;
      turnHasReply = false;
      finalizeTurn();
      updateJumpLatest();
      // 压缩的收尾也是一个普通 result。只靠 compacted 复位的话，压缩失败、或
      // 会话太小 CLI 直接跳过压缩（实测此时不发 compact_boundary）时，
      // 仪表盘会永远转圈且再也点不动。
      if (compacting) {
        compacting = false;
        ctxGauge.classList.remove("compacting");
      }
      if (m.numTurns != null) {
        statusLine.textContent = `完成 · ${m.numTurns} 轮`;
      }
      break;
    case "usage":
      if (m.planType !== undefined) currentPlanType = m.planType;
      if (m.resetCredits !== undefined) lastResetCredits = m.resetCredits;
      renderUsage(m.sessionPct, m.sessionResetAt, m.weekPct, m.weekResetAt, m.weekModelPct, m.weekModelName);
      break;
    case "compacting":
      compacting = true;
      assistantEl?.querySelector(".wk-wait")?.remove();
      setGlow("running");
      ctxGauge.classList.add("compacting");
      showWorking("正在压缩上下文…");
      break;
    case "compacted":
      compacting = false;
      ctxGauge.classList.remove("compacting");
      finalizeTurn(); // clears the working pill AND the otherwise-empty assistant bubble
      messagesEl.appendChild(renderCompactionDivider(m.preTokens, m.postTokens));
      maybeScroll();
      updateContextGauge(m.postTokens, lastCtxTotal);
      if (m.trigger === "auto" && isBusy) showWorking("上下文已压缩，等待继续回复…");
      break;
    case "rate_limit":
      renderRateLimit(m);
      break;
    case "rate_limit_cleared":
      clearRateLimit();
      break;
    case "error":
      if (m.keepBusy) {
        appendNotice(m.message, "error");
        break;
      }
      turnHasReply = false;
      if (restoreInProgress) queuePausedAfterRestore = true;
      hideRestoring(); // 还原失败也要撤掉遮罩，队列仍等待用户主动继续
      setGlow("error");
      finalizeTurn();
      // A fatal error may arrive with no busy:false (spawn failures kill the
      // proc before it ever reports); release the composer or it's stuck forever.
      setBusy(false);
      compacting = false;
      ctxGauge.classList.remove("compacting");
      appendNotice(m.message + (queuePausedAfterRestore ? "\n排队消息已暂停，可从队列撤回后重新发送。" : ""), "error");
      break;
    case "notice":
      if (m.message) appendNotice(m.message, "info");
      break;
    case "snapshot_skips":
      renderSnapshotSkips(m);
      break;
    case "snapshot_exclude_result": {
      const card = messagesEl.querySelector<HTMLElement>(".snapshot-skips");
      card?.querySelectorAll<HTMLButtonElement>("button").forEach(btn => btn.disabled = false);
      if (m.ok && card) {
        for (const row of Array.from(card.querySelectorAll<HTMLElement>(".ss-row"))) {
          if (m.paths.includes(row.dataset.path || "")) row.remove();
        }
        const remaining = Math.max(0, Number(card.dataset.total || 0) - m.paths.length);
        card.dataset.total = String(remaining);
        const count = card.querySelector(".ss-count");
        if (count) count.textContent = `${remaining} 项`;
        if (!remaining) card.remove();
      }
      appendNotice(m.message, m.ok ? "info" : "error");
      break;
    }
    case "prefill":
      inputEl.value = m.text;
      autoResize();
      inputEl.focus();
      inputEl.dispatchEvent(new Event("input"));
      break;
    case "load_history":
      hideForking();
      loadHistory(m.items, m.checkpoints, m.sessionId);
      updateQuestionBar(); // 短历史不触发滚动事件，主动对一次

      break;
    case "remote_user":
      finalizeTurn();
      appendUser(m.text);
      turnTokens = turnEst = turnThinkTokens = msgTokenBase = lastMsgTokens = 0;
      resetTokenTween();
      setBusy(true);
      break;
    case "checkpoint_marker":
      onCheckpointMarker(m.checkpointId);
      break;
    case "speed_context":
      if (m.model !== undefined) actualSpeedModel = m.model;
      if (m.billing !== undefined) speedBilling = m.billing;
      if (m.billing !== undefined && m.billing !== "chatgpt") { currentPlanType = undefined; lastResetCredits = null; }
      else if (m.planType !== undefined) currentPlanType = m.planType;
      if (!usageMenu.classList.contains("hidden")) buildUsageMenu();
      syncPickers();
      break;
    case "speed_mode_saved":
      showSpeedFeedback(m.mode);
      break;
    case "models":
      speedModels = m.models;
      modelEfforts = Object.fromEntries(m.models.map(x => [x.id, x.efforts]));
      modelDefaultEfforts = Object.fromEntries(m.models.map(x => [x.id, x.defaultEffort || ""]));
      const defaultModel = m.models.find(x => x.isDefault);
      if (defaultModel) {
        modelEfforts[""] = defaultModel.efforts;
        modelDefaultEfforts[""] = defaultModel.defaultEffort || "";
      }
      MODELS = [{ id: "", label: "默认模型", desc: "使用 Codex 默认模型" }, ...latestModelChoices(m.models).map(x => ({ id: x.id, label: x.name, desc: modelDescription(x) }))];
      syncPickers();
      if (!modelMenu.classList.contains("hidden")) buildModelMenu();
      break;
    case "config":
      if (m.modEnterToSend !== undefined) {
        modEnterToSend = m.modEnterToSend;
        const keys = document.querySelector(".foot-keys");
        if (keys) keys.innerHTML = modEnterToSend ? "<kbd>⌘/Ctrl ↵</kbd>发送<kbd>Enter</kbd>换行" : "<kbd>Enter</kbd>发送<kbd>⇧↵</kbd>换行";
      }
      modelPending = false;
      effortPending = false;
      speedPending = false;
      currentMode = m.permissionMode || "default";
      currentModel = m.model || "";
      currentEffort = m.effort || "";
      currentSpeedMode = m.speedMode ?? "default";

      syncPickers();
      if (!modelMenu.classList.contains("hidden")) buildModelMenu();
      break;
    case "context_added":
      addContextChip(m.label, m.text);
      break;
    case "active_file":
      onActiveFile(m.path);
      break;
    case "attach_files":
      for (const p of m.paths) addFile(p);
      break;
    case "changed_files":
      renderChangedFiles(m.files, m.totalAdded, m.totalRemoved);
      break;
  }
  const progress = {
    block_start: "任务阶段开始", block_end: "模型阶段完成",
    text_delta: "收到回复内容", text_snap: "收到回复内容",
    thinking_delta: "收到思考进展", tool_input: "收到工具输入",
    tool_input_partial: "收到工具输入", tool_result: "收到工具结果",
    compacting: "开始压缩上下文", compacted: "上下文压缩完成",
  };
  if (m.kind in progress) {
    const label = m.kind === "block_start"
      ? m.blockType === "thinking" ? "开始模型思考" : m.blockType === "tool_use" ? "工具开始执行" : "开始生成回复"
      : progress[m.kind as keyof typeof progress];
    recordWorkingProgress(label);
  }
});

/** The avatar is the reply's first node — the FIRST content step must not draw
 *  its own dot. Marked in JS because during a live turn the body also holds
 *  transient elements (thread-line/active, working pill) that break any
 *  sibling-based CSS selector. */
function markIfFirstNode(body: HTMLElement, step: HTMLElement) {
  const first = Array.from(body.children).find(
    (c) => c.classList.contains("step") || c.classList.contains("text-seg") || c.classList.contains("msg-images"),
  );
  if (first === step) step.classList.add("first-node");
}

function onBlockStart(type: "text" | "thinking" | "tool_use", toolId?: string, toolName?: string) {
  const body = ensureAssistant();
  if (type === "tool_use" && toolId) {
    finalizeLive();
    // AskUserQuestion shows as an interactive picker built from its permission
    // request (which only arrives after the whole tool input has streamed). Keep
    // the "思考中" pill alive until then so it doesn't look frozen — and never
    // render the raw tool card for it.
    if (toolName === "AskUserQuestion") {
      showWorking("准备选项…"); // updated live with a count as the input streams
      liveBlock = null;
      return;
    }
    createToolCard(body, toolId, toolName || "tool");
    // 文件操作也可能等待后端，所有工具执行期间都保留实时反馈。
    showWorking("正在执行工具…");
    liveBlock = null;
    return;
  }
  if (type === "thinking") {
    // 只保留运行中的状态反馈；结束后不插入重复的“思考片段”时间线行。
    finalizeLive();
    liveBlock = null;
    showWorking("模型思考中…");
    return;
  }
  finalizeLive(); // finalize previous text block with full highlighting
  const seg = el("div", "md text-seg");
  const committedEl = el("div", "live-committed");
  const lineEl = el("span", "live-line");
  seg.append(committedEl, lineEl);
  body.appendChild(seg);
  liveBlock = { type: "text", raw: "", el: seg, committedEl, lineEl, blocks: [], renderedAt: 0 };
  showWorking("正在回复…");
  maybeScroll();
}

function onTextDelta(text: string) {
  addStreamEst(text); // keep the running token estimate growing
  if (text.trim()) turnHasReply = true;
  if (!liveBlock) onBlockStart("text");
  const first = liveBlock!.raw.length === 0;
  liveBlock!.raw += text;
  if (first) renderLive();
  else {
    // 新文字先显示，下一帧再合并 Markdown；后台窗口暂停帧回调时也不会吞掉文字。
    const tail = liveBlock!.lineEl.lastChild;
    if (tail instanceof Text) tail.appendData(text);
    else liveBlock!.lineEl.appendChild(document.createTextNode(text));
    scheduleLiveRender();
    scheduleLiveLayout();
  }
}

// ---------------------------------------------------------------------------
// Tool cards
// ---------------------------------------------------------------------------
// File tools render compact (no icon, no inline result/diff); click -> editor.
const FILE_VIEW_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Skill"]);
const DIFF_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const FOLDABLE_TOOLS = new Set(["Bash", "WebSearch", "WebFetch"]);
const TOOL_GROUP_MIN = 2;
type ToolGroupKind = "bash" | "edit" | "web" | "other" | "mixed";
let toolBodySeq = 0;
let toolGroupSeq = 0;

function toolGroupKind(name: string): Exclude<ToolGroupKind, "mixed"> | null {
  if (!name || name === "AskUserQuestion") return null;
  if (name === "Bash") return "bash";
  if (DIFF_TOOLS.has(name)) return "edit";
  if (name === "WebSearch" || name === "WebFetch") return "web";
  return "other";
}

function setToolFolded(card: HTMLElement, folded: boolean) {
  card.classList.toggle("collapsed", folded);
  const toggle = card.querySelector<HTMLButtonElement>(".tool-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", String(!folded));
}

function timelineNodes(body: HTMLElement): HTMLElement[] {
  return Array.from(body.children).filter((node): node is HTMLElement =>
    node instanceof HTMLElement && (node.classList.contains("step") || node.classList.contains("text-seg") || node.classList.contains("msg-images")),
  );
}

function isGroupableStep(node: HTMLElement): boolean {
  if (!node.classList.contains("step")) return false;
  const card = node.querySelector<HTMLElement>(":scope > .tool-card");
  if (!card || card.classList.contains("needs-approval")) return false;
  const name = card.getAttribute("data-tool-name") || "";
  return toolGroupKind(name) !== null;
}

function setToolGroupFolded(group: HTMLElement, folded: boolean) {
  group.classList.toggle("collapsed", folded);
  group.querySelector<HTMLButtonElement>(".tool-group-toggle")?.setAttribute("aria-expanded", String(!folded));
}

function updateToolGroup(group: HTMLElement) {
  const cards = Array.from(group.querySelectorAll<HTMLElement>(".tool-group-items > .step > .tool-card"));
  const counts = { bash: 0, edit: 0, web: 0, other: 0 };
  for (const card of cards) {
    const kind = toolGroupKind(card.dataset.toolName || "");
    if (kind) counts[kind]++;
  }
  const kinds = (Object.keys(counts) as (keyof typeof counts)[]).filter(kind => counts[kind] > 0);
  const kind: ToolGroupKind = kinds.length === 1 ? kinds[0] : "mixed";
  group.dataset.groupKind = kind;
  group.classList.toggle("edit", kind === "edit");
  group.querySelector(".tool-group > .tool-group-toggle > .tool-name")!.textContent =
    kind === "bash" ? "Bash 调用" : kind === "edit" ? "文件修改" : kind === "web" ? "网页检索" : "工具调用";
  const failed = cards.filter((card) => card.classList.contains("error")).length;
  const waiting = cards.filter((card) => !card.classList.contains("error") && card.classList.contains("needs-approval")).length;
  const running = cards.filter((card) => !card.classList.contains("error") && !card.classList.contains("needs-approval") && card.classList.contains("running")).length;
  const done = cards.length - failed - waiting - running;
  const files = new Set(cards.map((card) => card.querySelector(".file-chip[data-path]")?.getAttribute("data-path")).filter(Boolean));
  group.querySelector(".tool-group-count")!.textContent = `${cards.length} 次` +
    (kind === "mixed" ? ` · ${[
      counts.bash ? `${counts.bash} Bash` : "",
      counts.edit ? `${counts.edit} 文件修改` : "",
      counts.web ? `${counts.web} 网页检索` : "",
      counts.other ? `${counts.other} 其他工具` : "",
    ].filter(Boolean).join(" · ")}` :
      kind === "edit" && files.size ? ` · ${files.size === 1 ? shortPath([...files][0]!) : `${files.size} 文件`}` : "");
  group.querySelector(".tool-group-status")!.textContent = [
    done ? `${done} 完成` : "", failed ? `${failed} 失败` : "",
    waiting ? `${waiting} 待确认` : "", running ? `${running} 执行中` : "",
  ].filter(Boolean).join(" · ");
  group.classList.toggle("error", failed > 0);
  group.classList.toggle("needs-approval", waiting > 0 && !failed);
  group.classList.toggle("ok", done === cards.length);
  if (waiting > Number(group.dataset.waitingCount || 0)) {
    setToolGroupFolded(group, false);
  }
  group.dataset.waitingCount = String(waiting);
}

/** Any two consecutive tool calls share one timeline node, regardless of name.
 *  Text and interactive questions/approvals end a run; child cards retain their order. */
function createToolGroup(body: HTMLElement, run: HTMLElement[], keepOpen = false) {
  const group = el("div", "step tool-group-step collapsed");
  const id = `tool-group-${++toolGroupSeq}`;
  const title = el("div", "tool-group");
  title.innerHTML =
    `<button type="button" class="tool-group-toggle" aria-expanded="false" aria-controls="${id}">` +
    `<span class="tool-fold-caret" aria-hidden="true">${ICON.chevron}</span>` +
    `<span class="tool-name"></span><span class="tool-group-count"></span>` +
    `<span class="tool-group-status"></span></button><div id="${id}" class="tool-group-items"></div>`;
  group.append(el("div", "step-dot"), title);
  const opened = run.some((node) => node.querySelector(".tool-card.foldable:not(.collapsed)"));
  body.insertBefore(group, run[0]);
  const items = group.querySelector(".tool-group-items")!;
  for (const node of run) {
    node.classList.remove("first-node");
    items.appendChild(node);
  }
  markIfFirstNode(body, group);
  title.querySelector<HTMLButtonElement>(".tool-group-toggle")!.addEventListener("click", () => {
    setToolGroupFolded(group, !group.classList.contains("collapsed"));
    pinnedToBottom = false;
  });
  updateToolGroup(group);
  if (opened || keepOpen) setToolGroupFolded(group, false);
}

function groupAdjacentTools(body: HTMLElement, step: HTMLElement) {
  const nodes = timelineNodes(body);
  const previous = nodes[nodes.length - 2];
  if (previous?.classList.contains("tool-group-step")) {
    previous.querySelector(".tool-group-items")!.appendChild(step);
    step.classList.remove("first-node");
    updateToolGroup(previous);
    return;
  }
  const run: HTMLElement[] = [step];
  for (let i = nodes.length - 2; i >= 0 && isGroupableStep(nodes[i]); i--) run.unshift(nodes[i]);
  if (run.length >= TOOL_GROUP_MIN) createToolGroup(body, run);
}

/** Approval can arrive after its tool has joined a group. Keep the actionable
 *  card on the main timeline and rebuild the runs around it. */
function separateExceptionalTool(card: HTMLElement) {
  const group = card.closest<HTMLElement>(".tool-group-step");
  if (!group) return;
  const body = group.parentElement;
  if (!body) return;
  const steps = Array.from(group.querySelectorAll<HTMLElement>(":scope > .tool-group > .tool-group-items > .step"));
  const keepOpen = !group.classList.contains("collapsed");
  const wasFirst = group.classList.contains("first-node");
  group.replaceWith(...steps);
  if (wasFirst) steps[0]?.classList.add("first-node");
  let run: HTMLElement[] = [];
  const flush = () => {
    if (run.length >= TOOL_GROUP_MIN) createToolGroup(body, run, keepOpen);
    run = [];
  };
  for (const step of steps) {
    if (isGroupableStep(step)) run.push(step);
    else flush();
  }
  flush();
  updateActiveLine();
}

function createToolCard(parent: HTMLElement, toolId: string, name: string): HTMLElement {
  if (toolCards.has(toolId)) return toolCards.get(toolId)!;
  const compact = FILE_VIEW_TOOLS.has(name);
  const foldable = FOLDABLE_TOOLS.has(name);
  const card = el("div", "tool-card running" + (compact ? " compact" : "") + (foldable ? " foldable collapsed" : ""));
  card.dataset.toolId = toolId;
  card.dataset.toolName = name;
  const head = el("div", "tool-head");
  const icon = compact ? "" : toolIcon(name);
  // 与官方 Codex 一致：TodoWrite 卡片标题显示为 "更新计划"。
  const displayName = name === "TodoWrite" ? "更新计划" : name;
  const titleHtml =
    `<span class="tool-name">${escapeHtml(displayName)}</span>` +
    `${icon ? `<span class="tool-icon">${icon}</span>` : ""}` +
    `<span class="tool-why"></span><span class="tool-sub"></span>`;
  const bodyWrap = el("div", "tool-body");
  if (foldable) {
    bodyWrap.id = `tool-body-${++toolBodySeq}`;
    head.innerHTML =
      `<button type="button" class="tool-toggle" aria-expanded="false" aria-controls="${bodyWrap.id}">` +
      `<span class="tool-fold-caret" aria-hidden="true">${ICON.chevron}</span>` + titleHtml +
      `<span class="tool-meta">执行中…</span></button><div class="tool-actions"></div>`;
    head.querySelector<HTMLButtonElement>(".tool-toggle")!.addEventListener("click", () => {
      setToolFolded(card, !card.classList.contains("collapsed"));
      pinnedToBottom = false;
    });
  } else {
    head.innerHTML = titleHtml + `<div class="tool-actions"></div>`;
  }
  card.append(head, bodyWrap);
  // Wrap as a timeline step with a node dot on the left rail (green for edits).
  const step = el("div", "step" + (DIFF_TOOLS.has(name) ? " edit" : "") + (foldable ? " foldable-step" : ""));
  step.append(el("div", "step-dot"), card);
  parent.appendChild(step);
  markIfFirstNode(parent, step);
  toolCards.set(toolId, card);
  const kind = toolGroupKind(name);
  if (kind) groupAdjacentTools(parent, step);
  updateActiveLine(); // the new dot becomes the active progress start
  maybeScroll();
  return card;
}

function updateToolInput(toolId: string, name: string, input: Record<string, unknown>) {
  if (name === "AskUserQuestion") return; // rendered as an interactive picker, not a card
  let card = toolCards.get(toolId);
  if (!card) card = createToolCard(ensureAssistant(), toolId, name);
  const sub = card.querySelector(".tool-sub") as HTMLElement;
  const bodyWrap = card.querySelector(".tool-body") as HTMLElement;
  const { subtitle, html } = renderToolInput(name, input);
  if (name === "Skill") {
    // 对齐官方：加粗显示技能名本身，右侧灰字 "skill" 标注类型；
    // 技能正文（加载进上下文的说明文）不进卡片。
    const nm = card.querySelector(".tool-name") as HTMLElement | null;
    const skillName = String((input as { skill?: unknown }).skill ?? "") || "Skill";
    if (nm) nm.textContent = skillName;
    if (sub) sub.textContent = "skill";
    return;
  }
  if (FILE_VIEW_TOOLS.has(name)) {
    // Read/Edit/…: filename on the SAME line as the tool name (in the header), no wrap.
    if (sub) sub.innerHTML = html;
    const group = card.closest<HTMLElement>(".tool-group-step");
    if (group) updateToolGroup(group);
    return;
  }
  if (sub) sub.textContent = subtitle;
  // Replace (don't stack) — a permission_request may already have rendered one.
  bodyWrap.querySelector(".tool-input")?.remove();
  if (!html) return; // header-only tool (WebSearch/Glob/…): nothing to box
  const inputEl2 = el("div", "tool-input");
  inputEl2.innerHTML = html;
  // keep any existing result/permission below
  bodyWrap.prepend(inputEl2);
  // Non-file tools have a code block — put copy (+ run for Bash) in the card header.
  // 任务清单不是代码，复制按钮没有意义。
  const actions = card.querySelector(".tool-actions") as HTMLElement | null;
  if (actions) {
    actions.innerHTML =
      name === "TodoWrite"
        ? ""
        : (name === "Bash" ? `<button class="code-act" data-action="run" title="在终端执行">${ICON.play}</button>` : "") +
          `<button class="code-act" data-action="copy" title="复制">${ICON.copy}</button>`;
  }
}

/** Live update while a tool's input JSON is still streaming — show the target
 *  file and a growing line count so an Edit/Write is visible before it finishes. */
/** Live feedback while the AskUserQuestion input streams in (it can be large
 *  with many questions/options) — show how many questions/options have arrived
 *  so the wait for the picker doesn't look frozen. */
function updatePreparingQuestions(json: string) {
  const wk = assistantEl?.querySelector(".working-pill") as HTMLElement | null;
  if (!wk) return;
  const qs = (json.match(/"question"\s*:/g) || []).length;
  const opts = (json.match(/"label"\s*:/g) || []).length;
  let label = "准备选项…";
  if (qs > 0) label = `准备选项 · ${qs} 个问题` + (opts > 0 ? ` ${opts} 选项…` : "…");
  const lbl = wk.querySelector(".wk-label") as HTMLElement | null;
  if (lbl) lbl.textContent = label;
}

function updateToolPartial(toolId: string, name: string, json: string) {
  const card = toolCards.get(toolId);
  if (!card) return;
  const sub = card.querySelector(".tool-sub") as HTMLElement | null;
  if (!sub) return;
  // Tolerant extraction of the target file path (needs its closing quote).
  const fpm = /"(?:file_path|notebook_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json);
  if (!fpm) return; // path hasn't fully streamed in yet
  const fp = fpm[1].replace(/\\(["\\/])/g, "$1");
  const rel = shortPath(fp);
  // Live line count of the content being written (new_string for Edit, content for Write).
  let lines = 0;
  const key = name === "Write" ? "content" : "new_string";
  const km = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (km) {
    let body = json.slice(km.index + km[0].length).replace(/"\s*[,}]?\s*$/, "");
    lines = (body.match(/\\n/g) || []).length + 1;
  }
  const extra = lines > 0 ? ` <span class="muted">编辑 ${lines} 行…</span>` : ` <span class="muted">编辑中…</span>`;
  if (FILE_VIEW_TOOLS.has(name)) {
    const cls = DIFF_TOOLS.has(name) ? "file-chip diff-chip" : "file-chip";
    const action = DIFF_TOOLS.has(name) ? "diff" : "open";
    sub.innerHTML = `<a class="${cls}" data-action="${action}" data-path="${escapeHtml(fp)}">${escapeHtml(rel)}</a>${extra}`;
    const group = card.closest<HTMLElement>(".tool-group-step");
    if (group) updateToolGroup(group);
  } else {
    sub.textContent = rel;
  }
  maybeScroll();
}

/** Only the CLI's exact cancellation sentinels — a substring match ("interrupt"
 *  appears in ordinary code/output constantly) hid perfectly good results. */
function isInterruptSentinel(content: string): boolean {
  const t = content.trim();
  return (
    t === "[Request interrupted by user]" ||
    t === "[Request interrupted by user for tool use]" ||
    t.startsWith("The user doesn't want to proceed") ||
    t === "已中断。"
  );
}

/** Pull {title,url} pairs out of a WebSearch/WebFetch result blob. Tolerant:
 *  the payload is usually `… Links: [{"title":"…","url":"…"}, …]` but may vary,
 *  so we scan for the JSON array and fall back to a loose regex. */
function extractSearchLinks(text: string): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  const add = (title: string, url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") out.push({ title, url: parsed.href });
    } catch { /* Ignore malformed links in tool output. */ }
  };
  const m = /\[\s*{[\s\S]*}\s*\]/.exec(text);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        for (const o of arr) {
          if (o && typeof o === "object" && (o.url || o.link)) {
            add(String(o.title ?? o.name ?? ""), String(o.url ?? o.link));
          }
        }
      }
    } catch { /* fall through to regex */ }
  }
  if (!out.length) {
    const re = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"url"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let r: RegExpExecArray | null;
    while ((r = re.exec(text))) add(r[1], r[2]);
  }
  return out;
}

/** host of a url for the muted second line (falls back to the raw string). */
function prettyHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function setToolResult(toolUseId: string, content: string, isError: boolean) {
  const card = toolCards.get(toolUseId);
  if (!card) return;
  card.classList.remove("running");
  // Abnormal endings: mark the node red and show WHY it stopped.
  const interrupted = isInterruptSentinel(content);
  const bad = isError || interrupted;
  card.classList.toggle("error", bad);
  card.closest(".step")?.classList.toggle("error", bad); // red timeline dot
  // Compact tools have no folding header; give their errors an inline detail
  // button so the diagnostic is available without taking up timeline space.
  const actions = card.querySelector<HTMLElement>(".tool-actions");
  let errorToggle = actions?.querySelector<HTMLButtonElement>(".tool-error-toggle");
  if (isError && content.trim() && !card.classList.contains("foldable")) {
    if (!errorToggle) {
      card.classList.add("error-details-collapsed");
      errorToggle = el("button", "tool-error-toggle", "查看详情") as HTMLButtonElement;
      errorToggle.type = "button";
      errorToggle.setAttribute("aria-expanded", "false");
      errorToggle.addEventListener("click", () => {
        const collapsed = card.classList.toggle("error-details-collapsed");
        errorToggle!.textContent = collapsed ? "查看详情" : "收起详情";
        errorToggle!.setAttribute("aria-expanded", String(!collapsed));
        pinnedToBottom = false;
      });
      actions?.appendChild(errorToggle);
    }
  } else {
    errorToggle?.remove();
    card.classList.remove("error-details-collapsed");
  }
  // A Bash step that ran clean turns its node green — executed, side effects in
  // place — matching the green Edit/Write dots. Read stays a neutral gray.
  if (!bad && (card.dataset.toolName || "") === "Bash") card.closest(".step")?.classList.add("ok");
  const why = card.querySelector(".tool-why") as HTMLElement | null;
  if (why) {
    why.classList.toggle("warn", interrupted && !isError);
    why.textContent = interrupted && !isError ? "已中断" : isError ? "失败" : "";
  }
  const tn = card.dataset.toolName || "";
  const meta = card.querySelector<HTMLElement>(".tool-meta");
  if (meta) {
    const links = !bad && (tn === "WebSearch" || tn === "WebFetch") ? extractSearchLinks(content) : [];
    const lines = content.replace(/\n+$/, "").split("\n").length;
    meta.textContent = bad ? "查看详情" : content.trim() ? `完成 · ${links.length ? `${links.length} 条` : `${lines} 行`}` : "完成 · 无输出";
  }
  const group = card.closest<HTMLElement>(".tool-group-step");
  if (group) updateToolGroup(group);
  // A failed tool drops its head icon too, so the title is just the name.
  if (bad) card.querySelector(".tool-head .tool-icon")?.remove();
  // Interrupted: the "[Request interrupted by user]" text is shown once at the
  // end of the reply, so don't also dump it in the tool body — the badge says it.
  if (interrupted && !isError) {
    maybeScroll();
    return;
  }
  // While the model moves on to the next step, show the thinking pill again.
  if (isBusy) showWorking();
  // File tools (Read/Edit/Write/…) don't show their result body — only errors.
  // TodoWrite 的结果只是 "Todos have been modified" 一类的确认语，也不用展示。
  if ((FILE_VIEW_TOOLS.has(tn) || tn === "TodoWrite") && !isError) {
    maybeScroll();
    return;
  }
  const bodyWrap = card.querySelector(".tool-body") as HTMLElement;
  const existing = card.querySelector(".tool-result");
  if (existing) existing.remove();
  // WebSearch/WebFetch return a JSON-ish blob ("… Links: [{\"title\":…}]") —
  // pull out the titles+urls and show them as a tidy link list, not raw text.
  if (!bad && (tn === "WebSearch" || tn === "WebFetch")) {
    const links = extractSearchLinks(content);
    if (links.length) {
      const box = el("div", "tool-result");
      const list = el("div", "search-results");
      const SHOW = 3; // 前 3 条常显，多的折叠
      links.forEach((l, i) => {
        const a = el("a", "search-hit" + (i >= SHOW ? " extra hidden" : "")) as HTMLAnchorElement;
        a.href = l.url;
        a.innerHTML = `<span class="sh-title">${escapeHtml(l.title || l.url)}</span><span class="sh-url">${escapeHtml(prettyHost(l.url))}</span>`;
        list.appendChild(a);
      });
      box.appendChild(list);
      if (links.length > SHOW) {
        const more = el("button", "search-more") as HTMLButtonElement;
        const rest = links.length - SHOW;
        const setLabel = () =>
          (more.innerHTML = `${ICON.chevron}` + (more.classList.contains("on") ? "收起" : `其余结果 ${rest} 条`));
        more.onclick = () => {
          more.classList.toggle("on");
          box.querySelectorAll(".search-hit.extra").forEach((e) => e.classList.toggle("hidden"));
          setLabel();
        };
        setLabel();
        box.appendChild(more);
      }
      bodyWrap.appendChild(box);
      maybeScroll();
      return;
    }
  }
  const shown = truncateText(content, 8000);
  const lines = shown.replace(/\n+$/, "").split("\n").length;
  if (isError) {
    // Errors: no header row — the red node already says it failed. Fold to a
    // ~3-line preview like a long Bash command, but decide by MEASURED height:
    // this text is only 3 newlines yet wraps to ~8 visual lines.
    const box = el("div", "tool-result err-flat collapsed");
    const bodyDiv = el("div", "err-body");
    const pre = el("pre", "tool-result-body");
    pre.textContent = shown;
    bodyDiv.appendChild(pre);
    box.appendChild(bodyDiv);
    bodyWrap.appendChild(box);
    // Only keep it collapsed (and show the toggle) if it actually overflows.
    // Hidden hosts (folded history) measure 0 — fall back to the line count.
    const overflows = pre.scrollHeight === 0 ? lines > 3 : pre.scrollHeight - pre.clientHeight > 4;
    if (overflows) {
      const btn = el("button", "code-expand") as HTMLButtonElement;
      const setLabel = () =>
        (btn.innerHTML = box.classList.contains("collapsed") ? `${ICON.chevron}展开全部 ${lines} 行` : `${ICON.chevron}收起`);
      btn.onclick = () => {
        box.classList.toggle("collapsed");
        setLabel();
      };
      setLabel();
      box.appendChild(btn);
    } else {
      box.classList.remove("collapsed");
    }
    maybeScroll();
    return;
  }
  const details = el("details", "tool-result");
  const summary = el("summary");
  summary.innerHTML =
    `<span class="tr-caret">${ICON.chevron}</span>` +
    `<span class="tr-title">查看结果</span>` +
    `<span class="tr-count">${lines} 行</span>`;
  const pre = el("pre", "tool-result-body");
  pre.textContent = shown;
  details.append(summary, pre);
  bodyWrap.appendChild(details);
  maybeScroll();
}

function renderToolInput(name: string, input: Record<string, unknown>): { subtitle: string; html: string } {
  const fp = (input.file_path || input.notebook_path || input.path) as string | undefined;
  const rel = fp ? shortPath(fp) : "";
  // Read: clickable filename that opens the file at the lines read.
  if (name === "Read") {
    if (!fp) return { subtitle: "", html: "" };
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    const start = offset ?? 1;
    const end = limit != null ? start + limit - 1 : undefined;
    const lineAttr = offset != null ? ` data-line="${start}"${end != null ? ` data-endline="${end}"` : ""}` : "";
    const rangeLabel =
      offset != null || limit != null ? ` <span class="muted line-range">lines ${start}${end != null ? "-" + end : "+"}</span>` : "";
    return {
      subtitle: "",
      html: `<a class="file-chip" data-action="open" data-path="${escapeHtml(fp)}"${lineAttr}>${escapeHtml(rel)}</a>${rangeLabel}`,
    };
  }
  // Edit/Write/MultiEdit/NotebookEdit: clickable filename -> native red/green diff. No inline diff.
  if (DIFF_TOOLS.has(name)) {
    const extra =
      name === "MultiEdit" && Array.isArray(input.edits) ? `<span class="muted">· ${(input.edits as any[]).length} 处修改</span>` : "";
    return {
      subtitle: "",
      html: fp
        ? `<a class="file-chip diff-chip" data-action="diff" data-path="${escapeHtml(fp)}" title="点击查看改动 (红=旧 / 绿=新)">${escapeHtml(rel)}</a> ${extra}`
        : "",
    };
  }
  switch (name) {
    case "TodoWrite": {
      // 渲染成勾选清单（对齐官方样式）：完成 = 勾选+删除线，进行中 = 高亮，待办 = 空框。
      const todos = Array.isArray(input.todos) ? (input.todos as Array<{ content?: string; status?: string; activeForm?: string }>) : [];
      if (!todos.length) return { subtitle: "", html: "" };
      const rows = todos
        .map((t) => {
          const st = t?.status === "completed" ? " done" : t?.status === "in_progress" ? " doing" : "";
          const text = String((t?.status === "in_progress" && t?.activeForm) || t?.content || "");
          return `<div class="todo-item${st}"><span class="todo-box"></span><span class="todo-text">${escapeHtml(text)}</span></div>`;
        })
        .join("");
      const done = todos.filter((t) => t?.status === "completed").length;
      return { subtitle: `${done}/${todos.length}`, html: `<div class="todo-list">${rows}</div>` };
    }
    case "Bash": {
      const cmd = String(input.command ?? "");
      // The description belongs on the title line next to "Bash", not as the
      // card's first row; without one, the command's first line stands in so
      // the step is identifiable while collapsed/scrolling.
      const subtitle = input.description ? String(input.description) : cmd.split("\n")[0];
      // No syntax colours on shell commands — flags/strings lighting up in
      // four hues adds noise, not structure. Plain mono, one colour.
      return { subtitle, html: codeBlock(cmd, "") };
    }
    case "Task":
    case "Agent": {
      // A subagent launch is a task briefing, not a JSON payload: agent type on
      // the title line, the prompt as readable prose (collapsed when long).
      const type = String(input.subagent_type ?? input.agentType ?? "");
      const desc = String(input.description ?? "");
      const prompt = String(input.prompt ?? "");
      if (!prompt) return { subtitle: desc || type, html: codeBlock(truncateText(JSON.stringify(input, null, 2), 3000), "json") };
      const subtitle = [desc, type && desc !== type ? type : ""].filter(Boolean).join(" · ");
      const lines = prompt.split("\n").length;
      const long = lines > COLLAPSE_THRESHOLD || prompt.length > 420;
      const expand = long
        ? `<button class="code-expand" data-action="toggle-code">${ICON.chevron}展开全部 ${lines} 行</button>`
        : "";
      return {
        subtitle,
        html:
          `<div class="code-block agent-brief${long ? " collapsible collapsed" : ""}" data-lines="${lines}">` +
          `<div class="code-body"><pre>${escapeHtml(prompt)}</pre></div>${expand}</div>`,
      };
    }
    case "Grep": {
      // pattern in the header; path/glob as a muted tail. No JSON body.
      const where = [input.path, input.glob].filter(Boolean).map(String).join(" ");
      return { subtitle: String(input.pattern ?? ""), html: where ? `<div class="muted">${escapeHtml(where)}</div>` : "" };
    }
    case "Glob":
      return { subtitle: String(input.pattern ?? ""), html: "" };
    case "WebSearch":
      return { subtitle: String(input.query ?? ""), html: "" };
    case "WebFetch": {
      const url = String(input.url ?? "");
      const prompt = input.prompt ? String(input.prompt) : "";
      return { subtitle: url, html: prompt ? `<div class="muted">${escapeHtml(prompt)}</div>` : "" };
    }
    default: {
      // Unknown tool (incl. mcp__* servers): a readable "key: value" summary of
      // scalar params instead of a raw JSON blob. Objects/arrays are noted by
      // shape, not dumped. Nothing sensible → fall back to compact JSON.
      const rows = Object.entries(input)
        .map(([k, v]) => {
          if (v == null) return null;
          if (typeof v === "object") return `${k}: ${Array.isArray(v) ? `[${v.length} 项]` : "{…}"}`;
          const val = String(v);
          return `${k}: ${val.length > 140 ? val.slice(0, 140) + "…" : val}`;
        })
        .filter(Boolean) as string[];
      if (!rows.length) return { subtitle: fp || "", html: "" };
      const body = rows.map((r) => `<div class="param-row">${escapeHtml(r)}</div>`).join("");
      return { subtitle: fp || "", html: `<div class="param-list">${body}</div>` };
    }
  }
}

/** Show a workspace-relative-ish path (drop everything above the last 2 segments if very long). */
function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : p;
}

// ---------------------------------------------------------------------------
// Permission (待确认) cards
// ---------------------------------------------------------------------------
function attachPermission(m: Extract<ToWebview, { kind: "permission_request" }>) {
  if (m.toolName === "AskUserQuestion") {
    renderQuestion(m);
    return;
  }
  let host = m.toolUseId ? toolCards.get(m.toolUseId) : undefined;
  if (!host) {
    host = createToolCard(ensureAssistant(), m.toolUseId || m.requestId, m.toolName);
    updateToolInput(m.toolUseId || m.requestId, m.toolName, m.input);
  }
  host.classList.add("needs-approval");
  if (host.classList.contains("foldable")) setToolFolded(host, false);
  separateExceptionalTool(host);
  const group = host.closest<HTMLElement>(".tool-group-step");
  if (group) updateToolGroup(group);
  // The amber node on the timeline is the status marker for "waiting on you" —
  // the bar itself stays neutral instead of painting the whole card yellow.
  host.closest(".step")?.classList.add("needs-approval");
  const bar = el("div", "perm-bar");
  bar.dataset.requestId = m.requestId;
  const label = el("div", "perm-label");
  const strong = el("b");
  strong.textContent = m.displayName || m.toolName;
  label.append(document.createTextNode("需要确认 · "), strong);
  const actions = el("div", "perm-actions");
  const allow = el("button", "perm-allow", "允许");
  const deny = el("button", "perm-deny", "拒绝");
  allow.onclick = () => send({ type: "permission", requestId: m.requestId, behavior: "allow" });
  deny.onclick = () => send({ type: "permission", requestId: m.requestId, behavior: "deny" });
  // Left to right = least to most committal: 总是允许 · 拒绝 · 允许.
  for (const s of m.suggestions || []) {
    const b = el("button", "perm-always", s.label);
    b.onclick = () => send({ type: "permission", requestId: m.requestId, behavior: "allow", suggestionId: s.id });
    actions.appendChild(b);
  }
  actions.append(deny, allow);
  bar.append(label, actions);
  (host.querySelector(".tool-body") as HTMLElement).appendChild(bar);
  maybeScroll();
}

/** Build an "AskUserQuestion" timeline node: a separate title + a boxed
 *  question→answer list (used both live after answering and in history). */
function askQuestionNode(pairs: [string, string][], emptyText = ""): HTMLElement {
  const card = el("div", "tool-card askq-card");
  card.dataset.toolName = "AskUserQuestion";
  const head = el("div", "tool-head");
  head.innerHTML = `<span class="tool-name">AskUserQuestion</span>`;
  const bodyWrap = el("div", "tool-body");
  if (pairs.length) {
    const list = el("div", "askq-summary");
    for (const [q, a] of pairs) {
      const row = el("div", "askq-row");
      row.append(el("span", "askq-q", q), el("span", "askq-a", a));
      list.appendChild(row);
    }
    bodyWrap.appendChild(list);
  } else if (emptyText) {
    bodyWrap.appendChild(el("div", "askq-skip", emptyText));
  }
  card.append(head, bodyWrap);
  const step = el("div", "step");
  step.append(el("div", "step-dot"), card);
  return step;
}
function attachReanswer(card: HTMLElement, checkpointId: string) {
  if (card.querySelector(".askq-reanswer")) return;
  const button = el("button", "askq-reanswer", "重新回答");
  button.type = "button";
  button.title = "还原到提交这次答案之前，修改答案后继续";
  button.addEventListener("click", event => {
    event.stopPropagation();
    send({ type: "reanswerQuestion", checkpointId });
  });
  card.querySelector(".tool-head")!.appendChild(button);
}

/** Render a previously-answered AskUserQuestion (from history) as a clean node,
 *  instead of the raw "Your questions have been answered: …" tool output. */
function renderAnsweredQuestion(parent: HTMLElement, result: string) {
  const pairs: [string, string][] = [...result.matchAll(/"([^"]+)"\s*=\s*"([^"]*)"/g)].map((mm) => [mm[1], mm[2]]);
  parent.appendChild(askQuestionNode(pairs, pairs.length ? "" : truncateText(result, 1000)));
  maybeScroll();
}

/** Render an AskUserQuestion tool as a compact paginated option picker. */
function renderQuestion(m: Extract<ToWebview, { kind: "permission_request" }>) {
  if (questionInteractions.has(m.requestId)) return;
  const body = ensureAssistant();
  removeWorking();
  const questions = ((m.input as { questions?: any[] })?.questions || []) as Array<{
    id?: string;
    question: string;
    header?: string;
    multiSelect?: boolean;
    isOther?: boolean;
    isSecret?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
  if (!questions.length) {
    // 无法作答时停止本轮，不能把空答案当作用户确认。
    appendNotice("提问内容无效，本轮已停止，请重新发送消息。", "error");
    send({ type: "interrupt" });
    return;
  }

  const sel = questions.map(() => new Set<string>()); // chosen built-in labels per question
  const custom = questions.map(() => ""); // custom answer text per question
  const pictures: AnswerImage[][] = questions.map(q => q.isSecret || m.agentLabel ? [] : [...(m.initialImages?.[q.id || q.question] ?? [])]);
  questions.forEach((q, i) => {
    if (q.isSecret) return; // 秘密答案必须重新填写，不回填遮蔽占位文字。
    const value = m.initialAnswers?.[q.id || q.question];
    if (value == null) return;
    const values = Array.isArray(value) ? value : [value];
    for (const answer of values) {
      if (q.options?.some(option => option.label === answer)) sel[i].add(answer);
      else custom[i] = custom[i] ? `${custom[i]}、${answer}` : answer;
    }
  });
  let cur = 0;
  let done = false;
  let submitting = false;
  let readingImages = 0;
  let submittedAnswers: Record<string, string | string[]> | undefined;

  const wrap = el("div", "askp");
  wrap.dataset.requestId = m.requestId;
  const card = el("div", "askp-card");
  const head = el("div", "askp-head");
  const qText = el("span", "askp-q");
  const xBtn = el("button", "askp-x", "×");
  xBtn.title = "停止本轮";
  head.append(qText, xBtn);
  const optsBox = el("div", "askp-opts");
  const foot = el("div", "askp-foot");
  const pager = el("div", "askp-pager");
  const prev = el("button", "askp-nav") as HTMLButtonElement;
  const next = el("button", "askp-nav") as HTMLButtonElement;
  prev.innerHTML = ICON.chevronLeft;
  next.innerHTML = ICON.chevronRight;
  const idx = el("span", "askp-idx");
  pager.append(prev, idx, next);
  const submit = el("button", "askp-submit", "提交") as HTMLButtonElement;
  foot.append(pager, submit);
  card.append(head, optsBox, foot);
  const submitError = el("div", "askp-error hidden");
  card.append(submitError);
  wrap.append(card);

  const answered = (qi: number) => sel[qi].size > 0 || custom[qi].trim().length > 0 || pictures[qi].length > 0;
  const imagePayload = (): QuestionImages => Object.fromEntries(questions.flatMap((q, qi) => pictures[qi].length ? [[q.id || q.question, pictures[qi]]] : []));
  async function addPictures(files: File[], qi: number) {
    if (done || submitting || questions[qi].isSecret || m.agentLabel || !files.length) return;
    readingImages++;
    updateFoot();
    submitError.classList.add("hidden");
    try {
      for (const file of files) {
        if (!QUESTION_IMAGE_TYPES.includes(file.type)) throw new Error("图片仅支持 PNG、JPEG、WebP 和 GIF");
        if (file.size > QUESTION_IMAGE_MAX_BYTES) throw new Error("单张图片不能超过 10 MB");
        if (pictures.reduce((n, items) => n + items.length, 0) >= 10) throw new Error("一次回答最多添加 10 张图片");
        const uri = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reader.onabort = () => reject(new Error("图片读取失败，请重新添加"));
          reader.readAsDataURL(file);
        });
        if (done || !wrap.isConnected) return;
        const match = /^data:([^;]+);base64,(.+)$/.exec(uri);
        if (!match) throw new Error("图片数据无效，请重新添加");
        const added = { mediaType: match[1], data: match[2] };
        validateQuestionImages({ ...imagePayload(), [questions[qi].id || questions[qi].question]: [...pictures[qi], added] });
        pictures[qi].push(added);
      }
    } catch (err) {
      if (!done) { submitError.textContent = String((err as Error).message); submitError.classList.remove("hidden"); }
    } finally {
      readingImages--;
      if (!done && wrap.isConnected) {
        const refocus = qi === cur && document.activeElement?.classList.contains("askp-input");
        paint();
        if (refocus) optsBox.querySelector<HTMLElement>(".askp-input")?.focus();
      }
    }
  }
  wrap.addEventListener("paste", e => {
    const files = Array.from(e.clipboardData?.items ?? []).filter(item => item.type.startsWith("image/")).flatMap(item => {
      const file = item.getAsFile(); return file ? [file] : [];
    });
    if (!files.length || questions[cur].isSecret || m.agentLabel) return;
    e.preventDefault(); e.stopPropagation();
    void addPictures(files, cur);
  });
  wrap.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
  wrap.addEventListener("drop", e => {
    e.preventDefault(); e.stopPropagation();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length && !done && !submitting) {
      submitError.textContent = "此拖放未提供图片内容，请使用“添加图片”或粘贴截图。";
      submitError.classList.remove("hidden");
    }
    void addPictures(files, cur);
  });

  /** Move to the next question. `delay` lets the ✓ feedback land before the flip.
   *  `submitOnLast` — only Enter does this; clicking an option on the last page
   *  leaves it up so the user can still revise earlier answers. */
  const advance = (from: number, delay: number, submitOnLast = false) => {
    if (from < questions.length - 1) {
      setTimeout(() => {
        if (!done && !submitting && cur === from) {
          cur = from + 1;
          paint();
        }
      }, delay);
    } else if (submitOnLast) {
      setTimeout(() => {
        if (done || submitting || cur !== from) return;
        if (!submit.disabled) {
          submit.click();
          return;
        }
        // Some earlier question is still unanswered — jump to the first one
        // instead of silently doing nothing.
        const gap = questions.findIndex((_, qi) => !answered(qi));
        if (gap >= 0) {
          cur = gap;
          paint();
        }
      }, delay);
    }
  };

  const updateFoot = () => {
    const multi = questions.length > 1;
    pager.style.display = multi ? "" : "none";
    idx.textContent = `${cur + 1}/${questions.length}`;
    prev.disabled = cur === 0;
    next.disabled = cur === questions.length - 1;
    submit.disabled = submitting || readingImages > 0 || !questions.every((_, qi) => answered(qi));
    submit.textContent = submitting ? "提交中…" : readingImages ? "读取图片中…" : "提交";
  };

  function paint() {
    const q = questions[cur];
    qText.textContent = `${m.agentLabel ? `${m.agentLabel} · ` : ""}${q.question || ""}`;
    optsBox.innerHTML = "";
    const opts = q.options || [];
    const rows: HTMLElement[] = [];
    opts.forEach((o, i) => {
      const row = el("button", "askp-opt" + (q.multiSelect ? " multi" : ""));
      if (sel[cur].has(o.label)) row.classList.add("on");
      row.append(el("span", "askp-n", String(i + 1)));
      if (q.multiSelect) row.append(el("span", "askp-box")); // checkbox for multi-select
      const txt = el("span", "askp-txt");
      txt.append(el("span", "askp-lbl", String(o.label)));
      if (o.description) txt.append(el("span", "askp-desc", String(o.description)));
      row.append(txt);
      if (!q.multiSelect) {
        const check = el("span", "askp-check");
        check.innerHTML = ICON.check; // right ✓ for single-select
        row.append(check);
      }
      row.onclick = () => {
        if (q.multiSelect) {
          if (sel[cur].has(o.label)) {
            sel[cur].delete(o.label);
            row.classList.remove("on");
          } else {
            sel[cur].add(o.label);
            row.classList.add("on");
          }
          updateFoot();
        } else {
          sel[cur].clear();
          sel[cur].add(o.label);
          custom[cur] = "";
          rows.forEach((r) => r.classList.remove("on"));
          row.classList.add("on");
          customInput.value = "";
          growCustom();
          customRow.classList.remove("on");
          updateFoot();
          // Single-select: auto-advance after a brief beat so the ✓ is visible.
          advance(cur, 120);
        }
      };
      rows.push(row);
      optsBox.append(row);
    });

    const customRow = el("div", "askp-opt askp-custom");
    customRow.append(el("span", "askp-n", String(opts.length + 1)));
    // 用 textarea 而不是 input：单行 input 粘贴多行文本会被浏览器把换行吃掉，
    // 贴一段日志/代码进来就粘成一行。随内容增高，超出上限内部滚动。
    const customInput = el(q.isSecret ? "input" : "textarea", "askp-input") as HTMLInputElement | HTMLTextAreaElement;
    if (customInput instanceof HTMLTextAreaElement) customInput.rows = 1;
    else customInput.type = "password";
    customInput.placeholder = q.isSecret ? "输入私密答案" : m.agentLabel ? "自定义回答（⇧↵ 换行）" : "自定义回答，也可粘贴图片（⇧↵ 换行）";
    customInput.value = custom[cur];
    const growCustom = () => {
      // 没进文档时 scrollHeight 恒为 0，量出来会把输入框压成 0 高——首次 paint()
      // 正是在 wrap 挂到消息区之前跑的，所以这里必须挡住。
      if (!customInput.isConnected || q.isSecret) return;
      customInput.style.height = "auto";
      customInput.style.height = Math.min(customInput.scrollHeight, 132) + "px";
    };
    if (custom[cur].trim()) customRow.classList.add("on");
    customInput.oninput = () => {
      custom[cur] = customInput.value;
      growCustom();
      if (!q.multiSelect && customInput.value.trim()) {
        sel[cur].clear();
        rows.forEach((r) => r.classList.remove("on"));
      }
      customRow.classList.toggle("on", customInput.value.trim().length > 0);
      updateFoot();
    };
    customInput.onkeydown = (e) => {
      // 只挡 Enter/Escape 别漏给后面的聊天输入框。绝不能对所有键 stopPropagation：
      // VS Code webview 里 Cmd+V/C/X/A 不是浏览器原生动作，是 window 级监听器转给
      // VS Code 再派发回来的——在这截断，快捷键就全哑了（之前粘不进就是这个原因）。
      if (e.key === "Enter" || e.key === "Escape") e.stopPropagation();
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || (e as KeyboardEvent).keyCode === 229) return;
      e.preventDefault();
      if (!answered(cur)) return;
      // Enter = "I'm done with this question" → next page, or submit on the last.
      advance(cur, 120, true);
    };
    customRow.append(customInput);
    if (q.isOther !== false || !opts.length) optsBox.append(customRow);
    if (!q.isSecret && !m.agentLabel) {
      const tools = el("div", "askp-image-tools");
      const add = el("button", "askp-add-image", "添加图片") as HTMLButtonElement;
      add.title = "为这道题添加图片，也可粘贴或拖入；最多 10 张，单张 10 MB，总量 20 MB";
      const picker = el("input", "hidden") as HTMLInputElement;
      picker.type = "file"; picker.accept = QUESTION_IMAGE_TYPES.join(","); picker.multiple = true;
      const qi = cur;
      add.onclick = () => picker.click();
      picker.onchange = () => { void addPictures(Array.from(picker.files ?? []), qi); picker.value = ""; };
      tools.append(add, el("span", "askp-image-hint", "可粘贴或拖入图片"), picker);
      optsBox.append(tools);
      const previews = el("div", "askp-images");
      pictures[cur].forEach((picture, index) => {
        const uri = `data:${picture.mediaType};base64,${picture.data}`;
        const preview = el("div", "img-preview"), img = el("img") as HTMLImageElement;
        img.src = uri; img.alt = `问题 ${qi + 1} 的图片 ${index + 1}`; img.onclick = () => openLightbox(uri);
        const remove = el("button", "img-preview-x", "×") as HTMLButtonElement;
        remove.setAttribute("aria-label", `移除图片 ${index + 1}`);
        remove.onclick = () => { pictures[qi].splice(index, 1); paint(); };
        preview.append(img, remove); previews.append(preview);
      });
      optsBox.append(previews);
    }
    requestAnimationFrame(growCustom); // 首次 paint 时节点还没入文档，量高要等挂载
    updateFoot();
  }

  const finish = (answers: Record<string, string | string[]> | null) => {
    if (done) return;
    done = true;
    questionInteractions.delete(m.requestId);
    if (answers) {
      const pairs = questions
        .map((q): [string, string] => {
          const v = answers[q.id || q.question];
          return [q.header || q.question, q.isSecret && v ? "（已填写）" : Array.isArray(v) ? v.join("、") : v || ""];
        })
        .filter(([, a]) => a);
      const answered = askQuestionNode(pairs);
      if (m.agentLabel) answered.querySelector(".tool-name")!.textContent = `AskUserQuestion · ${m.agentLabel}`;
      const attachments = pictures.flat();
      if (attachments.length) {
        const grid = el("div", "msg-images");
        attachments.forEach(image => grid.append(makeImageChip(`data:${image.mediaType};base64,${image.data}`)));
        answered.querySelector(".askq-card")!.append(grid);
      }
      answered.querySelector<HTMLElement>(".askq-card")!.dataset.requestId = m.requestId;
      wrap.replaceWith(answered);
    } else {
      wrap.replaceWith(askQuestionNode([], "已停止"));
    }
  };

  prev.onclick = () => {
    if (cur > 0) {
      cur--;
      paint();
    }
  };
  next.onclick = () => {
    if (cur < questions.length - 1) {
      cur++;
      paint();
    }
  };
  submit.onclick = () => {
    if (done || submitting || readingImages || !questions.every((_, qi) => answered(qi))) return;
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, qi) => {
      const picks = [...sel[qi]];
      if (custom[qi].trim()) picks.push(custom[qi].trim());
      if (!picks.length && pictures[qi].length) picks.push(QUESTION_IMAGE_ANSWER);
      answers[q.id || q.question] = q.multiSelect ? picks : picks[0] || "";
    });
    submitting = true;
    submittedAnswers = answers;
    submitError.classList.add("hidden");
    wrap.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("button, input, textarea").forEach(control => control.disabled = true);
    submit.textContent = "提交中…";
    const images = imagePayload();
    send({ type: "answerQuestion", requestId: m.requestId, answers, ...(Object.keys(images).length ? { images } : {}) });
  };
  xBtn.onclick = () => {
    stopPending = true;
    waitingQuestionId = undefined;
    refreshComposerHint();
    send({ type: "interrupt" });
    finish(null);
  };
  questionInteractions.set(m.requestId, {
    resolve: behavior => {
      if (behavior === "allow") finish(submittedAnswers ?? null);
      else { done = true; questionInteractions.delete(m.requestId); }
    },
    retry: message => {
      if (done) return;
      submitting = false;
      submittedAnswers = undefined;
      xBtn.disabled = false;
      submit.textContent = "提交";
      paint();
      submitError.textContent = message;
      submitError.classList.remove("hidden");
    },
  });

  paint();
  // The picker is a step on the timeline like any other tool — blue node
  // (waiting on a *choice*, distinct from the amber permission wait).
  const step = el("div", "step ask");
  step.append(el("div", "step-dot"), wrap);
  body.append(step);
  markIfFirstNode(body, step);
  maybeScroll();
}

function resolvePermission(requestId: string, behavior: "allow" | "deny") {
  questionInteractions.get(requestId)?.resolve(behavior);
  const ask = Array.from(messagesEl.querySelectorAll<HTMLElement>(".askp")).find(node => node.dataset.requestId === requestId);
  if (ask && behavior === "deny") {
    ask.classList.add("interaction-cancelled");
    ask.querySelectorAll("button, input, textarea").forEach(control => ((control as HTMLButtonElement | HTMLTextAreaElement).disabled = true));
  }
  const bar = messagesEl.querySelector(`.perm-bar[data-request-id="${requestId}"]`) as HTMLElement;
  if (!bar) return;
  const group = bar.closest<HTMLElement>(".tool-group-step");
  bar.closest(".tool-card")?.classList.remove("needs-approval");
  bar.closest(".step")?.classList.remove("needs-approval");
  if (behavior === "allow") {
    bar.remove(); // authorized — just proceed, no result shown
  } else {
    bar.classList.add("resolved");
    bar.innerHTML = `<span class="perm-label deny">已拒绝</span>`;
  }
  if (group) updateToolGroup(group);
}

// ---------------------------------------------------------------------------
// History / sessions / checkpoints
// ---------------------------------------------------------------------------
const HISTORY_TURN_LIMIT = 20; // 打开会话默认只渲染最近 20 轮，更早的折进「加载更多」
const HISTORY_CHUNK = 30; // 「加载更多」每次只向上渲染 30 轮——一次全展开几百轮会把主线程卡死
let historyState: { items: TimelineItem[]; checkpoints: { id: string; label: string; userText?: string }[] } | null = null;

function loadHistory(items: TimelineItem[], checkpoints?: { id: string; label: string; userText?: string }[], sessionId?: string) {
  hideSpeedFeedback();
  hideSpeedTip();
  questionInteractions.clear();
  childQuestionIds.clear();
  waitingQuestionId = undefined;
  turnHasReply = false;
  historyState = { items, checkpoints: checkpoints || [] };
  seedInputHistory(items); // ↑ 能调回本会话之前发过的消息
  // 空历史也必须解除旧绑定，避免 /clear 或还原到开头后重载又复活旧会话。
  vscode.setState({ sessionId });
  // 整页重载是从 transcript 权威重建，绝不能带出合成标记：还原过渡那几秒里用
  // 户若又点了停止，残留的 userStopped 会让 renderHistory 收尾的 finalizeTurn
  // 给最后一轮错盖「[Request interrupted by user]」。
  userStopped = false;
  hideRestoring(); // 还原完成：新历史到了，遮罩撤掉
  // 中途还原会把进程直接杀掉，收尾事件（result/compacted）永远不会来——宿主已
  // 补过 busy:false 的话，这里还挂着的「运行中/等待授权」光圈和压缩转圈全是
  // 残留，一并收掉。done/error 的呼吸光圈是未读标记，保留；正常打开会话时本就
  // idle，这几行是空操作；编辑重发流程 webview 先置忙（isBusy=true），不受影响。
  if (!isBusy) {
    if (glowState === "running" || glowState === "waiting") setGlow("idle");
    if (compacting) {
      compacting = false;
      ctxGauge.classList.remove("compacting");
    }
  }
  renderHistory(false);
}

function renderHistory(showAll: boolean) {
  if (!historyState) return;
  const { items, checkpoints } = historyState;
  messagesEl.innerHTML = "";
  toolCards.clear();
  pruneRailObservers();
  cancelLiveRender();
  assistantEl = null;
  liveBlock = null;
  lastUserEl = null;
  userMsgCount = 0;
  ctxGauge.classList.add("hidden"); // refreshes from the next turn's usage

  // Align checkpoints to the user turns they actually belong to.
  //
  // 这里以前是**猜**的：假设「N 个还原点 == 最后 N 条提问」（ordinal =
  // userTotal - checkpoints.length + j）。跨天的长会话里还原点多是早期的
  // （老的被 MAX_CHECKPOINTS 裁掉、或中途才开始记录），这个假设一旦不成立，
  // 靠后的「还原到此处」就挂到了早期还原点上——点下去按它的 truncateLine 把
  // 几千行 transcript 截成几行，整段上下文（连同官方插件里的记录）当场报废。
  // 实测数据：某 5260 行会话的第 2 个还原点 truncateLine=8。
  //
  // 改为按身份匹配：还原点存了发起它的那条提问原文（userText），顺序扫描用户
  // 消息找同文本的那条。匹配不上的还原点宁可不画分割线，也绝不错位。
  const userTexts: string[] = [];
  for (const it of items) if (it.type === "user") userTexts.push((it.text || "").trim());
  const userTotal = userTexts.length;
  const cpByOrdinal = new Map<number, { id: string; synthetic?: boolean }>();
  {
    let from = 0; // 单调向前扫，保证还原点之间的相对顺序不被打乱
    for (const c of checkpoints) {
      const want = (c.userText || "").trim();
      if (!want) continue;
      let hit = -1;
      for (let k = from; k < userTotal; k++) {
        if (userTexts[k] === want) { hit = k; break; }
      }
      if (hit < 0) continue; // 对不上就不画，避免错位还原
      cpByOrdinal.set(hit, c);
      from = hit + 1;
    }
  }

  // Long transcripts: render ONLY the last HISTORY_TURN_LIMIT turns now; older
  // items render lazily when the banner is clicked. Rendering everything up
  // front (markdown + highlight on thousands of hidden nodes) made big sessions
  // take seconds to open with the UI frozen.
  let cutoff = 0;
  if (!showAll && userTotal > HISTORY_TURN_LIMIT) {
    const target = userTotal - HISTORY_TURN_LIMIT; // fold this many user turns
    let seen = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type === "user") {
        if (seen === target) {
          cutoff = i;
          break;
        }
        seen++;
      }
    }
    messagesEl.appendChild(makeExpandBanner(cutoff, cpByOrdinal));
  }

  renderItemRange(items, cutoff, items.length, cpByOrdinal);
  finalizeTurn();
  updateEmptyState();
  scrollToBottom();
}

/** 折叠横幅：不显示总数，点击每次只加载 HISTORY_CHUNK 轮。cutoff 是当前已渲染
 *  区间的起点（items 下标，落在某条 user 上）。 */
function makeExpandBanner(cutoff: number, cpByOrdinal: Map<number, { id: string; synthetic?: boolean }>): HTMLElement {
  const banner = el("div", "history-expand", "▾ 加载更多消息");
  banner.onclick = () => {
    // 渲染几十轮（markdown+高亮）仍会卡主线程几百毫秒，点击后毫无反应像没点中。
    // 先把横幅原地变成加载态，rAF（本帧提交）+setTimeout（落到绘制之后）保证
    // 加载态真正画出来才开始重活；onclick 置空防连点重入。
    banner.onclick = null;
    banner.classList.add("loading");
    banner.innerHTML = `<span class="hx-spin"></span>正在加载…`;
    requestAnimationFrame(() =>
      setTimeout(() => {
        // 等待的这一帧里整页可能已重载（还原点回退/看门狗重建），横幅不在树上
        // 说明列表已是新的，此次展开作废。
        if (banner.isConnected) expandHistory(banner, cutoff, cpByOrdinal);
      }, 0),
    );
  };
  return banner;
}

/** Render the next chunk of the folded (older) portion in place of the banner.
 *  The recent/live DOM is detached into a fragment first — the append-style
 *  render helpers and their finalize sweeps then can't touch it — and
 *  re-attached afterwards. 只渲染紧邻的 HISTORY_CHUNK 轮，再往前的折进新横幅。 */
function expandHistory(banner: HTMLElement, cutoff: number, cpByOrdinal: Map<number, { id: string; synthetic?: boolean }>) {
  if (!historyState) return;
  const items = historyState.items;
  // 本次只渲染 [from, cutoff)：cutoff 之前最近的 HISTORY_CHUNK 条 user 轮。
  let from = 0;
  {
    const userIdx: number[] = [];
    for (let i = 0; i < cutoff; i++) if (items[i].type === "user") userIdx.push(i);
    if (userIdx.length > HISTORY_CHUNK) from = userIdx[userIdx.length - HISTORY_CHUNK];
  }
  // The viewport must not MOVE: whatever the user was looking at stays put and
  // the older turns materialize above it. Capture the anchor's on-screen Y
  // BEFORE any DOM change, then correct scrollTop by the drift — and repeat on
  // the next frames, because the freshly rendered old messages fold themselves
  // (user-fold, code collapse) a frame later and shift heights again. A single
  // scrollIntoView here was exactly the "expand jumps somewhere else" bug.
  const anchorEl = banner.nextElementSibling as HTMLElement | null;
  const keepY = anchorEl ? anchorEl.getBoundingClientRect().top : 0;
  banner.remove();
  const savedAssistant = assistantEl, savedLive = liveBlock, savedLastUser = lastUserEl;
  const tail = document.createDocumentFragment();
  while (messagesEl.firstChild) tail.appendChild(messagesEl.firstChild);
  assistantEl = null;
  liveBlock = null;
  lastUserEl = null;
  if (from > 0) messagesEl.appendChild(makeExpandBanner(from, cpByOrdinal)); // 还有更早的：横幅留在最上面
  renderItemRange(items, from, cutoff, cpByOrdinal);
  finalizeTurn();
  assistantEl = savedAssistant;
  liveBlock = savedLive;
  lastUserEl = savedLastUser;
  messagesEl.appendChild(tail);
  userMsgCount = messagesEl.querySelectorAll(".msg.user").length;
  if (anchorEl) {
    pinnedToBottom = false; // expanding is an upward read — nothing may snap to bottom
    const fix = () => {
      const d = anchorEl.getBoundingClientRect().top - keepY;
      if (d !== 0) messagesEl.scrollTop += d;
      updateJumpLatest();
    };
    fix();
    requestAnimationFrame(() => {
      fix();
      requestAnimationFrame(fix);
    });
    setTimeout(fix, 140); // late reflows: image loads, rail observers
  }
}

/** Append items[from..to) to messagesEl. Checkpoint ordinals stay correct for
 *  any sub-range because user turns are counted from the start of `items`. */
function renderItemRange(items: TimelineItem[], from: number, to: number, cpByOrdinal: Map<number, { id: string; synthetic?: boolean }>) {
  let userOrdinal = -1;
  for (let i = 0; i < from; i++) if (items[i].type === "user") userOrdinal++;
  for (let i = from; i < to; i++) {
    const it = items[i];
    if (it.type === "user") {
      userOrdinal++;
      finalizeTurn();
      const cp = cpByOrdinal.get(userOrdinal);
      if (cp) messagesEl.appendChild(renderCheckpointDivider(cp.id, cp.synthetic, userOrdinal > 0)); // 第一条前也画：还原到它之前 = 清空对话重来
      const m = appendUser(it.text, it.files || [], it.images || [], false);
      if (cp) m.dataset.checkpointId = cp.id; // link message -> checkpoint (for edit)
      const answerCard = m.querySelector<HTMLElement>(".askq-card");
      if (cp && answerCard) attachReanswer(answerCard, cp.id);
    } else if (it.type === "image") {
      const body = ensureAssistant();
      const grid = el("div", "msg-images");
      grid.appendChild(makeThumb(it.src));
      body.appendChild(grid);
    } else if (it.type === "assistant_text") {
      const body = ensureAssistant();
      const seg = el("div", "md text-seg");
      seg.innerHTML = mdFull.render(foldLeakedToolXml(it.text));
      linkifyRefs(seg);
      hydrateLocalImages(seg);
      body.appendChild(seg);
    } else if (it.type === "thinking") {
      // 思考内容仍保留在历史数据中，不占聊天可视区域。
      continue;
    } else if (it.type === "compaction") {
      finalizeTurn();
      messagesEl.appendChild(renderCompactionDivider(it.preTokens, it.postTokens));
    } else if (it.type === "tool") {
      if (it.name === "AskUserQuestion") {
        // 插件把回答保存为下一轮的用户消息；由那条消息画完整回答卡，避免重复。
        const nextUser = items.slice(i + 1).find(item => item.type === "user");
        const replies = nextUser?.type === "user" ? parseQuestionReply(nextUser.text) : undefined;
        const questions = it.input?.questions;
        if (Array.isArray(questions) && replies?.length === questions.length && questions.every((q, index) => q.question === replies[index].question)) continue;
        if (it.isError) {
          // The call itself failed (e.g. unparsable JSON): show it as a normal
          // error step — red node, title, collapsible error output — instead of
          // dumping the raw <tool_use_error> text into an "answered" card.
          const body = ensureAssistant();
          createToolCard(body, it.toolId, it.name);
          if (it.result != null) setToolResult(it.toolId, it.result, true);
          continue;
        }
        // Show the answered question as a clean titled card (not the raw output).
        renderAnsweredQuestion(ensureAssistant(), typeof it.result === "string" ? it.result : "");
        continue;
      }
      const body = ensureAssistant();
      createToolCard(body, it.toolId, it.name);
      if (it.input) updateToolInput(it.toolId, it.name, it.input);
      if (it.result != null) setToolResult(it.toolId, it.result, !!it.isError);
    }
  }
}

/** Show a branded placeholder when the conversation is empty (new session). */
function updateEmptyState() {
  if (messagesEl.querySelector(".msg")) {
    messagesEl.querySelector(".empty-state")?.remove();
    return;
  }
  if (messagesEl.querySelector(".empty-state")) return;
  const es = el("div", "empty-state");
  es.innerHTML =
    `<div class="es-logo">${GPT_LOGO}</div>` +
    `<div class="es-title">Codex Copilot</div>` +
    `<div class="es-sub">问我任何关于这个项目的问题。<br>在根目录放一个 <code>AGENTS.md</code>，作为 Codex 的项目说明。</div>`;
  messagesEl.appendChild(es);
}

// -- Clickable code references in assistant text ------------------------------
// Turn file-path mentions (e.g. `src/foo.ts:42`) into links that jump to the
// file (and line) in the editor, reusing the messages' data-action="open" path.
const FILE_EXT = new Set([
  "ts","tsx","js","jsx","mjs","cjs","vue","svelte","java","kt","kts","py","go","rs","rb","php","cs",
  "cpp","cc","cxx","c","h","hpp","hh","m","mm","swift","scala","dart","lua","r","sh","bash","zsh",
  "html","htm","css","scss","sass","less","json","jsonc","xml","yaml","yml","toml","ini","env",
  "properties","gradle","sql","md","mdx","txt","proto","tf","vy","sol",
  "png","jpg","jpeg","gif","webp","avif","bmp","ico","tif","tiff","svg","pdf","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp",
]);

function parseCodeRef(s: string): { path: string; line?: number; endLine?: number } | null {
  const ref = parseFileRef(s);
  const m = /^([~\w./\\@\-+ ()]+\.[A-Za-z0-9]{1,10})$/.exec(ref.path);
  if (!m) return null;
  const ext = (m[1].split(".").pop() || "").toLowerCase();
  if (!FILE_EXT.has(ext)) return null;
  return ref;
}

const REF_RE =
  /\/?(?:[~\w.\-@+]+[/\\])+[\w.\-@+]*\.[A-Za-z0-9]{1,10}(?::\d+(?:[:-]\d+)?)?|[\w.\-@+]+\.[A-Za-z0-9]{1,10}:\d+(?:[:-]\d+)?/g;

function makeRef(text: string, ref: { path: string; line?: number; endLine?: number }): HTMLElement {
  const span = document.createElement("span");
  span.className = "code-ref";
  span.dataset.action = "open";
  span.dataset.path = ref.path;
  if (ref.line) span.dataset.line = String(ref.line);
  if (ref.endLine) span.dataset.endline = String(ref.endLine);
  span.textContent = text;
  span.title = "打开 " + ref.path + (ref.line ? `:${ref.line}` : "");
  return span;
}

// Common keywords / JDK types we don't want to turn into "go to symbol" links.
const SYM_STOP = new Set([
  "String","Integer","Long","Double","Float","Boolean","Object","Number","Character","Byte","Short",
  "List","Map","Set","Collection","Optional","Exception","RuntimeException","Throwable","System",
  "Override","Deprecated","NotNull","Nullable","Autowired","Resource","Override","Math","Arrays",
  "Collections","Objects","Thread","Runnable","Comparable","Iterable","Class","Void","TODO","FIXME",
]);

/** A single CamelCase/PascalCase identifier looks like a jump-able symbol. */
function symbolName(s: string): string | null {
  const t = s.trim();
  if (!/^@?[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) return null;
  const id = t.replace(/^@/, "");
  if (id.length < 3 || !/[A-Z]/.test(id) || SYM_STOP.has(id)) return null; // skip keywords/vars like log, null, int
  return id;
}

const localImageCache = new Map<string, string | null>();
const localImagePending = new Set<string>();

function showLocalImage(img: HTMLImageElement, dataUri?: string) {
  const placeholder = img.previousElementSibling;
  const label = img.alt || img.dataset.localSrc || "图片";
  if (!dataUri) {
    const failed = el("span", "local-image-failed", `图片无法加载：${label}`);
    img.replaceWith(failed);
    if (placeholder?.classList.contains("local-image-placeholder")) placeholder.remove();
    return;
  }
  img.onload = () => {
    img.classList.remove("local-image-pending");
    if (placeholder?.classList.contains("local-image-placeholder")) placeholder.remove();
  };
  img.onerror = () => showLocalImage(img);
  img.src = dataUri;
}

/** Webview 不能直接读取工作区外的 /tmp 等路径，由扩展宿主传回 data URI。 */
function hydrateLocalImages(container: HTMLElement) {
  container.querySelectorAll<HTMLImageElement>("img[src]").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (/^(https?:|data:)/i.test(src)) return;
    if (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^file:\/\//i.test(src)) return;
    let imagePath = src;
    if (!/^file:/i.test(src)) {
      try { imagePath = decodeURIComponent(src); } catch { /* 保留原路径 */ }
    }
    img.dataset.localSrc = imagePath;
    img.removeAttribute("src");
    img.classList.add("local-image-pending");
    img.before(el("span", "local-image-placeholder", `加载图片：${img.alt || imagePath}`));
    const cached = localImageCache.get(imagePath);
    if (cached !== undefined) showLocalImage(img, cached ?? undefined);
    else if (!localImagePending.has(imagePath)) {
      localImagePending.add(imagePath);
      send({ type: "loadLocalImage", path: imagePath });
    }
  });
}

/** Make file references inside rendered assistant markdown clickable. */
function linkifyRefs(container: HTMLElement, validate = true) {
  // 0) AI 常输出 markdown 文件链接（[router:651](src/router/index.js#L651)）。
  //    <a> 渲染出来点击本来就无人处理 = 永远的死链接。统一转成文件引用并走
  //    存在性校验：真实存在 → 可点击打开；不存在 → 退化成纯文本（宁可没有
  //    链接，也不给点不动的链接）。网页和邮件链接由点击事件交给扩展宿主。
  container.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href") || "";
    const ref = parseFileRef(href);
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(ref.path)?.[1].toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto") return;
    const span = document.createElement("span");
    span.textContent = a.textContent || href;
    if (ref.path && !/[#?]/.test(ref.path) && (!scheme || scheme === "file")) {
      // 非法百分号序列（如 caf%E9.md）会让 decodeURIComponent 抛 URIError——
      // 这里一炸，整段历史/流式渲染就断了，会话永久打不开。原样保留即可。
      let decoded = ref.path;
      if (!/^file:/i.test(decoded)) {
        try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
      }
      span.className = "code-ref";
      span.dataset.action = "open";
      span.dataset.path = decoded;
      if (ref.line) span.dataset.line = String(ref.line);
      if (ref.endLine) span.dataset.endline = String(ref.endLine);
      span.title = "打开 " + decoded + (ref.line ? `:${ref.line}` : "");
    }
    a.replaceWith(span);
  });
  // 1) Inline code spans: a file path -> open file; a symbol -> go to definition.
  container.querySelectorAll("code").forEach((code) => {
    if (code.closest("pre") || code.children.length) return;
    const txt = code.textContent || "";
    const ref = parseCodeRef(txt);
    if (ref) {
      code.classList.add("code-ref");
      code.setAttribute("data-action", "open");
      code.setAttribute("data-path", ref.path);
      if (ref.line) code.setAttribute("data-line", String(ref.line));
      if (ref.endLine) code.setAttribute("data-endline", String(ref.endLine));
      (code as HTMLElement).title = "打开 " + ref.path + (ref.line ? `:${ref.line}` : "");
      return;
    }
    const sym = symbolName(txt);
    if (sym) {
      code.classList.add("code-ref");
      code.setAttribute("data-action", "symbol");
      code.setAttribute("data-symbol", sym);
      (code as HTMLElement).title = "跳转到定义：" + sym;
    }
  });
  // 2) Bare path mentions in plain prose (must have a / separator or :line).
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || p.closest("a, code, pre, .code-ref")) return NodeFilter.FILTER_REJECT;
      REF_RE.lastIndex = 0;
      return REF_RE.test(n.nodeValue || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) targets.push(node as Text);
  for (const tn of targets) {
    const text = tn.nodeValue || "";
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(text))) {
      const ref = parseCodeRef(m[0]);
      if (!ref) continue; // matched something path-like but not a known code file
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(makeRef(m[0], ref));
      last = m.index + m[0].length;
    }
    if (!frag.childNodes.length) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    tn.replaceWith(frag);
  }
  // 3) Verify file refs actually exist — non-existent ones get unlinked so we
  //    don't show dead "jump to file" links.
  const fileRefs = container.querySelectorAll<HTMLElement>('.code-ref[data-action="open"]:not([data-ref-id])');
  if (validate && fileRefs.length) {
    const refs: { id: string; path: string }[] = [];
    fileRefs.forEach((e) => {
      const id = "ref" + refSeq++;
      e.dataset.refId = id;
      refs.push({ id, path: e.dataset.path || "" });
    });
    send({ type: "validateRefs", refs });
  }
  // 4) 符号引用同样要校验——`@RateLimit` 这类项目里根本不存在的注解以前也会被
  //    加上链接，点了没反应。LSP 索引里查不到的就剥掉链接（宁缺毋滥）。
  const symRefs = container.querySelectorAll<HTMLElement>('.code-ref[data-action="symbol"]:not([data-ref-id])');
  if (validate && symRefs.length) {
    const syms: { id: string; name: string }[] = [];
    symRefs.forEach((e) => {
      const id = "ref" + refSeq++;
      e.dataset.refId = id;
      syms.push({ id, name: e.dataset.symbol || "" });
    });
    send({ type: "validateSymbols", syms });
  }
}

let refSeq = 0;
/** Strip the clickable-link affordance from a ref element (keeps plain text/code). */
function unlinkRef(e: HTMLElement) {
  e.classList.remove("code-ref");
  for (const a of ["action", "path", "line", "endline", "symbol", "refId"]) delete e.dataset[a];
  e.removeAttribute("title");
}

function renderChangedFiles(
  files: ChangedFile[],
  totalAdded: number,
  totalRemoved: number,
) {
  if (!files.length) {
    changedFiles.classList.add("hidden");
    cfList.innerHTML = "";
    return;
  }
  // 从「无改动」到「有改动」的首次出现按默认折叠展示（点开与否由用户决定，
  // 本轮内的后续刷新不再动它）。
  if (changedFiles.classList.contains("hidden")) changedFiles.classList.add("collapsed");
  changedFiles.classList.remove("hidden");
  // Header totals: the panel knew the numbers all along but only ever showed
  // the two bulk buttons, so "how big is this change" meant expanding the list.
  cfCount.textContent = `${files.length} 个`;
  cfStat.innerHTML =
    `<span class="cf-total"><span class="add">+${totalAdded}</span> <span class="del">−${totalRemoved}</span></span>` +
    `<span class="cf-sep"></span>` +
    `<button class="cf-all accept" data-cf="acceptAll" title="同意全部改动（保留）">保留全部</button>` +
    `<button class="cf-all revert" data-cf="revertAll" title="回滚全部改动">回滚</button>`;
  cfList.innerHTML = "";
  for (const f of files) {
    const row = el("div", "cf-row");
    const badge = el("span", `cf-badge ${f.status}`, f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M");
    const slash = f.rel.lastIndexOf("/");
    const name = el("span", "cf-name", slash >= 0 ? f.rel.slice(slash + 1) : f.rel);
    const dir = el("span", "cf-dir", slash >= 0 ? f.rel.slice(0, slash) : "");
    const stat = el("span", "cf-rowstat");
    if (f.diffUnavailable) {
      stat.textContent = f.diffUnavailable === "large" ? "大文件" : "二进制";
      stat.title = "未统计文本行数；仍可保留或回滚此文件";
    } else stat.innerHTML = `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`;
    const acc = el("button", "cf-act accept", "✓");
    acc.title = "同意（保留改动）";
    acc.onclick = (e) => {
      e.stopPropagation();
      send({ type: "acceptFile", path: f.path });
    };
    const rev = el("button", "cf-act revert", "↩");
    rev.title = "回滚（恢复改动前）";
    rev.onclick = (e) => {
      e.stopPropagation();
      send({ type: "revertFile", path: f.path });
    };
    row.append(badge, name, dir, stat, acc, rev);
    row.title = `${f.rel} — 点击查看改动`;
    row.onclick = () => send({ type: "openDiff", path: f.path });
    cfList.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Inline restore points (checkpoint dividers in the conversation stream)
// ---------------------------------------------------------------------------
function renderCheckpointDivider(checkpointId: string, synthetic?: boolean, canFork = true): HTMLElement {
  const d = el("div", "checkpoint-divider");
  d.dataset.checkpointId = checkpointId;
  // A single, always-present control — hovering only restyles it (no extra
  // element appears), so the row never reflows / flickers.
  const btn = el("button", "cp-restore");
  btn.textContent = "还原到此处";
  // 合成还原点：该轮不是从本插件发出（官方插件/其它窗口），没有文件快照，只回退对话。
  btn.title = synthetic ? "还原到此处（该轮无文件快照：只回退对话，不回滚文件）" : "还原到此检查点（恢复改动前）";
  // Confirmation is shown by the extension (native modal); we just request it.
  btn.onclick = () => send({ type: "restoreCheckpoint", checkpointId });
  // 从此处派生新会话（对齐官方 "Fork conversation from here"）：复制该点之前
  // 的对话开新标签页，当前会话不动——想「两条路都试试」时用它而不是还原。
  const fork = el("button", "cp-fork") as HTMLButtonElement;
  fork.innerHTML = ICON.fork;
  fork.title = "从此处派生新会话（新标签页打开，当前会话不受影响）";
  fork.disabled = !!forkingCheckpoint;
  fork.onclick = (e) => {
    e.stopPropagation();
    if (forkingCheckpoint) return;
    showForking(checkpointId, "等待确认派生…");
    send({ type: "forkCheckpoint", checkpointId });
  };
  d.append(btn);
  if (canFork) d.append(fork);
  return d;
}

// 派生有独立进度，不改变原会话的运行、等待问题或消息排队状态。
let forkingCheckpoint: string | undefined;
function showForking(checkpointId: string, label = "正在派生新会话…") {
  forkingCheckpoint = checkpointId;
  messagesEl.querySelectorAll<HTMLButtonElement>(".cp-fork").forEach(button => { button.disabled = true; });
  let progress = document.querySelector<HTMLElement>(".fork-progress");
  if (!progress) {
    progress = el("div", "fork-progress");
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-live", "polite");
    progress.append(el("span", "hx-spin"), el("span", "fork-progress-label"));
    document.body.appendChild(progress);
  }
  progress.querySelector(".fork-progress-label")!.textContent = label;
}
function hideForking() {
  forkingCheckpoint = undefined;
  document.querySelector(".fork-progress")?.remove();
  messagesEl.querySelectorAll<HTMLButtonElement>(".cp-fork").forEach(button => { button.disabled = false; });
}

/** A divider marking where the conversation was compacted (/compact). */
function renderCompactionDivider(preTokens: number, postTokens: number): HTMLElement {
  const d = el("div", "compaction-divider");
  const saved = preTokens > 0 ? `${fmtTokens(preTokens)} → ${fmtTokens(postTokens)}` : "";
  d.append(el("span", "cp-icon", "⟱"), document.createTextNode(saved ? ` 上下文已压缩 ${saved}` : " 上下文已压缩"));
  return d;
}

/** Live: a restore point was created for the turn just sent. */
function onCheckpointMarker(checkpointId: string) {
  if (lastUserEl) lastUserEl.dataset.checkpointId = checkpointId; // link message -> its checkpoint (for edit)
  if (!lastUserEl) return;
  messagesEl.insertBefore(renderCheckpointDivider(checkpointId, undefined, userMsgCount > 1), lastUserEl); // 第一条前也画：还原到它之前 = 清空对话重来
  maybeScroll();
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
interface QueueItem {
  queuedAt?: number;
  text: string;
  context?: string;
  contexts: { label: string; text: string }[];
  images: { mediaType: string; data: string }[];
  files: string[];
  labels: string[];
  imageUris: string[];
}
const taskQueue: QueueItem[] = [];
const taskQueueEl = $("task-queue");

/** Snapshot the composer into a sendable payload (null if nothing to send). */
function readComposer(): QueueItem | null {
  const text = inputEl.value;
  if (!text.trim() && !pendingImages.length) return null;
  return {
    text,
    context: pendingContexts.map((c) => c.text).join("\n\n") || undefined,
    contexts: pendingContexts.map((c) => ({ ...c })),
    images: pendingImages.map((p) => ({ mediaType: p.mediaType, data: p.data })),
    files: attachedFiles.map((f) => f.path),
    labels: [...pendingContexts.map((c) => c.label), ...attachedFiles.map((f) => baseName(f.path))],
    imageUris: pendingImages.map((p) => p.uri),
  };
}

// ---- 输入历史：↑/↓ 把发过的消息调回输入框（shell 手感）------------------
// 两个调用点（斜杠命令、正常发送）都经 clearComposer，限额拦截那条不清空也就
// 不入历史——所以记录挂在 clearComposer 开头（此时 value 还在）。
const INPUT_HISTORY_MAX = 200;
const inputHistory: string[] = []; // 旧 → 新
let historyIdx = -1; // -1 = 没在浏览历史
let historyDraft = ""; // 进入浏览前输入框里没发出去的内容

function resetInputHistory() {
  historyIdx = -1;
  historyDraft = "";
}
/** 记一条历史；连续重复只留一条，超上限丢最旧的。 */
function pushInputHistory(text: string) {
  const t = text.trim();
  if (!t) return;
  if (inputHistory[inputHistory.length - 1] !== t) inputHistory.push(t);
  if (inputHistory.length > INPUT_HISTORY_MAX) inputHistory.shift();
  resetInputHistory();
}
/** 打开/切换会话时，用该会话已有的提问预填历史——刚打开就能按 ↑ 调回。 */
function seedInputHistory(items: TimelineItem[]) {
  inputHistory.length = 0;
  for (const it of items) {
    if (it.type !== "user") continue;
    const t = (it.text || "").trim();
    if (t && inputHistory[inputHistory.length - 1] !== t) inputHistory.push(t);
  }
  if (inputHistory.length > INPUT_HISTORY_MAX) inputHistory.splice(0, inputHistory.length - INPUT_HISTORY_MAX);
  resetInputHistory();
}
/** 程序化改写输入框：不触发 input 事件，所以要自己补 autoResize/草稿同步。 */
function setComposerText(t: string) {
  inputEl.value = t;
  autoResize();
  refreshComposerHint();
  send({ type: "draft", text: t }); // 看门狗重建时不丢
  inputEl.setSelectionRange(t.length, t.length); // 光标落末尾
  inputEl.scrollTop = inputEl.scrollHeight;
}
/** dir=-1 更旧(↑)，dir=+1 更新(↓)。返回 true 表示这次按键被历史吃掉了。 */
function recallHistory(dir: -1 | 1): boolean {
  if (!inputHistory.length) return false;
  if (historyIdx === -1) {
    if (dir === 1) return false; // 没在浏览时按 ↓ 不管
    historyDraft = inputEl.value; // 先存住没发出去的内容
    historyIdx = inputHistory.length - 1;
  } else {
    const next = historyIdx + dir;
    if (next < 0) return true; // 已到最旧，停住（别让光标乱跳）
    if (next >= inputHistory.length) {
      // 越过最新一条 → 把草稿还回来
      historyIdx = -1;
      const d = historyDraft;
      historyDraft = "";
      setComposerText(d);
      return true;
    }
    historyIdx = next;
  }
  setComposerText(inputHistory[historyIdx]);
  return true;
}

function clearComposer() {
  pushInputHistory(inputEl.value);
  inputEl.value = "";
  send({ type: "draft", text: "" }); // 已发送/清空——宿主侧草稿同步作废
  autoResize();
  clearContextChips();
  pendingImages.length = 0;
  imagePreviews.innerHTML = "";
  // Staged attachments are consumed by the message; keep only the default current file.
  attachedFiles = [];
  // NOTE: autoDismissed is deliberately NOT reset here — if the user removed
  // the auto-attached file chip, sending must not silently re-attach it.
  // It re-arms only when the active file changes (onActiveFile) or the user
  // re-adds the file manually (addFile).
  onActiveFile(autoPath);
  // 开着，后面每条消息都被悄悄塞进日志工具说明（用户以为只带了那一条）。
  refreshComposerHint();
}

// ---- 斜杠命令 -------------------------------------------------------------
// 只拦截下面这几条本地命令；其余以 / 开头的一律原样发给 CLI（它自己的 skills /
// slash command 才不会被我们吃掉）。
const COMMANDS: { name: string; args?: string; desc: string }[] = [
  { name: "/help", desc: "显示所有可用命令" },
  { name: "/clear", args: "[消息]", desc: "清空上下文：丢掉本轮之前的历史，用全新上下文回复（可直接带上要问的话）" },
  { name: "/compact", desc: "压缩上下文：把历史总结成摘要，保留要点但大幅缩小" },
  { name: "/model", args: "[名称]", desc: "切换模型，如 /model 模型ID；不带参数则列出可选" },
  { name: "/effort", args: "[档位]", desc: "切换思考强度，如 /effort high；不带参数则列出可选" },
  { name: "/usage", desc: "查看订阅用量及重置时间" },
];

function cmdHelp(): string {
  const rows = COMMANDS.map((c) => `  ${c.name}${c.args ? " " + c.args : ""}  —  ${c.desc}`);
  return "可用命令：\n" + rows.join("\n") + "\n\n（其它以 / 开头的内容会作为普通提示词发送给 Codex）";
}

function cmdUsage(): string {
  const d = lastUsageData;
  const plan = currentPlanName();
  const resetCards = availableResetCredits();
  const line = (label: string, pct?: number, reset?: string) =>
    typeof pct === "number" ? `  ${label}：${pct}%${reset ? " · " + reset : ""}` : `  ${label}：暂无数据`;
  return [
    `订阅用量${plan ? ` · ${plan}` : ""}：`,
    ...(typeof d.sessionPct === "number" ? [line("5 小时限额", d.sessionPct, cnReset(d.sessionResetAt))] : []),
    ...(typeof d.weekPct === "number" ? [line("每周限额", d.weekPct, cnReset(d.weekResetAt))] : []),
    ...(typeof d.weekModelPct === "number" ? [line(`每周 · 仅 ${d.weekModelName || "特定模型"}`, d.weekModelPct)] : []),
    ...(resetCards ? [`  重置卡：可用 ${resetCards.count} 张`,
      ...(resetCards.cards?.map((card, index) => `    ${card.title || `重置卡 ${index + 1}`}：${creditExpiry(card.expiresAt)}`) ?? []),
      ...(resetCards.count > (resetCards.cards?.length ?? 0) ? [`    另有 ${resetCards.count - (resetCards.cards?.length ?? 0)} 张未返回有效期`] : [])] : []),
  ].join("\n");
}

/** 处理本地斜杠命令。返回 true = 已消费，不再当普通消息发送。 */
function handleSlashCommand(payload: QueueItem): boolean {
  const t = payload.text.trim();
  if (!t.startsWith("/")) return false;
  const sp = t.search(/\s/);
  const cmd = (sp === -1 ? t : t.slice(0, sp)).toLowerCase();
  const arg = sp === -1 ? "" : t.slice(sp + 1).trim();
  const known = COMMANDS.some((c) => c.name === cmd);
  if (!known) return false; // 交给 CLI（它的 skills 等命令不能被我们吞掉）

  clearComposer();
  switch (cmd) {
    case "/help":
      appendNotice(cmdHelp(), "info");
      return true;
    case "/usage":
      appendNotice(cmdUsage(), "info");
      send({ type: "refreshUsage" }); // 顺手刷新，下次看就是新的
      return true;
    case "/compact":
      if (isBusy) { appendNotice("正在回复中，请等本轮结束再压缩。", "error"); return true; }
      send({ type: "compact" });
      return true;
    case "/model": {
      if (!arg) {
        appendNotice("可选模型：\n" + MODELS.map((m) => `  ${m.id || "(默认)"}  —  ${m.label}`).join("\n"), "info");
        return true;
      }
      const key = arg.toLowerCase();
      const choices = [MODELS[0], ...speedModels.map(m => ({ id: m.id, label: m.name }))];
      const hit = choices.find((m) => m.id.toLowerCase() === key || m.label.toLowerCase() === key || (!m.id && key === "默认"));
      if (!hit) {
        appendNotice(`未知模型「${arg}」。可选：${MODELS.map((m) => m.id || "默认").join(" / ")}`, "error");
        return true;
      }
      requestModelChange(hit.id);
      return true;
    }
    case "/effort": {
      if (!arg) {
        appendNotice("可选思考强度：\n" + [...availableEfforts(), EFFORTS.find(e => !e.id)!].map((e) => `  ${e.id || "default"}  —  ${e.label}：${e.desc}`).join("\n"), "info");
        return true;
      }
      const key = arg.toLowerCase();
      const hit = [...availableEfforts(), EFFORTS.find(e => !e.id)!].find((e) => e.id.toLowerCase() === key || e.label.toLowerCase() === key || (!e.id && key === "default"));
      if (!hit) {
        appendNotice(`未知强度「${arg}」。可选：${EFFORTS.map((e) => e.id).join(" / ")}`, "error");
        return true;
      }
      if (hit.id && modelEfforts[currentModel]?.length && !modelEfforts[currentModel].includes(hit.id)) {
        appendNotice(`当前模型不支持「${hit.label}」，请选择菜单中列出的强度。`, "error");
        return true;
      }
      requestEffortChange(hit.id);
      return true;
    }
    case "/clear": {
      if (isBusy) { appendNotice("正在回复中，请先停止本轮再清空上下文。", "error"); return true; }
      hideSpeedFeedback();
      hideSpeedTip();
      // 清空这个 tab 的时间线；host 会同时解绑会话、下次发送开全新上下文。
      messagesEl.innerHTML = "";
      pruneRailObservers();
      cancelLiveRender();
      historyState = null;
      lastUserEl = null;
      assistantEl = null;
      liveBlock = null;
      toolCards.clear();
      userMsgCount = 0;
      taskQueue.length = 0;
      renderQueue();
      appendNotice(arg ? "已清空上下文，用全新上下文回答这条消息。" : "已清空上下文，之后的对话不会带上之前的历史。", "info");
      if (arg) appendUser(arg, payload.labels, payload.imageUris);
      send({
        type: "newContext",
        text: arg || undefined,
        context: arg ? payload.context : undefined,
        images: arg ? payload.images : undefined,
        files: arg ? payload.files : undefined,
      });
      if (arg) {
        // 与 performSend 保持一致的忙碌态，否则界面不显示停止按钮/思考动画。
        turnTokens = 0; turnEst = 0; turnThinkTokens = 0; msgTokenBase = 0; lastMsgTokens = 0;
        resetTokenTween();
        isBusy = true;
        turnStartedAt = performance.now();
        setGlow("running");
        refreshComposerHint();
        showWorking();
      }
      return true;
    }
  }
  return false;
}

function doSend() {
  const payload = readComposer();
  if (!payload) return;
  if (handleSlashCommand(payload)) return;
  // Quota spent — bail BEFORE clearComposer() so the user doesn't lose what
  // they typed. The banner already explains why nothing happened.
  if (rateLimited) {
    // Nudge the banner into view. Guarded: an exception here would abort doSend.
    const b = messagesEl.querySelector(".rate-limit-banner.exhausted");
    if (b && typeof b.scrollIntoView === "function") b.scrollIntoView({ block: "nearest" });
    return;
  }
  clearComposer();
  if (isBusy || restoreInProgress) {
    // A turn is running — queue this one to auto-run after the current finishes.
    payload.queuedAt = performance.now();
    taskQueue.push(payload);
    renderQueue();
    return;
  }
  performSend(payload, true);
}

/** Actually start a turn from a payload (used for live sends and queued ones). */
function performSend(p: QueueItem, jumpToLatest: boolean) {
  queuePausedAfterRestore = false;
  turnHasReply = false;
  setGlow("running"); // immediate — don't wait for the host's busy event
  // NOTE: stoppingView is NOT cleared here. The stopped turn's deltas may still
  // be in flight; clearing the gate now would append them to this new bubble.
  // Only `setBusy(true)` — which the host always emits before the new turn's
  // first stream event — reopens rendering.
  appendUser(p.text, p.labels, p.imageUris, jumpToLatest);
  if (!jumpToLatest) maybeScroll();
  finalizeTurn();
  turnTokens = 0; // reset token counters for the new turn
  turnEst = 0;
  turnThinkTokens = 0;
  msgTokenBase = 0;
  lastMsgTokens = 0;
  resetTokenTween();
  isBusy = true;
  turnStartedAt = performance.now();
  refreshComposerHint(); // show the Stop button immediately (don't wait for the busy event)
  showWorking(); // instant feedback (the busy event confirms it a moment later)
  if (assistantEl) assistantEl.classList.add("streaming-turn");
  send({
    type: "send",
    text: p.text,
    queueMs: p.queuedAt === undefined ? undefined : Math.max(0, Math.round(performance.now() - p.queuedAt)),
    context: p.context,
    images: p.images.length ? p.images : undefined,
    files: p.files.length ? p.files : undefined,
  });
}

/** When the current turn ends, auto-run the next queued task (if any). */
function flushQueue() {
  // Runs after every turn ends — including one the user stopped. Stopping while
  // tasks are queued means "skip this reply, get on with my queue", so the queue
  // must keep draining. (An empty queue makes this a no-op anyway, which is what
  // a plain "I want it to stop" Stop looks like.)
  // 用量耗尽时按兵不动：不拦的话队列会绕过 doSend 的锁逐条穿墙，每条都变成
  // 失败轮次白白丢掉。额度恢复（clearRateLimit）后会重新放行。
  if (rateLimited || restoreInProgress || queuePausedAfterRestore) return;
  if (isBusy || !taskQueue.length) return;
  const next = taskQueue.shift()!;
  renderQueue();
  performSend(next, false);
}

/** Take a queued item back into the composer without flattening its newlines. */
function recallQueuedItem(item: QueueItem) {
  const draft = inputEl.value;
  setComposerText(draft && item.text ? `${item.text}\n\n${draft}` : item.text || draft);
  resetInputHistory();
  for (const ctx of item.contexts) addContextChip(ctx.label, ctx.text);
  for (let i = 0; i < item.images.length; i++) {
    const img = item.images[i];
    const uri = item.imageUris[i] || `data:${img.mediaType};base64,${img.data}`;
    pendingImages.push({ ...img, uri });
    addImagePreview(uri);
  }
  for (const path of item.files) addFile(path);
  refreshComposerHint();
  inputEl.focus();
}

function renderQueue() {
  if (!taskQueue.length) {
    taskQueueEl.classList.add("hidden");
    taskQueueEl.innerHTML = "";
    return;
  }
  taskQueueEl.classList.remove("hidden");
  taskQueueEl.innerHTML = "";
  const head = el("div", "tq-head", `排队中 · ${taskQueue.length}`);
  taskQueueEl.appendChild(head);
  taskQueue.forEach((item, i) => {
    const row = el("div", "tq-row");
    row.append(el("span", "tq-idx", String(i + 1)));
    if (item.images.length) {
      const previews = el("span", "tq-images");
      item.images.slice(0, 2).forEach((image, imageIndex) => {
        const src = item.imageUris[imageIndex] || `data:${image.mediaType};base64,${image.data}`;
        const button = el("button", "tq-image") as HTMLButtonElement;
        button.type = "button";
        button.title = `查看排队图片 ${imageIndex + 1} / ${item.images.length}`;
        button.setAttribute("aria-label", button.title);
        const thumbnail = el("img") as HTMLImageElement;
        thumbnail.src = src;
        thumbnail.alt = "";
        thumbnail.loading = "lazy";
        button.appendChild(thumbnail);
        button.onclick = () => openLightbox(src);
        previews.appendChild(button);
      });
      if (item.images.length > 2) {
        const extra = el("span", "tq-image-extra", `+${item.images.length - 2}`);
        extra.title = `另有 ${item.images.length - 2} 张图片，可撤回到输入框查看`;
        previews.appendChild(extra);
      }
      row.appendChild(previews);
    }
    const txt = el("span", "tq-text", item.text || "(图片)");
    txt.title = item.text;
    row.appendChild(txt);
    if (item.labels.length) row.appendChild(el("span", "tq-chips", item.labels.join(" · ")));
    const recall = el("button", "tq-recall");
    recall.innerHTML = ICON.undo;
    recall.title = "撤回到输入框编辑";
    recall.setAttribute("aria-label", recall.title);
    recall.onclick = () => {
      // Remove first, so a turn finishing during a focus/resize callback cannot send it.
      taskQueue.splice(i, 1);
      renderQueue();
      recallQueuedItem(item);
    };
    row.appendChild(recall);
    const del = el("button", "tq-del", "×");
    del.title = "从队列移除";
    del.setAttribute("aria-label", del.title);
    del.onclick = () => {
      taskQueue.splice(i, 1);
      renderQueue();
    };
    row.appendChild(del);
    taskQueueEl.appendChild(row);
  });
}

sendBtn.onclick = doSend;
let userStopped = false; // user hit Stop — append an interrupted marker on finalize
/** 还原过渡态的遮罩：消息区压暗 + 居中转圈药丸。停进程（忙时 1~5s）和派生复制
 *  transcript 的这几秒里，用户能看到「正在还原」而不是一片死寂。 */
/** 还原与重新生成共用同一套回退机制，但重新生成不弹居中遮罩、也不压暗消息区——
 *  它已经把重发的用户气泡和 Brewing 转圈显示出来了，遮罩纯属打扰。submitEdit 按
 *  动作设置，hideRestoring 复位。 */
let restoringRegen = false;
let restoreInProgress = false;
let queuePausedAfterRestore = false;
function showRestoring() {
  restoreInProgress = true;
  queuePausedAfterRestore = false;
  if (restoringRegen) return; // 重新生成：无遮罩、不压暗
  messagesEl.classList.add("restoring");
  if (document.querySelector(".restore-overlay")) return;
  const o = el("div", "restore-overlay");
  o.innerHTML = `<span class="hx-spin"></span>正在还原到此处…`;
  document.body.appendChild(o);
}
function hideRestoring() {
  restoreInProgress = false;
  messagesEl.classList.remove("restoring");
  document.querySelector(".restore-overlay")?.remove();
  restoringRegen = false;
  // busy:false 可能早于还原完成，此前的队列调度会因 restoreInProgress 被拦住。
  // 解除还原后重新检查；新轮次忙碌、等待问题或还原失败的暂停仍由 flushQueue 把关。
  if (taskQueue.length) setTimeout(flushQueue, 150);
}

/** 立刻把直播观感「停」下来：吞掉后续流事件、收起活动药丸和
 *  左侧进度脉冲。Stop 按钮与还原的自动停止（restoring）共用，观感必须一致。
 *  finalizeTurn 也会做后两样，但它要等宿主的 result 落地——那可能比点击晚好
 *  几秒，期间药丸/脉冲还在动会让用户以为没有停止。 */
function freezeLiveStream() {
  stoppingView = true;
  removeWorking();
  if (assistantEl) {
    assistantEl.classList.remove("streaming-turn");
    assistantEl.querySelector(".thread-active")?.remove();
  }
}
stopBtn.onclick = () => {
  userStopped = true;
  setGlow("idle"); // deliberate cancel — not a failure
  // Drop everything still in flight for this turn: deltas buffered in the pipe
  // (or a slow interrupt) would otherwise keep "typing" after the button
  // already flipped — the classic "stopped but still replying" bug.
  freezeLiveStream();
  // 停的可能是一次卡死的压缩：result 永远不会来，仪表盘转圈和只剩头像的空气泡
  // 不能等它收尾，这里直接清。有内容的气泡照旧等 result 盖「已中断」标记。
  if (compacting) {
    compacting = false;
    ctxGauge.classList.remove("compacting");
  }
  if (assistantEl && !assistantHasContent(assistantEl)) {
    assistantEl.remove();
    assistantEl = null;
  }
  // 显示立刻停止，但保留发送锁，直到宿主确认后台真正结束。
  stopPending = true;
  send({ type: "interrupt" });
  refreshComposerHint();
};
/** True from Stop-click until the next turn starts: render nothing new. */
let stoppingView = false;
/** 设置 codexChat.modEnterToSend：Cmd/Ctrl+Enter 发送、Enter 换行。宿主 config 下发。 */
let modEnterToSend = false;
// 草稿实时同步到宿主（节流 500ms）：webview 通道看门狗重建是整页重载，
// 不存宿主侧的话用户打了一半的长消息会瞬间消失。
let draftTimer = 0;
inputEl.addEventListener("input", () => {
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => send({ type: "draft", text: inputEl.value }), 500);
});

inputEl.addEventListener("keydown", (e) => {
  // Ignore Enter while an IME composition is active (e.g. confirming a pinyin
  // candidate) — `isComposing`/keyCode 229 means it's not a real "send".
  if (e.key === "Enter" && !e.isComposing && (e as KeyboardEvent).keyCode !== 229) {
    // 默认 Enter 发送 / ⇧Enter 换行；开了 modEnterToSend 就反过来：Cmd/Ctrl+Enter 发送、Enter 换行。
    const wantSend = modEnterToSend ? e.metaKey || e.ctrlKey : !e.shiftKey;
    if (wantSend) {
      e.preventDefault();
      doSend();
      return;
    }
  }
  // ↑/↓ 调回发过的消息。只在光标位于首行(↑)/末行(↓)且无选区时接管，否则多行
  // 消息里的上下移动光标就没法用了；带修饰键或输入法组字中一律放行。
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing) {
    if (inputEl.selectionStart !== inputEl.selectionEnd) return;
    const pos = inputEl.selectionStart ?? 0;
    const atEdge =
      e.key === "ArrowUp"
        ? !inputEl.value.slice(0, pos).includes("\n") // 首行
        : !inputEl.value.slice(pos).includes("\n"); // 末行
    if (!atEdge) return;
    if (recallHistory(e.key === "ArrowUp" ? -1 : 1)) e.preventDefault();
  }
});
inputEl.addEventListener("input", () => {
  autoResize();
  refreshComposerHint();
  resetInputHistory(); // 用户一动手就退出浏览态：下次 ↑ 从最新一条重新开始
});

/** While a turn is running, hint that typing + Enter queues the message; also
 *  toggle send/stop buttons accordingly. */
function refreshComposerHint() {
  const hasContent = inputEl.value.trim().length > 0 || pendingImages.length > 0;
  stopBtn.disabled = stopPending || turnFinalizing;
  // A permanently-filled send button next to an empty box is a call to action
  // with nothing behind it — keep it quiet until there is content.
  sendBtn.classList.toggle("ready", hasContent);
  if (rateLimited) {
    // Blocked: no send, no queue. Keep the text — the quota will come back.
    sendBtn.classList.add("hidden");
    stopBtn.classList.add("hidden");
    queueHint.classList.add("hidden");
    inputEl.placeholder = "用量已达上限,等待额度恢复后才能继续发送";
    return;
  }
  if (isBusy) {
    stopBtn.classList.remove("hidden");
    sendBtn.classList.toggle("hidden", !hasContent); // clickable "add to queue" when there's content
    sendBtn.title = "加入等待队列";
    inputEl.placeholder = turnFinalizing ? (userStopped ? "已停止 · 正在整理文件还原点" : "回复已结束 · 正在整理文件还原点") : stopPending ? "正在停止 · 新消息暂存队列" : waitingQuestionId ? "已暂停 · 请在问题卡片提交答案；新任务可排队" : PLACEHOLDER_BUSY;
    queueHint.textContent = turnFinalizing ? "正在整理文件还原点 · 完成后处理队列" : stopPending ? "正在停止 · 确认停止后处理队列" : waitingQuestionId ? "等待回答 · 提交问题答案后继续，排队任务暂不执行" : PLACEHOLDER_BUSY;
    queueHint.classList.toggle("hidden", !hasContent);
  } else {
    sendBtn.classList.remove("hidden");
    sendBtn.title = "发送";
    stopBtn.classList.add("hidden");
    inputEl.placeholder = PLACEHOLDER_IDLE;
    queueHint.classList.add("hidden");
  }
}
function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 240) + "px";
}

/** Collapse the composer's control row to icon-only (and hide the usage
 *  readouts) when the full-label row would overflow one line. Measured, not a
 *  breakpoint, because label widths vary by model name / locale. Hysteresis-
 *  free: the fit test always runs in the expanded state, so it can't oscillate. */
const composerTools = document.querySelector(".composer-tools") as HTMLElement | null;
let fittedComposerWidth = -1;
let composerFitRAF = 0;
function refitComposer() {
  if (!composerTools) return;
  // Two stages, each re-measured so we only shed what's necessary:
  //   1) `compact`      — keep model text, simplify other pickers and usage
  //   2) `compact-more` — also drop the usage readouts entirely
  composerTools.classList.remove("compact", "compact-more", "compact-wrap");
  const overflow = () => composerTools.scrollWidth > composerTools.clientWidth + 1; // +1px sub-pixel slack
  if (overflow()) {
    composerTools.classList.add("compact");
    if (overflow()) composerTools.classList.add("compact-more");
    if (overflow()) composerTools.classList.add("compact-wrap");
  }
  fittedComposerWidth = composerTools.clientWidth;
  positionSpeedPopover(speedFeedback);
}
if (composerTools && "ResizeObserver" in window) {
  new ResizeObserver(() => {
    // 换行改变高度会再次触发观察器；只响应宽度变化，并在下一帧修改布局。
    if (composerFitRAF || composerTools.clientWidth === fittedComposerWidth) return;
    composerFitRAF = requestAnimationFrame(() => { composerFitRAF = 0; refitComposer(); });
  }).observe(composerTools);
}
refitComposer();

// Paste an image into the composer to attach it.
inputEl.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.type.startsWith("image/")) {
      const file = it.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const uri = String(reader.result);
        const m = /^data:([^;]+);base64,(.*)$/.exec(uri);
        if (m) {
          pendingImages.push({ mediaType: m[1], data: m[2], uri });
          addImagePreview(uri);
          refreshComposerHint(); // an image alone should enable send/queue
        }
      };
      reader.readAsDataURL(file);
    }
  }
});

function addImagePreview(uri: string) {
  const wrap = el("div", "img-preview");
  const img = el("img") as HTMLImageElement;
  img.src = uri;
  img.onclick = () => openLightbox(uri);
  const x = el("button", "img-preview-x", "×");
  x.onclick = () => {
    const idx = pendingImages.findIndex((p) => p.uri === uri);
    if (idx >= 0) pendingImages.splice(idx, 1);
    wrap.remove();
    refreshComposerHint();
  };
  wrap.append(img, x);
  imagePreviews.appendChild(wrap);
}

// Lightbox (click any chat image to view full size; copy/save from the toolbar)
function openLightbox(src: string) {
  lightboxImg.src = src;
  lightbox.classList.remove("hidden");
}
function closeLightbox() {
  lightbox.classList.add("hidden");
  lightboxImg.src = "";
}
lightbox.onclick = closeLightbox; // click outside the image closes
lightboxImg.onclick = (e) => e.stopPropagation(); // clicking the image itself doesn't
$("lb-close").onclick = (e) => {
  e.stopPropagation();
  closeLightbox();
};
$("lb-save").onclick = (e) => {
  e.stopPropagation();
  if (lightboxImg.src) send({ type: "saveImage", dataUri: lightboxImg.src });
};
$<HTMLButtonElement>("lb-copy").onclick = async (e) => {
  e.stopPropagation();
  const btn = $("lb-copy");
  const src = lightboxImg.src;
  if (!src) return;
  try {
    // Clipboard only takes PNG — round-trip through a canvas (also normalizes jpeg/webp).
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("load"));
      img.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("blob");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    const old = btn.textContent;
    btn.textContent = "已复制 ✓";
    setTimeout(() => (btn.innerHTML = `${ICON.copy} 复制`), 1200);
    void old;
  } catch {
    btn.textContent = "复制失败，请用「保存」";
    setTimeout(() => (btn.innerHTML = `${ICON.copy} 复制`), 2000);
  }
};

// ---- Attached files (active editor file + drag-and-drop from the explorer) ----
let attachedFiles: { path: string; auto: boolean }[] = [];
let autoPath: string | null = null;
let autoDismissed = false;

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function onActiveFile(p: string | null) {
  if (p !== autoPath) autoDismissed = false; // switched files -> allow auto again
  autoPath = p;
  attachedFiles = attachedFiles.filter((f) => !f.auto);
  if (p && !autoDismissed && !attachedFiles.some((f) => f.path === p)) {
    attachedFiles.unshift({ path: p, auto: true });
  }
  renderFileChips();
}

function addFile(p: string) {
  if (!p) return;
  if (p === autoPath) autoDismissed = false;
  if (!attachedFiles.some((f) => f.path === p)) attachedFiles.push({ path: p, auto: false });
  renderFileChips();
}

function removeFile(p: string) {
  const f = attachedFiles.find((x) => x.path === p);
  if (f?.auto) autoDismissed = true;
  attachedFiles = attachedFiles.filter((x) => x.path !== p);
  renderFileChips();
}

function renderFileChips() {
  fileChips.innerHTML = "";
  for (const f of attachedFiles) {
    const chip = el("span", "file-attach" + (f.auto ? " auto" : ""));
    const name = el("span", "fa-name", baseName(f.path) || f.path);
    name.title = f.path + (f.auto ? "（当前文件）" : "");
    name.onclick = () => send({ type: "openFile", path: f.path });
    const x = el("button", "fa-x", "×");
    x.onclick = (e) => {
      e.stopPropagation();
      removeFile(f.path);
    };
    chip.append(name, x);
    fileChips.appendChild(chip);
  }
}

// Drag files / folders from the VS Code explorer anywhere onto the chat.
// Capture on the whole window (capture phase) and preventDefault so VS Code
// can't run its default "open the dropped file" action.
const dropZone = $("composer");
const allowDrop = (e: DragEvent) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  if ((e.target as Element | null)?.closest?.(".askp")) return;
  dropZone.classList.add("drag-over");
};
window.addEventListener("dragenter", allowDrop, true);
window.addEventListener("dragover", allowDrop, true);
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) dropZone.classList.remove("drag-over");
}, true);
window.addEventListener(
  "drop",
  (e: DragEvent) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    // 问题卡自己接收图片；不能在捕获阶段把附件截走发到聊天输入框。
    if ((e.target as Element | null)?.closest?.(".askp")) return;
    e.stopPropagation();
    const dt = e.dataTransfer;
    if (!dt) return;
    // ① VS Code 资源管理器（含其他窗口）拖入：uri-list 里直接有 file:// 路径。
    let added = 0;
    const uriRaw = dt.getData("application/vnd.code.uri-list") || dt.getData("text/uri-list") || "";
    const plain = dt.getData("text/plain") || "";
    // text/plain 只有整段内容"就是一列路径"时才当文件——拖一段日志/代码文本
    // 进来（里面恰好有 /etc/hosts 这样的行）不能被吞成附件。
    const plainLines = plain.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
    const plainIsPathList =
      plainLines.length > 0 && plainLines.length <= 5 && plainLines.every((s) => /^(file:\/\/|\/)\S+$/.test(s));
    const raw = uriRaw || (plainIsPathList ? plain : "");
    for (const line of raw.split(/[\r\n]+/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      try {
        const u = new URL(s);
        if (u.protocol === "file:") {
          let p = u.pathname;
          try {
            p = decodeURIComponent(u.pathname);
          } catch {
            /* keep raw */
          }
          addFile(p);
          added++;
        }
      } catch {
        if (s.startsWith("/")) {
          addFile(s);
          added++;
        }
      }
    }
    if (added) return;
    // 普通文本拖进来（选中的代码/日志）：插到输入框光标处，而不是静默吞掉。
    if (plain && !(dt.files && dt.files.length)) {
      const start = inputEl.selectionStart ?? inputEl.value.length;
      const end = inputEl.selectionEnd ?? start;
      inputEl.value = inputEl.value.slice(0, start) + plain + inputEl.value.slice(end);
      inputEl.selectionStart = inputEl.selectionEnd = start + plain.length;
      inputEl.focus();
      inputEl.dispatchEvent(new Event("input"));
      return;
    }
    // ② OS（Finder 等）拖入：没有 uri-list。老 Electron 的 File.path 能直接拿到
    // 绝对路径；新版拿不到就走 ③。
    const plainFiles = dt.files ? Array.from(dt.files) : [];
    if (plainFiles.length && plainFiles.every((f) => (f as any).path)) {
      for (const f of plainFiles) addFile((f as any).path);
      return;
    }
    // ③ 兜底：webview 里读出内容传给宿主镜像写盘（目录用 webkitGetAsEntry 递归）。
    // entries 必须在 drop 事件同步阶段抓取 —— dataTransfer 一出事件就失效。
    const entries = dt.items ? Array.from(dt.items).map((it) => (it as any).webkitGetAsEntry?.()).filter(Boolean) : [];
    if (entries.length) void importDroppedEntries(entries);
    else if (plainFiles.length) void importDroppedPlainFiles(plainFiles);
  },
  true,
);

// ---- 工作区外拖入的镜像导入（Finder 等来源，webview 拿不到绝对路径时） ----------
const DROP_MAX_FILE = 10 * 1024 * 1024; // 单文件上限 10MB
const DROP_MAX_TOTAL = 30 * 1024 * 1024; // 单次拖入总量 30MB
const DROP_MAX_COUNT = 300; // 单次拖入文件数上限

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function importDroppedPlainFiles(files: File[]): Promise<void> {
  const out: { rel: string; base64: string }[] = [];
  let skipped = 0;
  let total = 0;
  for (const f of files) {
    if (f.size > DROP_MAX_FILE || total + f.size > DROP_MAX_TOTAL || out.length >= DROP_MAX_COUNT) {
      skipped++;
      continue;
    }
    total += f.size;
    out.push({ rel: f.name, base64: bufToB64(await f.arrayBuffer()) });
  }
  if (out.length || skipped) {
    send({ type: "importDropped", roots: out.map((o) => ({ name: o.rel, isDir: false })), files: out, skipped: skipped || undefined });
  }
}

async function importDroppedEntries(entries: any[]): Promise<void> {
  const out: { rel: string; file: File }[] = [];
  const stat = { bytes: 0, skipped: 0 };
  const roots: { name: string; isDir: boolean }[] = [];
  const entryFile = (en: any) => new Promise<File>((res, rej) => en.file(res, rej));
  const readBatch = (rd: any) => new Promise<any[]>((res, rej) => rd.readEntries(res, rej));
  async function collect(en: any, prefix: string): Promise<void> {
    if (en.isFile) {
      let f: File;
      try {
        f = await entryFile(en);
      } catch {
        stat.skipped++;
        return;
      }
      if (f.size > DROP_MAX_FILE || stat.bytes + f.size > DROP_MAX_TOTAL || out.length >= DROP_MAX_COUNT) {
        stat.skipped++;
        return;
      }
      stat.bytes += f.size;
      out.push({ rel: prefix + en.name, file: f });
    } else if (en.isDirectory) {
      const rd = en.createReader();
      for (;;) {
        // readEntries 按批返回（Chromium 每批最多 100），必须循环读到空为止。
        let batch: any[];
        try {
          batch = await readBatch(rd);
        } catch {
          break;
        }
        if (!batch.length) break;
        for (const child of batch) await collect(child, prefix + en.name + "/");
      }
    }
  }
  for (const en of entries) {
    roots.push({ name: en.name, isDir: !!en.isDirectory });
    await collect(en, "");
  }
  const files: { rel: string; base64: string }[] = [];
  for (const o of out) files.push({ rel: o.rel, base64: bufToB64(await o.file.arrayBuffer()) });
  if (files.length || roots.length) {
    send({ type: "importDropped", roots, files, skipped: stat.skipped || undefined });
  }
}

// ---- Mode / model / effort pickers (popup menus, like Codex's UI) ----------
const SVG = (p: string) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  default: SVG('<path d="M8 1.8 13 3.6V7.2c0 3-2 5.2-5 6.2-3-1-5-3.2-5-6.2V3.6z"/>'), // shield (asks first)
  acceptEdits: SVG('<path d="M3 13l1-3 6.5-6.5 2 2L6 12z"/><path d="M9.5 4l2 2"/>'), // pencil
  plan: SVG('<rect x="3.5" y="2" width="9" height="12" rx="1"/><path d="M5.8 5.5h4.4M5.8 8h4.4M5.8 10.5h2.6"/>'), // plan/list
  auto: SVG('<path d="M8.6 1.6 4 9h3.2l-.6 5.4L12 6.6H8.2z"/>'), // zap (auto)
  bypassPermissions: SVG('<path d="M8 1.8 13 3.6V7.2c0 3-2 5.2-5 6.2-3-1-5-3.2-5-6.2V3.6z"/><path d="M5.4 5.4l5.2 5.2"/>'), // shield struck through (danger)
};
const MODES = [
  { id: "default", icon: ICONS.default, title: "按需审批", desc: "只读沙箱，写入和提权请求由你审批" },
  { id: "acceptEdits", icon: ICONS.acceptEdits, title: "自动编辑", desc: "Codex 直接编辑文件，无需逐个确认" },
  { id: "plan", icon: ICONS.plan, title: "只读模式", desc: "只读沙箱，不允许提权写入" },

  // Offered by the settings enum, so it MUST be representable here — falling
  // back to MODES[0] would label the most dangerous mode "发送前确认".
  { id: "bypassPermissions", icon: ICONS.bypassPermissions, title: "绕过权限", desc: "跳过所有权限检查（危险）" },
];
let modelEfforts: Record<string, string[]> = {};
let modelDefaultEfforts: Record<string, string> = {};
let MODELS: { id: string; label: string; desc: string }[] = [
  { id: "", label: "默认模型", desc: "使用 Codex 默认模型" },
];
// Keep official effort identifiers unchanged in every picker, tooltip and command.
const EFFORTS = [
  { id: "none", label: "none", desc: "不启用推理（模型支持时）" },
  { id: "minimal", label: "minimal", desc: "最少推理（模型支持时）" },
  { id: "low", label: "low", desc: "快速、直接的实现" },
  { id: "medium", label: "medium", desc: "均衡速度与推理深度" },
  { id: "high", label: "high", desc: "适合复杂问题的深入分析" },
  { id: "xhigh", label: "xhigh", desc: "扩展推理，深入分析" },
  { id: "max", label: "max", desc: "更充分的推理" },
  { id: "ultra", label: "ultra", desc: "最充分的推理" },
  { id: "", label: "default", desc: "使用模型默认推理强度" },
];
function availableEfforts() {
  const supported = modelEfforts[currentModel || actualSpeedModel];
  return supported?.length
    ? supported.map(id => EFFORTS.find(e => e.id === id) ?? { id, label: id, desc: "模型支持的推理强度" })
    : EFFORTS.filter(e => e.id);
}
let currentMode = "default";
let currentModel = "";
let currentEffort = "medium";
let modelPending = false;
let effortPending = false;
let speedPending = false;
let currentSpeedMode: SpeedMode = "default";
let speedModels: ModelChoice[] = [];
let actualSpeedModel = "";
let speedBilling: BillingKind = "unknown";
function speedModelId() { return currentModel || actualSpeedModel; }
function speedModel() { return speedModels.find(m => m.id === speedModelId()); }
function speedAvailability(mode: SpeedMode): string {
  if (supportsSpeed(speedModel(), mode)) return "当前账号可选";
  if (!speedModelId()) return "默认模型尚未确认，请先选择具体模型或连接会话";
  if (!speedModel()?.speedModes) return "尚未取得此模型的速度能力，请更新或重连 Codex 后确认";
  return "当前账号的此模型未提供该档位";
}
function syncPickers() {
  const fast = currentSpeedMode !== "default";
  const available = fast || supportsSpeed(speedModel(), "fast");
  const normalCost = speedCost("default", speedModelId(), speedBilling);
  const fastCost = speedCost("fast", speedModelId(), speedBilling);
  const gain = speedGain("fast", speedModelId(), speedBilling);
  speedTrigger.dataset.accelerated = String(fast);
  speedTrigger.setAttribute("aria-checked", String(fast));
  speedTrigger.setAttribute("aria-label", `快速模式：${fast ? "开启" : "关闭"}；点击切换${fast ? "普通" : "快速"}`);
  speedTrigger.disabled = speedPending || !available;
  speedTrigger.removeAttribute("title");
  speedTip.querySelector(".speed-tip-heading")!.textContent = fast ? "快速模式 · 已开启" : "普通模式";
  speedTip.querySelector(".speed-tip-normal")!.textContent = `标准速度 · ${normalCost.badge}`;
  speedTip.querySelector(".speed-tip-fast")!.textContent = `${gain.badge === "未公布" ? "更快响应" : "速度 " + gain.badge} · ${fastCost.badge}`;
  speedTip.querySelector(".speed-tip-note")!.textContent = speedBilling === "api"
    ? "按 API 单独计价，不适用订阅倍率。"
    : `${speedBilling === "unknown" ? "若使用订阅，" : ""}倍率指订阅额度消耗；购买额度／企业按量为 2×。${fastCost.badge === "倍率待确认" ? "当前模型额度倍率待确认。" : ""}${gain.badge === "未公布" ? "提速幅度随任务变化。" : ""}`;
  speedTip.querySelector(".speed-tip-action")!.textContent = speedPending ? "正在保存…"
    : !available ? speedAvailability("fast") : `点击切换为${fast ? "普通" : "快速"} · 仅当前会话下轮生效；模型与推理强度保持不变。`;
  if (!speedTip.hidden) showSpeedTip();
  const selectedEffort = currentEffort || modelDefaultEfforts[currentModel || actualSpeedModel];
  const effort = EFFORTS.find(e => e.id === selectedEffort);
  const effortLabel = effort?.label || selectedEffort || "default";
  $("effort-label").textContent = effortLabel;
  effortTrigger.title = `推理强度：${effortLabel}${effort ? `；${effort.desc}` : ""}。仅当前会话下轮生效；其他会话保持各自设置。`;
  effortTrigger.setAttribute("aria-label", `推理强度：${effortLabel}；点击选择`);
  if (!effortMenu.classList.contains("hidden")) buildEffortMenu();

  // An unknown mode must show ITSELF, never silently degrade to MODES[0] —
  // labelling an unrecognised (possibly permission-skipping) mode "发送前确认"
  // is the most dangerous lie this UI can tell.
  const mode = MODES.find((x) => x.id === currentMode) ?? {
    id: currentMode,
    icon: ICONS.default,
    title: currentMode || "未知模式",
    desc: "",
  };
  modeIcon.innerHTML = mode.icon;
  modeLabel.textContent = mode.title;
  modeTrigger.setAttribute("aria-label", `权限模式：${mode.title}；点击切换`);
  modeTip.querySelector(".speed-tip-heading")!.textContent = mode.title;
  modeTip.querySelector(".mode-tip-description")!.textContent = mode.desc || "当前权限模式尚未识别，请点击查看。";
  if (!modeTip.hidden) positionSpeedPopover(modeTip, modeTrigger);
  const model = MODELS.find((x) => x.id === currentModel);
  modelLabel.textContent = model?.label || speedModels.find(x => x.id === currentModel)?.name || currentModel || MODELS[0].label;
  modelTrigger.title = `当前模型：${modelLabel.textContent}（点击切换）。仅当前会话下轮生效；其他会话保持各自设置。`;
  refitComposer();
}

syncPickers(); // paint the real labels immediately (host `config` refines them)

function closePickers() {
  effortMenu.classList.add("hidden");
  effortTrigger.setAttribute("aria-expanded", "false");
  modeMenu.classList.add("hidden");
  modelMenu.classList.add("hidden");
  usageMenu.classList.add("hidden");
  pickBackdrop.classList.add("hidden");
}

function buildModeMenu() {
  let html = `<div class="pick-head">模式</div>`;
  for (const m of MODES) {
    const danger = m.id === "bypassPermissions";
    // 绕过权限 is not "one more mode" — a separator + warm tint set it apart.
    if (danger) html += `<div class="pick-sep"></div>`;
    html +=
      `<button class="pick-row${m.id === currentMode ? " on" : ""}${danger ? " danger" : ""}" data-mode="${m.id}">` +
      `<span class="pick-ico">${m.icon}</span>` +
      `<span class="pick-text"><span class="pick-title">${m.title}</span><span class="pick-desc">${m.desc}</span></span>` +
      `<span class="pick-check">${m.id === currentMode ? ICON.check : ""}</span></button>`;
  }
  modeMenu.innerHTML = html;
}

// 菜单与命令共用提交路径；由 host 的 config 回执确认，失败保持原设置。
function requestModelChange(model: string) {
  if (modelPending) { appendNotice("模型设置正在保存，请稍候。", "info"); return; }
  if (model === currentModel) return;
  modelPending = true;
  send({ type: "setModel", model });
  buildModelMenu();
}
function requestEffortChange(effort: string) {
  if (effortPending) { appendNotice("推理强度正在保存，请稍候。", "info"); return; }
  if (effort === currentEffort) return;
  effortPending = true;
  send({ type: "setEffort", effort });
  buildEffortMenu();
}

function buildModelMenu() {
  let html = `<div class="pick-head">模型</div>`;
  for (const m of MODELS) {
    const on = m.id === currentModel;
    html += `<button type="button" class="pick-row${on ? " on" : ""}" data-model="${escapeHtml(m.id)}" title="${escapeHtml(m.desc)}">` +
      `<span class="pick-text"><span class="pick-title">${escapeHtml(m.label)}</span><span class="pick-desc">${escapeHtml(m.desc)}</span></span>` +
      `<span class="pick-check">${on ? ICON.check : ""}</span></button>`;
  }
  modelMenu.innerHTML = html;
  for (const option of Array.from(modelMenu.querySelectorAll<HTMLButtonElement>("[data-model]"))) option.disabled = modelPending;
}

function buildEffortMenu() {
  let html = `<div class="pick-head">推理强度 · 仅当前会话下轮生效</div>`;
  const available = availableEfforts();
  const selectedEffort = currentEffort || modelDefaultEfforts[currentModel || actualSpeedModel];
  const selected = EFFORTS.find(e => e.id === selectedEffort)?.label || selectedEffort || "default";
  const activeIndex = available.findIndex(e => e.id === selectedEffort);
  html += `<div class="pick-sep"></div><div class="pick-effort" title="仅当前会话下轮生效"><span class="effort-current">推理程度 · ${escapeHtml(selected)}</span><div class="effort-options" role="group" aria-label="推理程度">`;
  for (const [index, e] of available.entries()) {
    const title = `${e.label}：${e.desc}`;
    html += `<button type="button" class="effort-option${index <= activeIndex ? " filled" : ""}${selectedEffort === e.id ? " on" : ""}" data-effort="${escapeHtml(e.id)}" aria-pressed="${selectedEffort === e.id}" aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}"><span class="effort-caption">${escapeHtml(e.label)}</span><span class="effort-bar" aria-hidden="true"></span></button>`;
  }
  html += `</div></div>`;
  effortMenu.innerHTML = html;
  for (const option of Array.from(effortMenu.querySelectorAll<HTMLButtonElement>("[data-effort]"))) option.disabled = effortPending;
}

/** Anchor a picker directly above its trigger button (same scheme as the
 *  usage popover): left edges aligned, clamped inside the composer. */
function positionPickMenu(menu: HTMLElement, trigger: HTMLElement) {
  const parent = menu.offsetParent as HTMLElement | null;
  if (!parent) return;
  const t = trigger.getBoundingClientRect();
  const pr = parent.getBoundingClientRect();
  menu.style.bottom = `${pr.bottom - t.top + 6}px`;
  // 矮窗口里按按钮上方的实际空间限制高度，避免速度菜单顶部被裁掉。
  menu.style.setProperty("--picker-available-height", `${Math.max(0, t.top - 14)}px`);
  // measure AFTER unhide, then keep the right edge inside the panel
  const w = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(t.left - pr.left, pr.width - w - 8))}px`;
}
window.addEventListener("resize", () => {
  for (const [menu, trigger] of [[modelMenu, modelTrigger], [modeMenu, modeTrigger], [effortMenu, effortTrigger]]) {
    if (!menu.classList.contains("hidden")) positionPickMenu(menu, trigger);
  }
  if (!usageMenu.classList.contains("hidden")) positionUsageMenu();
});
modeTrigger.onclick = (e) => {
  e.stopPropagation();
  hideModeTip();
  const open = !modeMenu.classList.contains("hidden");
  closePickers();
  if (!open) {
    buildModeMenu();
    modeMenu.classList.remove("hidden");
    positionPickMenu(modeMenu, modeTrigger);
    pickBackdrop.classList.remove("hidden");
  }
};
modelTrigger.onclick = (e) => {
  e.stopPropagation();
  const open = !modelMenu.classList.contains("hidden");
  closePickers();
  if (!open) {
    buildModelMenu();
    modelMenu.classList.remove("hidden");
    positionPickMenu(modelMenu, modelTrigger);
    pickBackdrop.classList.remove("hidden");
  }
};
pickBackdrop.onclick = closePickers;
speedTrigger.onclick = (e) => {
  e.stopPropagation();
  if (speedTrigger.disabled) return;
  closePickers();
  hideSpeedFeedback();
  speedPending = true;
  send({ type: "setSpeedMode", mode: currentSpeedMode === "default" ? "fast" : "default" });
  syncPickers(); // 等保存回执，不提前改变开关，避免显示与实际消费不一致。
};
effortTrigger.onclick = (e) => {
  e.stopPropagation();
  const open = !effortMenu.classList.contains("hidden");
  closePickers();
  if (!open) {
    buildEffortMenu();
    effortMenu.classList.remove("hidden");
    effortTrigger.setAttribute("aria-expanded", "true");
    positionPickMenu(effortMenu, effortTrigger);
    pickBackdrop.classList.remove("hidden");
  }
};
effortMenu.addEventListener("click", e => {
  const option = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-effort]");
  if (!option || option.disabled || effortPending) return;
  requestEffortChange(option.dataset.effort || "");
});

modeMenu.addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest("[data-mode]") as HTMLElement | null;
  if (row) {
    currentMode = row.dataset.mode || "default";
    send({ type: "setPermissionMode", mode: currentMode });
    syncPickers();
    closePickers();
  }
});
modelMenu.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const row = t.closest("[data-model]") as HTMLElement | null;
  if (!row || modelPending) return;
  requestModelChange(row.dataset.model || "");
  closePickers();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePickers();
});
$("btn-attach-file").onclick = () => send({ type: "pickFiles" });
cfHeader.onclick = (e) => {
  const btn = (e.target as HTMLElement).closest("[data-cf]") as HTMLElement | null;
  if (btn) {
    if (btn.dataset.cf === "acceptAll") send({ type: "acceptAll" });
    else if (btn.dataset.cf === "revertAll") send({ type: "revertAll" });
    return;
  }
  changedFiles.classList.toggle("collapsed");
};

// Event delegation: copy buttons & file links inside the message stream.
messagesEl.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const link = t.closest("a[href]") as HTMLAnchorElement | null;
  if (link) {
    e.preventDefault();
    const url = link.getAttribute("href") || "";
    if (/^(https?:\/\/|mailto:)/i.test(url)) send({ type: "openExternalLink", url });
    return;
  }
  const action = t.closest("[data-action]") as HTMLElement | null;
  if (!action) return;
  const codeOf = (a: HTMLElement) =>
    (a.closest(".code-block") ?? a.closest(".tool-card"))?.querySelector("code")?.textContent ?? "";
  if (action.dataset.action === "copy") {
    const code = codeOf(action);
    send({ type: "copy", text: code });
    const orig = action.innerHTML;
    action.textContent = "✓ 已复制";
    setTimeout(() => (action.innerHTML = orig), 1200);
  } else if (action.dataset.action === "run") {
    const code = codeOf(action);
    if (code.trim()) {
      send({ type: "runInTerminal", code });
      const orig = action.innerHTML;
      action.textContent = "✓ 已发送";
      setTimeout(() => (action.innerHTML = orig), 1200);
    }
  } else if (action.dataset.action === "toggle-code") {
    const block = action.closest(".code-block") as HTMLElement | null;
    if (block) {
      const collapsed = block.classList.toggle("collapsed");
      action.innerHTML = `${ICON.chevron}` + (collapsed ? `展开全部 ${block.dataset.lines || ""} 行` : "收起");
    }
  } else if (action.dataset.action === "diff") {
    const p = action.dataset.path;
    if (p) send({ type: "openDiff", path: p });
  } else if (action.dataset.action === "open") {
    const p = action.dataset.path;
    const line = action.dataset.line ? parseInt(action.dataset.line, 10) : undefined;
    const endLine = action.dataset.endline ? parseInt(action.dataset.endline, 10) : undefined;
    if (p) send({ type: "openFile", path: p, line, endLine });
  } else if (action.dataset.action === "symbol") {
    const name = action.dataset.symbol;
    if (name) send({ type: "openSymbol", name });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function appendUser(text: string, contextLabels: string[] = [], images: string[] = [], scroll = true) {
  messagesEl.querySelector(".empty-state")?.remove();
  const msg = el("div", "msg user");
  msg.dataset.rawText = text;
  const body = el("div", "msg-body");
  if (contextLabels.length) {
    const ctx = el("div", "user-context");

    for (const l of contextLabels) ctx.appendChild(el("span", "ctx-chip", l));
    body.appendChild(ctx);
  }
  if (images.length) {
    const grid = el("div", "msg-images");
    for (const src of images) grid.appendChild(makeImageChip(src));
    body.appendChild(grid);
  }
  const replies = parseQuestionReply(text);
  if (replies) {
    msg.classList.add("question-reply");
    body.appendChild(askQuestionNode(replies.map(reply => [reply.question, reply.answers.join("、")])));
  } else if (text.trim()) {
    // to ~4 lines with a fade + "展开全部 N 行", same mechanic as a long Bash
    // command. Wrapper (not the .md itself) carries the collapse so the text
    // element's display mode never changes — a -webkit-line-clamp switch to
    // flex-box rendering was subtly altering the font on expand.
    const fold = el("div", "user-fold collapsed");
    // 用户发的内容按纯文本显示：粘贴带 markdown/HTML 记号的内容（日志里的
    // **、#、反引号等）不应被当成样式渲染。只保留换行与空白。
    const seg = el("div", "md user-plain");
    seg.textContent = text;
    fold.appendChild(seg);
    body.appendChild(fold);
    requestAnimationFrame(() => {
      // Hidden hosts (folded history) measure 0 — fall back to a newline count.
      const lines = text.split("\n").length;
      const overflows = fold.scrollHeight === 0 ? lines > 4 : seg.scrollHeight - fold.clientHeight > 4;
      if (overflows) {
        const btn = el("button", "user-more") as HTMLButtonElement;
        const setLabel = () =>
          (btn.innerHTML = `${ICON.chevron}` + (fold.classList.contains("collapsed") ? `展开全部 ${lines} 行` : "收起"));
        btn.onclick = () => {
          const collapsed = fold.classList.toggle("collapsed");
          if (collapsed) fold.scrollTop = 0; // re-fold from the top, not mid-scroll
          setLabel();
        };
        setLabel();
        fold.after(btn);
        fold.classList.add("scrollable"); // expanded state gets a height cap + scroll
      } else {
        fold.classList.remove("collapsed");
      }
    });
  }
  msg.appendChild(body);
  messagesEl.appendChild(msg);
  lastUserEl = msg;
  userMsgCount++;
  if (scroll) scrollToBottom();
  return msg;
}

/** The user message that prompted a given assistant turn (walks back past dividers). */
function precedingUserMsg(aEl: HTMLElement): HTMLElement | null {
  let n = aEl.previousElementSibling as HTMLElement | null;
  while (n) {
    if (n.classList?.contains("msg") && n.classList.contains("user")) return n;
    n = n.previousElementSibling as HTMLElement | null;
  }
  return null;
}

/** The icon-button row shown at the bottom of an assistant reply. */
function buildReplyActions(aEl: HTMLElement): HTMLElement {
  const acts = el("div", "msg-actions");
  const mk = (icon: string, title: string, fn: (b: HTMLButtonElement) => void) => {
    const b = el("button", "msg-act") as HTMLButtonElement;
    b.innerHTML = `${icon}<span>${title}</span>`;
    b.title = title;
    b.onclick = () => fn(b);
    return b;
  };
  const regen = mk(ICON.update, "重新生成", () => regenerate(aEl));
  // 重新生成会回退到该轮之前重发——只对最新一条回复开放；旧回复由 CSS 隐藏此按钮
  // （点旧回复会连带砍掉其后的所有对话并打断进行中的回复，非用户所愿）。
  regen.classList.add("regen");
  const copy = mk(ICON.copy, "复制", (b) => {
    const text = Array.from(aEl.querySelectorAll(".msg-body .text-seg"))
      .map((e) => (e as HTMLElement).innerText)
      .join("\n\n")
      .trim();
    send({ type: "copy", text });
    b.classList.add("done");
    setTimeout(() => b.classList.remove("done"), 1000);
  });
  // 赞/踩 were pure decoration — nothing on either side of the wire consumed
  // the rating, so they were two buttons that did nothing.
  acts.append(regen, copy);
  return acts;
}

/** Re-run the user message that produced this reply: rewind to before it
 *  (truncate transcript + revert files) and resend the same text. */
function regenerate(aEl: HTMLElement) {
  if (isBusy || rateLimited) return;
  // 只重新生成最新一条回复：其后若还有别的消息（更晚的对话），拒绝——否则会砍掉
  // 那些对话。CSS 已隐藏旧回复的按钮，这里是兜底。
  let after = aEl.nextElementSibling;
  while (after) {
    if (after.classList.contains("msg")) return;
    after = after.nextElementSibling;
  }
  const userMsg = precedingUserMsg(aEl);
  if (!userMsg) return;
  const raw = userMsg.dataset.rawText || "";
  // Image-only messages have no text but are still regenerable — as long as at
  // least one image can actually be re-sent (a base64 data URI).
  const hasSendableImage = Array.from(userMsg.querySelectorAll<HTMLImageElement>(".msg-images img")).some((i) =>
    i.src.startsWith("data:"),
  );
  if (!raw && !hasSendableImage) return;
  submitEdit(userMsg, userMsg.dataset.checkpointId || "", raw, true);
}

function submitEdit(msg: HTMLElement, checkpointId: string, newText: string, regen = false) {
  restoringRegen = regen;
  // Carry the original message's images through the edit/regenerate. Build the
  // shown list and the sent list in ONE pass: filtering only the sent list let
  // the view display images (e.g. https: or `;charset=` data URIs) that were
  // never actually sent to the model.
  const imageUris: string[] = [];
  const images: { mediaType: string; data: string }[] = [];
  for (const img of Array.from(msg.querySelectorAll<HTMLImageElement>(".msg-images img"))) {
    const m = /^data:([^;,]+)(?:;[^;,]+)*;base64,(.*)$/.exec(img.src);
    if (m) {
      images.push({ mediaType: m[1], data: m[2] });
      imageUris.push(img.src);
    }
  }
  // Remove this message's checkpoint divider (the one just above it), the
  // message itself, and everything after it.
  const prev = msg.previousElementSibling;
  if (prev && prev.classList.contains("checkpoint-divider")) prev.remove();
  let node = msg.nextElementSibling;
  while (node) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
  msg.remove();
  pruneRailObservers();
  cancelLiveRender();
  // Reset streaming state and re-append the edited message as the new turn.
  assistantEl = null;
  liveBlock = null;
  toolCards.clear();
  userMsgCount = messagesEl.querySelectorAll(".msg.user").length;
  appendUser(newText, [], imageUris);
  finalizeTurn();
  // Enter busy state like performSend — the host rewinds + respawns before the
  // real busy:true arrives; without this the stop button is missing and a
  // second Enter could race a concurrent turn.
  turnTokens = 0;
  turnEst = 0;
  turnThinkTokens = 0;
  msgTokenBase = 0;
  lastMsgTokens = 0;
  resetTokenTween();
  isBusy = true;
  turnStartedAt = performance.now();
  // stoppingView stays as-is — see performSend; `setBusy(true)` reopens the gate.
  refreshComposerHint();
  showWorking();
  send({ type: "editMessage", checkpointId, text: newText, images: images.length ? images : undefined });
}

/** Compact attachment card for images in USER messages: mini thumbnail +
 *  name + "W×H · size". The real <img> stays in the DOM, so everything that
 *  collects `.msg-images img` (regenerate, edit, question bar) keeps working.
 *  Click opens the lightbox, same as the old full-size thumb. */
function makeImageChip(src: string): HTMLElement {
  const chip = el("div", "img-chip");
  const im = el("img") as HTMLImageElement;
  im.src = src;
  im.loading = "lazy";
  // Pasted images carry no filename — derive a readable one from the mime type.
  const ext = (/^data:image\/(\w+)/.exec(src)?.[1] || "png").replace("jpeg", "jpg");
  const info = el("span", "ic-info");
  const name = el("span", "ic-name", `image.${ext}`);
  const meta = el("span", "ic-meta");
  const b64 = src.split(",")[1];
  const kb = b64 ? (b64.length * 3) / 4 / 1024 : 0;
  const sizeText = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`;
  im.onload = () => (meta.textContent = `${im.naturalWidth}×${im.naturalHeight} · ${sizeText}`);
  if (kb) meta.textContent = sizeText; // shown until dimensions load
  info.append(name, meta);
  chip.append(im, info);
  chip.onclick = () => openLightbox(src);
  return chip;
}

/** An image thumbnail that opens the lightbox on click. */
function makeThumb(src: string): HTMLElement {
  const img = el("img", "msg-image") as HTMLImageElement;
  img.src = src;
  img.loading = "lazy";
  img.onclick = () => openLightbox(src);
  return img;
}

function appendNotice(text: string, kind: "info" | "error") {
  const n = el("div", `notice ${kind}`, text);
  messagesEl.appendChild(n);
  maybeScroll();
}

function renderSnapshotSkips(m: Extract<ToWebview, { kind: "snapshot_skips" }>) {
  messagesEl.querySelector(".snapshot-skips")?.remove();
  const card = el("div", "snapshot-skips");
  card.dataset.total = String(m.total);
  const head = el("div", "ss-head");
  head.append(el("strong", "", "未纳入自动回滚快照"), el("span", "ss-count", `${m.total} 项`));
  card.append(head, el("div", "ss-desc", "这些路径无法用“还原到此处”恢复。排除记录仅保存在本机，不修改项目文件。"));
  const list = el("div", "ss-list");
  for (const file of m.files) {
    const row = el("div", "ss-row");
    row.dataset.path = file.path;
    const name = el("span", "ss-name", file.rel);
    name.title = file.path;
    const reason = el("span", "ss-reason", file.reason);
    const exclude = el("button", "ss-action", "排除");
    exclude.title = "仅在本机记住此路径，之后不再提醒；不修改项目文件";
    exclude.onclick = () => {
      card.querySelectorAll<HTMLButtonElement>("button").forEach(btn => btn.disabled = true);
      send({ type: "excludeSnapshotPaths", paths: [file.path] });
    };
    row.append(name, reason, exclude);
    list.appendChild(row);
  }
  card.appendChild(list);
  if (m.total > m.files.length) card.appendChild(el("div", "ss-more", `另有 ${m.total - m.files.length} 项，完整清单见“Codex Chat”输出。`));
  const actions = el("div", "ss-actions");
  const all = el("button", "ss-action", "排除全部");
  all.title = "仅在本机记住本次清单中的全部路径；不修改项目文件";
  all.onclick = () => {
    card.querySelectorAll<HTMLButtonElement>("button").forEach(btn => btn.disabled = true);
    send({ type: "excludeSnapshotPaths", all: true });
  };
  const dismiss = el("button", "ss-action", "忽略本次提醒");
  dismiss.onclick = () => card.remove();
  actions.append(all, dismiss);
  card.appendChild(actions);
  messagesEl.appendChild(card);
  maybeScroll();
}

/** Subscription quota banner. `exhausted` is blocking — the composer is locked
 *  until the window resets, so it must be impossible to miss (unlike a notice
 *  the user can scroll past). */
function renderRateLimit(m: Extract<ToWebview, { kind: "rate_limit" }>) {
  const exhausted = m.level === "exhausted";
  // 按模型的周限用尽 ≠ 不能对话：切换其他模型就能继续，绝不锁输入框。
  const blocking = exhausted && !m.modelScoped;
  messagesEl.querySelector(".rate-limit-banner")?.remove(); // never stack banners

  const box = el("div", `rate-limit-banner ${exhausted ? "exhausted" : "warning"}`);
  // One line: what happened, what to do, when it comes back. The old banner
  // spelled the reset time out in a sentence and filled the panel with red.
  const head = el("div", "rl-head");
  const text = el("div", "rl-text");
  text.append(
    el("span", "rl-title", exhausted ? `${m.limitLabel}已用尽` : `${m.limitLabel}即将用尽`),
    el(
      "span",
      "rl-body",
      exhausted
        ? m.modelScoped
          ? " · 切换其他模型可立即继续"
          : " · 暂时无法继续对话"
        : " · 接近订阅限额",
    ),
  );
  head.append(el("span", "rl-ico", "!"), text);
  const acts = el("div", "rl-acts");
  const cd = resetCountdownShort(m.resetsAt);
  const when = m.resetsAt ? new Date(m.resetsAt * 1000).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  if (when || cd) acts.appendChild(el("span", "rl-when", [when, cd].filter(Boolean).join(" · ")));
  if (m.modelScoped) {
    // The fix for a per-model limit is one click away — offer it here instead
    // of describing it and making the user go find the picker.
    const sw = el("button", "rl-switch", "切换模型");
    sw.onclick = () => modelTrigger.click();
    acts.appendChild(sw);
  }
  if (!blocking) {
    // 非阻断级可关闭：本重置周期内不再提示（宿主记住 resetsAt，周期一过自然恢复）。
    // 全局耗尽是阻断性的，必须一直显示，不给关闭按钮。
    const x = el("button", "rl-close", "×");
    x.title = "本周期内不再提示";
    x.onclick = () => {
      box.remove();
      send({ type: "dismissRateLimit", limitLabel: m.limitLabel, resetsAt: m.resetsAt });
    };
    acts.appendChild(x);
  }
  box.append(head, acts);
  messagesEl.appendChild(box);
  maybeScroll();

  if (blocking) {
    rateLimited = true;
    setGlow("error");
    setBusy(false);
    refreshComposerHint();
    // The CLI only reports "cleared" from a live turn — but we just blocked
    // sending, so no turn can ever run. Without this timer the user stays
    // locked out forever. Unlock ourselves once the window is due to reset.
    if (rlUnlockTimer) clearTimeout(rlUnlockTimer);
    if (m.resetsAt) {
      const ms = m.resetsAt * 1000 - Date.now() + 2000; // +2s slack
      if (ms > 0 && ms < 2 ** 31 - 1) rlUnlockTimer = window.setTimeout(clearRateLimit, ms);
      else if (ms <= 0) clearRateLimit(); // reset time already passed
    }
  }
}

function clearRateLimit() {
  if (rlUnlockTimer) {
    clearTimeout(rlUnlockTimer);
    rlUnlockTimer = 0;
  }
  if (!rateLimited) return;
  rateLimited = false;
  messagesEl.querySelector(".rate-limit-banner.exhausted")?.remove();
  setGlow("idle");
  refreshComposerHint();
  // 解锁后把被拦下的队列续上（锁定期间 flushQueue 是按兵不动的）。
  if (taskQueue.length) setTimeout(flushQueue, 150);
}

function addContextChip(label: string, text: string) {
  if (pendingContexts.some((c) => c.label === label)) return;
  pendingContexts.push({ label, text });
  const chip = el("span", "input-chip");
  chip.append(document.createTextNode(label));
  const x = el("button", "chip-x", "×");
  x.onclick = () => {
    const i = pendingContexts.findIndex((c) => c.label === label);
    if (i >= 0) pendingContexts.splice(i, 1);
    chip.remove();
  };
  chip.appendChild(x);
  contextChips.appendChild(chip);
}
function clearContextChips() {
  pendingContexts.length = 0;
  contextChips.innerHTML = "";
}

/** Composer status glow: a breathing halo around the input box. */
type GlowState = "idle" | "running" | "waiting" | "done" | "error";
const appEl = $("app");
let glowState: GlowState = "idle";

/** Is the user's caret actually sitting in the composer right now? */
function composerFocused(): boolean {
  return document.hasFocus() && document.activeElement === inputEl;
}

function setGlow(state: GlowState) {
  // Finishing while the user is already typing in the box needs no marker —
  // and `focus` wouldn't fire again, so the halo could never be dismissed.
  if (state === "done" && composerFocused()) state = "idle";
  if (glowState === state) return;
  glowState = state;
  appEl.classList.remove("glow-running", "glow-waiting", "glow-done", "glow-error");
  if (state !== "idle") appEl.classList.add(`glow-${state}`);
}

// `done` (green) and `error` (red) are unread markers: they breathe until the
// user returns to the composer. Focusing, clicking or typing IS that
// acknowledgement. `running` / `waiting` stay — they're live state.
const ackGlow = () => {
  // A rate-limit block is ONGOING, not a past event — its red rim must survive
  // until the quota resets. `running`/`waiting` are live state for the same reason.
  if (rateLimited) return;
  if (glowState === "done" || glowState === "error") setGlow("idle");
};
inputEl.addEventListener("focus", ackGlow);
inputEl.addEventListener("input", ackGlow); // typing counts as acknowledgement
// `focus` never fires when the box is ALREADY focused (the common case: the user
// hit Enter and never clicked away). Clicking it must still dismiss the marker.
inputEl.addEventListener("mousedown", ackGlow);

function setBusy(busy: boolean) {
  if (busy && !isBusy) {
    turnStartedAt = performance.now();
    turnHasReply = false;
  }
  if (!busy) turnStartedAt = null;
  isBusy = busy;
  stopPending = false;
  turnFinalizing = false;
  if (!busy) { waitingQuestionId = undefined; childQuestionIds.clear(); }
  // Only light UP here. Turning the glow off is the job of whoever ends the turn
  // (`result` / `error` / Stop), which knows WHY it ended — `setBusy(false)`
  // fires on all of them and would otherwise erase the red/green rim instantly.
  if (busy && glowState !== "waiting") setGlow("running");
  if (busy) stoppingView = false; // a new turn is live — resume rendering
  // 新一轮开始就把「已更改文件」收回折叠态——上一轮手动展开过的话，本轮执行中
  // 陆续进来的文件会顶着展开列表刷存在感；默认折叠必须对每一轮成立。
  if (busy) changedFiles.classList.add("collapsed");
  refreshComposerHint(); // toggles send/stop + the "加入等待队列" hint
  if (busy) {
    if (waitingQuestionId) removeWorking();
    else {
      if (!assistantEl?.querySelector(".working-pill")) showWorking("等待 Codex 响应…");
      if (assistantEl) assistantEl.classList.add("streaming-turn");
    }
  } else {
    removeWorking();
    // Turn finished — kick off the next queued task (slight delay so the result
    // UI settles and the process is idle before resuming).
    if (taskQueue.length) setTimeout(flushQueue, 150);
  }
  if (!busy && !statusLine.textContent?.startsWith("完成")) statusLine.textContent = "";
}

/** 本轮尚未结束时持续保留状态，正文暂停或块间等待也不会失去计时反馈。 */
/** 状态由后端事件决定；本地计时器只更新时长，不虚构活动阶段。 */
function showWorking(label?: string) {
  if (stoppingView || waitingQuestionId) return;
  const body = ensureAssistant();
  let w = body.querySelector(".working-pill") as HTMLElement | null;
  if (!w) {
    w = el("div", "working-pill");
    w.dataset.start = String(turnStartedAt ?? performance.now());
    w.dataset.progressAt = String(performance.now());
    w.innerHTML =
      `<span class="typing"><span></span><span></span><span></span></span>` +
      `<span class="wk-label"></span><span class="wk-time" title="整轮任务的总耗时，包含模型处理、工具执行和响应等待；不是卡住或静默的时长。提交新答案后重新计时"></span><span class="wk-tokens"></span><span class="wk-progress" role="status"></span>`;
    body.appendChild(w);
  }
  paintWorkingTime(w);
  const lbl = w.querySelector(".wk-label") as HTMLElement;
  if (lbl) lbl.textContent = label ?? "模型处理中…";
  const tk = w.querySelector(".wk-tokens") as HTMLElement;
  setPillTokens();
  // 阶段切换时直接接续当前数值，旧动画帧不能把已显示的计数拉回零。
  tokenShown = tokenTarget;
  if (tk) tk.textContent = pillTokenText(tokenShown);
  // Always keep the pill as the last element so it sits below the latest output.
  if (body.lastElementChild !== w) body.appendChild(w);
  startTick();
  updateActiveLine(); // extend the active glow down to the pill right away
  maybeScroll();
}
function removeWorking() {
  assistantEl?.querySelector(".working-pill")?.remove();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function scrollToBottom() {
  // 立即恢复跟随，下一批流式文字无需等待浏览器 scroll 事件就能继续滚动。
  readingHistory = false;
  pinnedToBottom = true;
  newReplyAvailable = false;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateJumpLatest();
  updateQuestionBar();
}
function truncateText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… (已截断 ${s.length - n} 字符)` : s;
}
function toolIcon(name: string): string {
  const map: Record<string, string> = {
    Bash: ICON.terminal,
    Grep: ICON.search,
    Glob: ICON.search,
    Task: ICON.task,
    WebFetch: ICON.web,
    WebSearch: ICON.web,
  };
  return map[name] || ICON.tool;
}
// ---------------------------------------------------------------------------
// 全局搜索（Cmd/Ctrl+F）：在消息区里查找文本，命中加底色、当前一条描边并滚到视野内。
// 浮层绝对定位在聊天区右上角，不改变消息布局与滚动位置。
// ---------------------------------------------------------------------------
const findBar = el("div", "find-bar hidden");
const findInput = el("input", "find-input") as HTMLInputElement;
findInput.type = "text";
findInput.placeholder = "查找";
findInput.spellcheck = false;
const findCount = el("span", "find-count", "—");
const findPrev = el("button", "find-btn find-prev");
findPrev.title = "上一处 (⇧↵)";
findPrev.innerHTML = ICON.chevron;
const findNext = el("button", "find-btn find-next");
findNext.title = "下一处 (↵)";
findNext.innerHTML = ICON.chevron;
const findClose = el("button", "find-btn find-close", "×");
findClose.title = "关闭 (Esc)";
findBar.append(findInput, findCount, findPrev, findNext, findClose);
$("app").appendChild(findBar);

let findHits: HTMLElement[] = [];
let findIdx = -1;

/** 拆掉所有 <mark class="find-hit">，把文本还原回原文本节点（父节点归并相邻文本）。 */
function findClear() {
  const marks = messagesEl.querySelectorAll("mark.find-hit");
  const parents = new Set<Node>();
  marks.forEach((m) => {
    const p = m.parentNode;
    if (!p) return;
    p.replaceChild(document.createTextNode(m.textContent || ""), m);
    parents.add(p);
  });
  parents.forEach((p) => (p as Node).normalize());
  findHits = [];
  findIdx = -1;
}

/** 遍历消息区文本节点，把匹配片段包进 <mark>，返回命中列表（跳过脚本/浮层自身）。 */
function findCollect(q: string): HTMLElement[] {
  const marks: HTMLElement[] = [];
  const lc = q.toLowerCase();
  const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      const v = node.nodeValue;
      if (!v || !v.toLowerCase().includes(lc)) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "MARK") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.nodeValue || "";
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0;
    let idx = lower.indexOf(lc, i);
    while (idx !== -1) {
      if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      marks.push(mark);
      i = idx + q.length;
      idx = lower.indexOf(lc, i);
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    node.parentNode?.replaceChild(frag, node);
  }
  return marks;
}

/** 更新计数、无结果红框，并把当前命中标 .current 且滚到视野中央。 */
function findMark(scroll: boolean) {
  findBar.classList.toggle("empty-hits", !!findInput.value && findHits.length === 0);
  if (!findInput.value) {
    findCount.textContent = "—";
  } else if (!findHits.length) {
    findCount.textContent = "0 / 0";
  } else {
    findCount.textContent = `${findIdx + 1} / ${findHits.length}`;
  }
  findPrev.disabled = findHits.length === 0;
  findNext.disabled = findHits.length === 0;
  findHits.forEach((m, i) => m.classList.toggle("current", i === findIdx));
  if (scroll && findIdx >= 0) findHits[findIdx].scrollIntoView({ block: "center", behavior: "auto" });
}

function findRun() {
  findClear();
  const q = findInput.value;
  if (q) {
    findHits = findCollect(q);
    findIdx = findHits.length ? 0 : -1;
  }
  findMark(true);
}

function findGoto(delta: number) {
  if (!findHits.length) return;
  findIdx = (findIdx + delta + findHits.length) % findHits.length;
  findMark(true);
}

function findOpen() {
  findBar.classList.remove("hidden");
  findInput.focus();
  findInput.select();
  if (findInput.value) findRun();
}
function findCloseBar() {
  findClear();
  findBar.classList.add("hidden");
  findBar.classList.remove("empty-hits");
  inputEl.focus();
}

findInput.addEventListener("input", findRun);
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); findGoto(e.shiftKey ? -1 : 1); }
  else if (e.key === "ArrowDown") { e.preventDefault(); findGoto(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); findGoto(-1); }
  else if (e.key === "Escape") { e.preventDefault(); findCloseBar(); }
});
findPrev.onclick = () => { findGoto(-1); findInput.focus(); };
findNext.onclick = () => { findGoto(1); findInput.focus(); };
findClose.onclick = findCloseBar;
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    findOpen();
  } else if (e.key === "Escape" && !findBar.classList.contains("hidden")) {
    findCloseBar();
  }
}, true);

// ---------------------------------------------------------------------------
send({ type: "ready" });
autoResize();
updateEmptyState();
