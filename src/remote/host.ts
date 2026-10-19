import type { CodexProcess } from '../codex/process';
import type { SessionStore } from '../codex/session';
import type { ChangedFile, CheckpointSummary, ModelChoice, SpeedMode, ToWebview } from '../shared';
import type { RemoteRegistration } from './bridgeClient';
import type { ReceiptStorage } from './executionReceipts';

/** 远程接入只依赖此宿主契约，不引用 VS Code、Webview 或 ChatViewProvider。 */
export interface RemoteSession {
    sessionId?: string;
    checkpoints: object;
    proc?: Pick<CodexProcess, 'isBusy' | 'currentTurnId'>;
    sending?: boolean;
    pendingPerm?: ToWebview;
    answeringQuestion?: boolean;
    compacting?: boolean;
    compactionPreparing?: boolean;
    lastUserText?: string;
}

export interface RemoteSessionHost<C extends RemoteSession> {
    readonly receipts?: ReceiptStorage;
    readonly disposed: boolean;
    readonly store: Pick<SessionStore, 'list' | 'load' | 'hydrate' | 'setCustomTitle'>;
    readonly modelCatalog: ModelChoice[];
    readonly lastUsage?: ToWebview;
    readonly lastUsageUpdatedAt: number;
    registration(): RemoteRegistration | undefined;
    contexts(): C[];
    cwd(): string;
    openSession(): Promise<C>;
    markPrivate(ctx: C): Promise<void>;
    isRestoring(ctx: C): boolean;
    isForking(ctx: C): boolean;
    setRestoring(ctx: C, value: boolean): void;
    pinnedSet(): Set<string>;
    setPinned(id: string, pinned: boolean): Promise<void>;
    refreshSessions(): void;
    deleteSessions(ids: string[], confirmed: boolean): Promise<void>;
    compactSession(ctx: C): Promise<void>;
    checkpointsForView(ctx: C, id: string): CheckpointSummary[];
    editMessageRewind(ctx: C, checkpointId: string): Promise<boolean>;
    reloadSession(ctx: C): Promise<void>;
    post(ctx: C, event: ToWebview): void;
    handleSend(ctx: C, text: string, context?: string, images?: {mediaType: string; data: string}[], files?: string[], allowed?: () => boolean, queueMs?: number): Promise<boolean>;
    getChangedFiles(ctx: C): Promise<{files: ChangedFile[]; totalAdded: number; totalRemoved: number}>;
    sessionModel(ctx: C): string;
    sessionEffort(ctx: C): string;
    speedMode(ctx: C): SpeedMode;
    setModel(ctx: C, value: string, allowed: () => boolean): Promise<void>;
    setEffort(ctx: C, value: string, allowed: () => boolean): Promise<void>;
    setSpeedMode(ctx: C, value: SpeedMode, allowed: () => boolean): Promise<void>;
    handlePermission(ctx: C, id: string, decision: 'allow' | 'deny'): boolean;
    submitQuestionAnswer(ctx: C, id: string, answers: Record<string, string | string[]>, allowed: () => boolean): Promise<void>;
    fetchUsage(): void;
    stopContext(ctx: C): Promise<void>;
    publish(sessionId: string, event: Record<string, unknown>): void;
}
