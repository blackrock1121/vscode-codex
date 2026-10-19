import { randomUUID } from 'node:crypto';
/** 最终出口的独立反馈。只接收固定通道名/标准错误码，不递归调用业务日志。 */
export class DiagnosticHealth {
  private failures = 0;
  private operationId?: string;
  constructor(private readonly channel: string, private readonly fallback: (line: string) => void = line => console.warn(line)) {}
  failed(error: unknown): void {
    this.failures++;
    if (this.failures !== 1) return;
    this.operationId = randomUUID();
    const code = (error as NodeJS.ErrnoException)?.code;
    const line = `[logging] ${JSON.stringify({ atMs: Date.now(), operation: this.channel, operationId: this.operationId, stage: 'failed',
      errorCode: typeof code === 'string' && /^E[A-Z0-9_]{1,48}$/.test(code) ? code : undefined })}`;
    try { this.fallback(line); } catch { /* 独立最终出口也已不可用，不再递归。 */ }
  }
  recovered(write: (line: string) => void): void {
    if (!this.failures) return;
    write(`[logging] ${JSON.stringify({ atMs: Date.now(), operation: this.channel, operationId: this.operationId, stage: 'recovered', lostRecords: this.failures })}`);
    this.failures = 0; this.operationId = undefined;
  }
}
