import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceActivity } from './workspaceActivity';
import { CheckpointSummary } from "./shared";
import { checkpointTextKey, QUESTION_REPLY_PREFIX } from "./codex/events";
import { expectedFileError, operationFailure, operationLog } from './operations';

interface FileBackup {
  path: string;
  /** Pre-edit content, or null if the file did not exist (i.e. was created). */
  content: string | null;
  /** 收尾时的文件指纹；还原前必须仍一致。 */
  after?: string;
}

interface Checkpoint {
  id: string;
  label: string;
  createdAt: number;
  userText: string;
  files: FileBackup[];
  /** “保留改动”只清理待审列表，仍保留时间点还原所需的原文。 */
  acceptedFiles?: FileBackup[];
  /** 新版确实采集了工作区基线；旧记录不能据空 files 推断没有改动。 */
  workspaceSnapshot?: boolean;
  /** 最终差异已归档；异常退出丢失内存基线时不能声称能完整还原。 */
  snapshotComplete?: boolean;
  activityId?: string;
  /** Files touched this turn that could NOT be snapshotted (too large / binary).
   *  Restore must surface these — silently reporting success while a file keeps
   *  Codex's edits is a lie. */
  skipped?: string[];
  /** Number of Codex turns completed *before* this turn ran. Restoring
   *  this checkpoint forks conversation history through this many turns. */
  truncateLine: number;
}

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** Oldest checkpoints beyond this are pruned (their earliest-baseline role for
 *  the changed-files panel passes to the next snapshot). Keeps globalStorage
 *  from growing without bound: each checkpoint can hold full file contents. */
const MAX_CHECKPOINTS = 40;

/**
 * Restore points. A checkpoint is created at each user turn. Before any
 * file-modifying tool runs, the target file's current content is snapshotted
 * into the active checkpoint. Restoring a checkpoint reverts every file change
 * made at or after that point.
 */
