export interface ChildThread {
  id: string; parentThreadId: string; sessionId: string; label: string;
  active: boolean; turnId?: string; endedTurns: Set<string>;
}

/** 仅信任服务端给出的父子关系；工作目录、昵称和共享 sessionId 本身都不足以放行。 */
export class ChildThreadRegistry {
  private rootId?: string;
  private sessionId?: string;
  private readonly threads = new Map<string, ChildThread>();
  setRoot(thread: { id: string; sessionId?: string }): void {
    if (this.rootId !== thread.id) this.clear();
    this.rootId = thread.id;
    this.sessionId = thread.sessionId || thread.id;
  }
  register(thread: any, starting = false): boolean {
    if (!thread || typeof thread.id !== 'string' || !thread.id || thread.id === this.rootId ||
        typeof thread.parentThreadId !== 'string' || thread.sessionId !== this.sessionId ||
        (thread.parentThreadId !== this.rootId && !this.threads.has(thread.parentThreadId))) return false;
    const previous = this.threads.get(thread.id);
    if (previous && previous.parentThreadId !== thread.parentThreadId) return false;
    const title = [thread.agentNickname, thread.agentRole, thread.name].find(x => typeof x === 'string' && x.trim());
    const label = title ? `子任务 ${title.trim().slice(0, 60)}` : `子任务 ${thread.id.slice(0, 8)}`;
    this.threads.set(thread.id, previous ? { ...previous, label } : {
      id: thread.id, parentThreadId: thread.parentThreadId, sessionId: thread.sessionId, label,
      active: starting || thread.status?.type === 'active', endedTurns: new Set(),
    });
    return true;
  }
  has(id: string): boolean { return this.threads.has(id); }
  get(id: string): ChildThread | undefined { return this.threads.get(id); }
  isCurrent(id: string, turnId?: string): boolean {
    const thread = this.threads.get(id);
    return !!thread && (!turnId || (!thread.endedTurns.has(turnId) && (!thread.turnId || thread.turnId === turnId)));
  }
  started(id: string, turnId?: string): boolean {
    const thread = this.threads.get(id);
    if (!thread || (turnId && thread.endedTurns.has(turnId))) return false;
    thread.active = true;
    if (turnId) thread.turnId = turnId;
    return true;
  }
  completed(id: string, turnId?: string): boolean {
    const thread = this.threads.get(id);
    if (!thread || (turnId && thread.turnId && thread.turnId !== turnId)) return false;
    if (turnId) {
      thread.endedTurns.add(turnId);
      if (thread.endedTurns.size > 64) thread.endedTurns.delete(thread.endedTurns.values().next().value!);
    }
    thread.active = false; thread.turnId = undefined;
    return true;
  }
  activeTurns(): { threadId: string; turnId?: string }[] {
    return [...this.threads.values()].filter(t => t.active).map(t => ({ threadId: t.id, turnId: t.turnId }));
  }
  clear(): void { this.threads.clear(); this.rootId = undefined; this.sessionId = undefined; }
}

export function childToolId(threadId: string, itemId: string): string {
  return `child:${JSON.stringify([threadId, itemId])}`;
}