export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  /** Pre-session content of files whose ORIGINAL snapshot lived in a checkpoint
   *  that has since been pruned. Without this, `originalOf()` would return a
   *  mid-session snapshot (already containing Codex's earlier edits) and
   *  "revert file" would silently keep those edits while claiming success. */
  private baseline = new Map<string, string | null>();
  private baselineSkipped = new Set<string>();
  private sessionId?: string;
  private activity?: WorkspaceActivity;
  private activityCheckpoint?: string;

  constructor(private readonly storageDir: string) {}

  get workspaceActivityId(): string | undefined { return this.activity?.id; }

  /** 在自动保存/基线扫描之前登记，包括关闭文件快照的会话。 */
  startWorkspaceActivity(roots: string[]): void {
    this.finishWorkspaceActivity();
    this.activity = WorkspaceActivity.begin(this.storageDir, roots);
  }

  finishWorkspaceActivity(): void {
    if (!this.activity) return;
    const cp = this.checkpoints.find(c => c.id === this.activityCheckpoint);
    this.activity.finish([...(cp?.acceptedFiles ?? []), ...(cp?.files ?? [])].map(f => f.path));
    this.activity = undefined;
    this.activityCheckpoint = undefined;
  }

  setSession(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.load();
  }

  /**
   * Open a new checkpoint for a user turn.
   * @param truncateLine line count of the session transcript before this turn.
   */
  beginTurn(userText: string, truncateLine: number, workspaceSnapshot?: boolean): string {
    if (this.activityCheckpoint) this.finishWorkspaceActivity();
    if (!this.activity) this.startWorkspaceActivity([]);
    const id = randomUUID();
    this.activityCheckpoint = id;
    this.checkpoints.push({
      id,
      label: shortLabel(userText),
      createdAt: Date.now(),
      userText,
      files: [],
      workspaceSnapshot,
      activityId: this.activity!.id,
      truncateLine,
    });
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      // Fold the dropped checkpoints' EARLIEST snapshots into `baseline` before
      // discarding them — they are the only record of the files' pre-session
      // content. Dropping them outright corrupts revert/diff.
      const cut = this.checkpoints.length - MAX_CHECKPOINTS;
      for (const c of this.checkpoints.slice(0, cut)) {
        for (const f of c.files) if (!this.baseline.has(f.path)) this.baseline.set(f.path, f.content);
        for (const s of c.skipped ?? []) this.baselineSkipped.add(s);
      }
      this.checkpoints = this.checkpoints.slice(cut);
    }
    this.persist();
    return id;
  }

  /** 答案提交失败时，只撤掉刚创建且尚未记录任何改动的还原点。 */
  discardEmpty(checkpointId: string): void {
    const cp = this.current();
    if (cp?.id !== checkpointId || cp.files.length || cp.acceptedFiles?.length || cp.skipped?.length) return;
    this.checkpoints.pop();
    this.persist();
  }

  /** Snapshot a file before it is modified (idempotent within a checkpoint). */
  snapshotFile(absPath: string): void {
    const cp = this.current();
    if (!cp) return;
    if (cp.files.some((f) => f.path === absPath) || cp.skipped?.includes(absPath)) return;
    let content: string | null = null;
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_SNAPSHOT_BYTES) {
        (cp.skipped ??= []).push(absPath); // too large — restore must report it
        this.persistSoon();
        return;
      }
      const buf = fs.readFileSync(absPath);
      // Binary files round-tripped through utf8 come back corrupted — skip them.
      if (buf.subarray(0, 8192).includes(0)) {
        (cp.skipped ??= []).push(absPath);
        this.persistSoon();
        return;
      }
      content = buf.toString("utf8");
    } catch (error) {
      if (!expectedFileError(error)) {
        operationFailure('checkpoint.snapshot', error, { checkpointId: cp.id });
        (cp.skipped ??= []).push(absPath); this.persistSoon(); return;
      }
      content = null; // 仅 ENOENT 能证明文件原本不存在。
    }
    cp.files.push({ path: absPath, content });
    // Debounced: a turn with many edits otherwise rewrites the (potentially
    // multi-MB) snapshot JSON once per tool call, on the host thread.
    this.persistSoon();
  }

  recordSnapshot(file: string, content: string | null): void {
    const cp = this.current();
    if (!cp || cp.files.some(f => f.path === file)) return;
    cp.files.push({ path: file, content }); this.persistSoon();
  }

  recordUnrestorable(files: Iterable<string>): void {
    const cp = this.current();
    if (!cp) return;
    cp.skipped = [...new Set([...(cp.skipped ?? []), ...files])];
    this.persistSoon();
  }

  completeSnapshot(): void {
    const cp = this.current();
    if (!cp) return;
    // 与基线不同，结束指纹只写一次；重复收尾不能把外部修改冒充成本会话结果。
    if (cp.snapshotComplete) return;
    for (const file of [...(cp.acceptedFiles ?? []), ...cp.files]) file.after = fileState(file.path);
    this.finishWorkspaceActivity();
    cp.snapshotComplete = true;
    this.persistSoon();
  }

  /** 重新回答必须能回退文件，不能静默降级成只修改对话。 */
  restoreBlockReason(checkpointId: string, checkFiles = true): string | undefined {
    const index = this.checkpoints.findIndex(c => c.id === checkpointId);
    if (index < 0) return "缺少回答前的文件还原点";
    const later = this.checkpoints.slice(index);
    if (later.some(c => c.workspaceSnapshot !== true)) return "回答或后续轮次缺少可验证的工作区快照（旧记录或当时未开启快照）";
    if (!checkFiles) return undefined;
    if (later.some(c => !c.snapshotComplete)) return "回答后的文件差异未完整归档，无法确认全部后续改动";
    const unsafe = this.fileRestoreBlockReason(checkpointId);
    if (unsafe) return unsafe;
    const covered = new Set<string>();
    for (const cp of later) {
      for (const f of [...(cp.acceptedFiles ?? []), ...cp.files]) covered.add(f.path);
      const missing = (cp.skipped ?? []).filter(file => !covered.has(file));
      if (missing.length) return `以下路径缺少可还原的原文：${missing.join("、")}`;
    }
    return undefined;
  }

  /** 统一保护还原、编辑重发和单文件回滚，旧数据不猜测文件归属。 */
  fileRestoreBlockReason(checkpointId?: string, onlyFile?: string): string | undefined {
    if (onlyFile && this.baseline.has(onlyFile)) return '最早还原点已裁剪，无法验证该文件的完整修改链';
    const index = checkpointId ? this.checkpoints.findIndex(cp => cp.id === checkpointId) : 0;
    if (index < 0) return '找不到该还原点';
    const later = this.checkpoints.slice(index);
    const expected = new Map<string, string>();
    const ids = new Set<string>();
    for (const cp of later) {
      // 同一轮点“保留”后继续编辑可能同时出现在两处；只比较不同轮次的衔接。
      const files = [...new Map([...cp.files, ...(cp.acceptedFiles ?? [])].map(file => [file.path, file])).values()]
        .filter(file => !onlyFile || file.path === onlyFile);
      if (!files.length) continue;
      if (!cp.activityId || !cp.snapshotComplete || files.some(file => file.after === undefined))
        return '还原点缺少并行保护或结束时的文件指纹（旧记录或快照未完成），无法安全回滚文件';
      ids.add(cp.activityId);
      for (const file of files) {
        if (expected.has(file.path) && expected.get(file.path) !== contentState(file.content))
          return `轮次之间存在其他来源的修改，已保留文件：${file.path}`;
        expected.set(file.path, file.after!);
      }
    }
    if (!expected.size) return undefined;
    const conflict = WorkspaceActivity.blockReason(this.storageDir, [...ids], [...expected.keys()]);
    if (conflict) return conflict;
    for (const [file, state] of expected) {
      if (fileState(file) !== state) return `快照结束后文件又被修改，已保留当前内容：${file}`;
    }
    return undefined;
  }

  list(): CheckpointSummary[] {
    return this.checkpoints.map((c) => ({
      id: c.id,
      label: c.label,
      createdAt: c.createdAt,
      userText: c.userText,
      fileCount: new Set([...c.files, ...(c.acceptedFiles ?? [])].map(f => f.path)).size,
    }));
  }

  hasAny(): boolean {
    return this.checkpoints.length > 0;
  }

  /** 该还原点记录的截断行数（派生分支用），找不到返回 undefined。 */
  cutLineOf(checkpointId: string): number | undefined {
    return this.checkpoints.find((x) => x.id === checkpointId)?.truncateLine;
  }

  /** The transcript may gain turns after beginTurn read its cached length. Keep
   * the stored cut in sync with the turn that the UI actually matched. */
  alignTurn(checkpointId: string, truncateLine: number): void {
    const c = this.checkpoints.find((x) => x.id === checkpointId);
    if (!c || c.truncateLine === truncateLine) return;
    c.truncateLine = truncateLine;
    this.persist();
  }

  preview(checkpointId: string): { userText: string } | undefined {
    const c = this.checkpoints.find((x) => x.id === checkpointId);
    return c ? { userText: c.label } : undefined;
  }

  /** 还原点元数据（截断行 + 完整提问原文），不产生任何副作用——还原前的
   *  安全校验用它，校验不过时工作区必须原封不动。 */
  metaOf(checkpointId: string): { truncateLine: number; userText: string } | undefined {
    const c = this.checkpoints.find((x) => x.id === checkpointId);
    return c ? { truncateLine: c.truncateLine, userText: c.userText } : undefined;
  }

  /** All file paths touched during this session (incl. pruned-away turns). */
  changedPaths(): string[] {
    const set = new Set<string>(this.baseline.keys());
    for (const c of this.checkpoints) for (const f of c.files) set.add(f.path);
    return [...set];
  }

  restorePaths(checkpointId: string): string[] {
    const index = this.checkpoints.findIndex(cp => cp.id === checkpointId);
    return index < 0 ? [] : [...new Set(this.checkpoints.slice(index)
      .flatMap(cp => [...(cp.acceptedFiles ?? []), ...cp.files].map(file => file.path)))];
  }

  /**
   * Accept a file's changes in the review list, retaining its restore backups.
   */
  accept(path: string): void {
    let changed = this.baseline.delete(path);
    this.baselineSkipped.delete(path);
    for (const c of this.checkpoints) {
      const before = c.files.length;
      const backup = c.files.find(f => f.path === path);
      if (backup && !c.acceptedFiles?.some(f => f.path === path)) (c.acceptedFiles ??= []).push(backup);
      c.files = c.files.filter((f) => f.path !== path);
      if (c.files.length !== before) changed = true;
    }
    if (changed) this.persist();
  }

  /**
   * The session-baseline content of a path: the earliest snapshot taken
   * (i.e. its content before Codex first touched it this session).
   * Returns null if the file did not exist at baseline, undefined if untracked.
   */
  originalOf(path: string): string | null | undefined {
    // Pruned turns hold the TRUE earliest content — check them first.
    if (this.baseline.has(path)) return this.baseline.get(path);
    for (const c of this.checkpoints) {
      const f = c.files.find((x) => x.path === path);
      if (f) return f.content;
    }
    return undefined;
  }

  /**
   * Revert workspace files to the state just before the given checkpoint's
   * turn, and drop that checkpoint and everything after it.
   * Returns the number of files reverted.
   */
  restore(checkpointId: string): { restoredFiles: number; skipped: string[]; userText: string; truncateLine: number } | undefined {
    const idx = this.checkpoints.findIndex((c) => c.id === checkpointId);
    if (idx < 0) return undefined;
    const blocked = this.fileRestoreBlockReason(checkpointId);
    if (blocked) throw new Error(`文件还原检查失败，尚未修改文件或回退对话：${blocked}`);
    const truncateLine = this.checkpoints[idx].truncateLine;
    // Files we could never snapshot (large/binary) keep Codex's edits — collect
    // them so the caller can tell the user instead of claiming a full revert.
    const skippedSet = new Set<string>();
    for (let i = idx; i < this.checkpoints.length; i++) {
      for (const s of this.checkpoints[i].skipped ?? []) skippedSet.add(s);
    }
    // Earliest backup per path across checkpoints[idx..] == pre-turn content.
    const target = new Map<string, string | null>();
    for (let i = idx; i < this.checkpoints.length; i++) {
      for (const b of [...(this.checkpoints[i].acceptedFiles ?? []), ...this.checkpoints[i].files]) {
        if (!target.has(b.path)) target.set(b.path, b.content);
      }
    }
    for (const file of target.keys()) skippedSet.delete(file);
    // 先检查全部目标，避免直到第二个文件才发现目录/链接冲突，留下半还原状态。
    const before = new Map<string, { backup: string; mode: number } | null>();
    let backupDir: string | undefined;
    const clearBackups = () => {
      if (backupDir) try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (error) { operationFailure('checkpoint.cleanup', error, { checkpointId }); }
    };
    try {
      for (const file of target.keys()) {
        let stat: fs.Stats | undefined;
        try { stat = fs.lstatSync(file); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
        if (stat && !stat.isFile()) throw new Error(`${file} 已变为目录或符号链接`);
        if (stat) {
          if (!backupDir) {
            fs.mkdirSync(this.storageDir, { recursive: true });
            backupDir = fs.mkdtempSync(path.join(this.storageDir, "restore-"));
          }
          // 备份当前内容到磁盘，避免后续生成的大文件占满扩展宿主内存。
          const backup = path.join(backupDir, String(before.size));
          fs.copyFileSync(file, backup);
          before.set(file, { backup, mode: stat.mode });
        } else before.set(file, null);
      }
      // 备份期间其他窗口可能开始任务或改文件；实际写入之前再校验一次。
      const changed = this.fileRestoreBlockReason(checkpointId);
      if (changed) throw new Error(changed);
    } catch (err) {
      clearBackups();
      this.flush();
      throw new Error(`文件还原检查失败，尚未修改文件：${String(err)}`);
    }
    // 最早保留点未必是会话开头：被裁剪轮次的改动在该点之前，不能回滚。
    // baseline 只供“已更改文件”的会话级回滚使用，仍需保留。
    let restored = 0;
    const touched: string[] = [];
    let failure: unknown;
    for (const [p, content] of target) {
      try {
        touched.push(p);
        if (content === null) {
          if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            restored++;
          }
        } else {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, content, "utf8");
          restored++;
        }
      } catch (err) {
        failure = `${p}（${String(err)}）`;
        break;
      }
    }
    if (failure) {
      const recoveryFailed: string[] = [];
      for (const file of touched.reverse()) {
        try {
          const previous = before.get(file)!;
          if (previous === null) fs.rmSync(file, { force: true });
          else {
            fs.copyFileSync(previous.backup, file);
            fs.chmodSync(file, previous.mode);
          }
        } catch (error) { operationFailure('checkpoint.restore.recovery', error, { checkpointId }); recoveryFailed.push(file); }
      }
      if (!recoveryFailed.length) { clearBackups(); operationLog('checkpoint.restore', 'recovered', { checkpointId }); }
      this.flush();
      throw new Error(`文件还原失败：${failure}。${recoveryFailed.length
        ? `以下文件未能恢复到操作前状态，请检查：${recoveryFailed.join("、")}。操作前备份保留在 ${backupDir ?? "无备份（原文件不存在）"}`
        : "已恢复到本次操作前的文件内容"}。还原点已保留，可重试。`);
    }
    clearBackups();

    const userText = this.checkpoints[idx].userText;
    this.checkpoints = this.checkpoints.slice(0, idx);
    this.persist();
    return { restoredFiles: restored, skipped: [...skippedSet], userText, truncateLine };
  }

  /** 合成还原点（该轮没有文件快照）回退对话时用：截点及之后的真实还原点随被丢弃
   *  的轮次一起作废；它们的最早快照折进 baseline，保住「已更改文件」的回滚原文。 */
  pruneFrom(cutLine: number): void {
    const keep: Checkpoint[] = [];
    let changed = false;
    for (const c of this.checkpoints) {
      if (c.truncateLine < cutLine) {
        keep.push(c);
        continue;
      }
      changed = true;
      for (const f of c.files) if (!this.baseline.has(f.path)) this.baseline.set(f.path, f.content);
      for (const x of c.skipped ?? []) this.baselineSkipped.add(x);
    }
    if (!changed) return;
    this.checkpoints = keep;
    this.persist();
  }

  clear(): void {
    this.finishWorkspaceActivity();
    this.checkpoints = [];
    this.baseline.clear();
    this.baselineSkipped.clear();
    this.persist();
  }

  /** 还原 = 派生出新会话替换旧会话后，还原点随之迁移：fork 只复制链记录，行号与原
   *  文件不同，这里按「同一段提问文本」（纯图片轮次按「带图且无正文」）在新文件里
   *  单调向前匹配，把 truncateLine 重对齐为该提问所在行之前的行数；对不上的还原点
   *  已无法安全还原，直接丢弃。随后把持久化文件切到新会话、删除旧文件。 */
  migrateTo(newSessionId: string, turns: { text: string; hasImages: boolean; line: number }[]): void {
    const old = this.sessionId;
    this.checkpoints = CheckpointManager.rebase(this.checkpoints, turns);
    this.sessionId = newSessionId;
    this.persist();
    if (old && old !== newSessionId) CheckpointManager.deleteFor(this.storageDir, old);
  }

  /** 按提问文本把还原点的 truncateLine 重对齐到另一份 transcript（单调向前匹配；
   *  纯图片轮次按「带图且无正文」）；对不上的丢弃。 */
  private static rebase(cps: Checkpoint[], turns: { text: string; hasImages: boolean; line: number }[]): Checkpoint[] {
    const norm = checkpointTextKey;
    const kept: Checkpoint[] = [];
    let from = 0;
    for (const c of cps) {
      let hit = -1;
      for (let k = from; k < turns.length; k++) {
        const t = turns[k];
        // 回答（尤其是遮蔽后的秘密答案）可能完全相同；只认原轮次边界。
        if (c.userText.startsWith(QUESTION_REPLY_PREFIX) && t.line - 1 !== c.truncateLine) continue;
        const ok = c.userText === "(图片)" ? t.hasImages && !norm(t.text) : norm(t.text) === norm(c.userText);
        if (ok) {
          hit = k;
          break;
        }
      }
      if (hit < 0) continue;
      c.truncateLine = turns[hit].line - 1;
      kept.push(c);
      from = hit + 1;
    }
    return kept;
  }

  /** 派生会话：把「截断点之前」的还原点复制给新会话并按新文件的提问行重对齐（新会话
   *  由 Codex thread/fork 生成，按轮次索引重新对齐）。baseline 一并带上。 */
  static forkFor(
    storageDir: string,
    srcSessionId: string,
    destSessionId: string,
    maxTruncateLine: number,
    turns: { text: string; hasImages: boolean; line: number }[],
  ): boolean {
    try {
      const raw = fs.readFileSync(path.join(storageDir, `checkpoints-${srcSessionId}.json`), "utf8");
      const j = JSON.parse(raw) as { checkpoints?: Checkpoint[]; baseline?: unknown; baselineSkipped?: unknown };
      const prefix = (j.checkpoints ?? []).filter((c) => typeof c.truncateLine === "number" && c.truncateLine < maxTruncateLine);
      const payload = { checkpoints: CheckpointManager.rebase(prefix, turns), baseline: j.baseline ?? [], baselineSkipped: j.baselineSkipped ?? [] };
      fs.writeFileSync(path.join(storageDir, `checkpoints-${destSessionId}.json`), JSON.stringify(payload), { mode: 0o600 });
      return true;
    } catch (error) {
      if (!expectedFileError(error)) operationFailure('checkpoint.fork', error);
      return false;
    }
  }

  /** Force any debounced snapshot write to disk (window closing / disposal). */
  flush(): void {
    if (this.persistTimer || this.persistFailureId) this.persist();
  }

  private current(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  private file(): string {
    return path.join(this.storageDir, `checkpoints-${this.sessionId ?? "none"}.json`);
  }

  /** Delete the persisted checkpoint file of a session (used when the session
   *  itself is deleted — otherwise globalStorage grows forever). */
  static deleteFor(storageDir: string, sessionId: string): void {
    try {
      fs.unlinkSync(path.join(storageDir, `checkpoints-${sessionId}.json`));
    } catch (error) {
      if (!expectedFileError(error)) operationFailure('checkpoint.delete', error);
    }
  }

  private load(): void {
    this.checkpoints = [];
    this.baseline = new Map();
    this.baselineSkipped = new Set();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8"));
      // Legacy files are a bare array; new ones carry the folded baseline too.
      if (Array.isArray(raw)) {
        this.checkpoints = raw;
      } else if (raw && Array.isArray(raw.checkpoints)) {
        this.checkpoints = raw.checkpoints;
        for (const [p, c] of raw.baseline ?? []) this.baseline.set(p, c);
        for (const s of raw.baselineSkipped ?? []) this.baselineSkipped.add(s);
      }
    } catch (error) {
      if (!expectedFileError(error)) operationFailure('checkpoint.load', error);
    }
  }

  private persistTimer?: ReturnType<typeof setTimeout>;
  private persistFailureId?: string;

  /** Debounced persist for high-frequency snapshot writes. */
  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, 500);
  }

  private persist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    let temporary: string | undefined;
    const operationId = this.persistFailureId ?? randomUUID();
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      const payload = {
        checkpoints: this.checkpoints,
        baseline: [...this.baseline],
        baselineSkipped: [...this.baselineSkipped],
      };
      temporary = this.file() + '.' + randomUUID() + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(temporary, this.file());
      operationLog('checkpoint.persist', this.persistFailureId ? 'recovered' : 'completed', { operationId });
      this.persistFailureId = undefined;
    } catch (error) {
      this.persistFailureId = operationId;
      operationFailure('checkpoint.persist', error, { operationId });
    } finally {
      if (temporary) try { fs.unlinkSync(temporary); } catch (error) {
        if (!expectedFileError(error)) operationFailure('checkpoint.cleanup', error);
      }
    }
  }
}

export function shortLabel(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? t.slice(0, 48) + "…" : t || "(空消息)";
}

function contentState(content: string | null): string {
  return content === null ? 'missing' : createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 有界读取，包含二进制；不跟随符号链接，不给超大文件生成不可靠的结束指纹。 */
function fileState(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return undefined;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const same = (other: fs.Stats) => other.isFile() && stat.dev === other.dev && stat.ino === other.ino &&
        stat.size === other.size && stat.mtimeMs === other.mtimeMs && stat.ctimeMs === other.ctimeMs;
      if (!same(fs.fstatSync(fd))) return undefined;
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      while (size <= stat.size) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size + 1 - size), null);
        if (!count) break;
        size += count;
        hash.update(buffer.subarray(0, count));
      }
      if (size !== stat.size || !same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) return undefined;
      return hash.digest('hex');
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'missing';
    return undefined;
  }
}
