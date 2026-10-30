import { postWebviewMessage } from '../webviewDelivery';
import { operationFailure, operationLog } from '../operations';
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { DiagnosticJobs } from './jobs';
import { DiagnosticOptions, DEFAULT_DIAGNOSTIC_OPTIONS, diagnosticOptions } from './options';
import type { DiagnosticConfiguration } from './configuration';

export class DiagnosticsPage {
  private panel?: vscode.WebviewPanel;
  private selected?: string;
  private revealId?: string;
  private ready = false;
  private refreshSequence = 0;
  private refreshFailure?: string;
  private selectionSequence = 0;
  private refreshTimer?: NodeJS.Timeout;
  private readonly changed = () => {
    if (!this.panel || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.refresh(); }, 75);
    this.refreshTimer.unref();
  };
  constructor(private readonly context: vscode.ExtensionContext, private readonly jobs: DiagnosticJobs,
    private readonly repair: (id: string) => Promise<void>, private readonly settings: () => Promise<void>,
    private readonly configuration?: { load: (forceModels?: boolean) => Promise<DiagnosticConfiguration>; save: (options: DiagnosticOptions) => Promise<void> }) {
    jobs.on('changed', this.changed);
  }
  show(start = true, id?: string): void {
    if (typeof id === 'string') this.revealId = id;
    const existed = !!this.panel;
    if (this.panel) this.panel.reveal(this.panel.viewColumn);
    else {
      this.ready = false;
      const panel = vscode.window.createWebviewPanel('codex-chat.diagnostics', '插件诊断中心', vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
      this.panel = panel;
      const nonce = randomUUID().replace(/-/g, '');
      panel.webview.html = diagnosticsHtml(nonce, panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'diagnostics.js')).toString());
      panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.ready = false; this.revealId = undefined; this.selectionSequence++; clearTimeout(this.refreshTimer); this.refreshTimer = undefined; } });
      panel.webview.onDidReceiveMessage(message => { void this.message(message).catch(error => this.error(error)); });
    }
    if (start) void this.begin().catch(error => this.error(error));
    else if (existed) void this.refresh();
  }
  private async begin(settings?: unknown): Promise<void> {
    const options = diagnosticOptions(settings ?? (this.configuration ? (await this.configuration.load()).options : DEFAULT_DIAGNOSTIC_OPTIONS));
    await this.configuration?.save(options);
    const record = await this.jobs.start(options); this.selected = record.id;
    await this.refresh();
    postWebviewMessage(this.panel?.webview, { type: 'started', id: record.id });
  }
  private async message(message: { type?: string; id?: string; options?: unknown; category?: unknown }): Promise<void> {
    switch (message?.type) {
      case 'webviewError': {
        const category = typeof message.category === 'string' ? message.category : '';
        const match = /^(webview\.(?:runtime|unhandledrejection)): (Error|TypeError|RangeError|SyntaxError|ReferenceError|AbortError)$/.exec(category);
        const error = new Error('页面脚本异常');
        if (match) error.name = match[2];
        operationFailure('diagnostics.webview', error, { phase: match?.[1] ?? 'webview.runtime' });
        break;
      }
      case 'ready': {
        const panel = this.panel;
        this.ready = true;
        await this.refresh();
        if (this.configuration) void this.configuration.load().then(config => { if (this.panel === panel) postWebviewMessage(panel?.webview, { type: 'configuration', ...config }); }).catch(error => { if (this.panel === panel) this.error(error); });
        break;
      }
      case 'refresh': await this.refresh(); break;
      case 'start': await this.begin(message.options); break;
      case 'configure': await this.configuration?.save(diagnosticOptions(message.options)); break;
      case 'reloadModels': {
        const panel = this.panel;
        if (this.configuration) {
          const config = await this.configuration.load(true);
          if (panel === this.panel) postWebviewMessage(panel?.webview, { type: 'configuration', ...config });
        }
        break;
      }
      case 'cancel': await this.jobs.cancel(message.id!); break;
      case 'collapse': this.selectionSequence++; this.selected = undefined; break;
      case 'select': {
        const selection = ++this.selectionSequence, panel = this.panel;
        const record = await this.jobs.get(message.id!);
        if (selection !== this.selectionSequence || panel !== this.panel) break;
        this.selected = record.id;
        if (record.status !== 'completed') { await this.refresh(); break; }
        const report = await this.jobs.report(record.id);
        if (selection === this.selectionSequence && panel === this.panel) postWebviewMessage(panel?.webview, { type: 'detail', id: record.id, report }); break;
      }
      case 'repair': await this.repair(message.id!); await this.refresh(); break;
      case 'notify': await this.jobs.retryNotification(message.id!); await this.refresh(); break;
      case 'settings': await this.settings(); break;
    }
  }
  private async refresh(): Promise<void> {
    const panel = this.panel; if (!panel) return;
    const sequence = ++this.refreshSequence;
    try {
      const records = await this.jobs.list();
      if (sequence !== this.refreshSequence || panel !== this.panel) return;
      if (!records.some(r => r.id === this.selected)) this.selected = undefined;
      postWebviewMessage(panel.webview, { type: 'state', records, selectedId: this.selected, workspaceId: this.jobs.scope.workspaceId, warning: this.jobs.listWarning });
      if (this.ready && this.revealId) {
        const id = this.revealId; this.revealId = undefined;
        if (records.some(record => record.id === id)) postWebviewMessage(panel.webview, { type: 'reveal', id });
        else this.error(new Error('该通知对应的诊断记录已不存在。'));
      }
      if (this.refreshFailure) { operationLog('diagnostics.page.refresh', 'recovered', { operationId: this.refreshFailure }); this.refreshFailure = undefined; }
    } catch (error) {
      if (sequence !== this.refreshSequence || panel !== this.panel) { operationFailure('diagnostics.page.refresh', error, { stale: true }); return; }
      this.refreshFailure ??= randomUUID();
      operationFailure('diagnostics.page.refresh', error, { operationId: this.refreshFailure });
      postWebviewMessage(panel.webview, { type: 'error', message: error instanceof Error ? error.message : '刷新未完成，请重试。' });
    }
  }
  private error(error: unknown): void {
    operationFailure('diagnostics.page', error);
    postWebviewMessage(this.panel?.webview, { type: 'error', message: error instanceof Error ? error.message : '操作未完成，请重试。' });
  }
  dispose(): void { this.jobs.off('changed', this.changed); clearTimeout(this.refreshTimer); this.refreshTimer = undefined; this.panel?.dispose(); }
}

export function diagnosticsHtml(nonce: string, script: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px/1.6 var(--vscode-font-family);height:100vh;display:flex;flex-direction:column}
header{padding:20px 24px 15px;border-bottom:1px solid var(--vscode-panel-border);display:flex;gap:16px;align-items:center;flex-wrap:wrap}h1{font-size:20px;margin:0;font-weight:600}header p{margin:4px 0 0;color:var(--vscode-descriptionForeground)}.heading{flex:1;min-width:220px}
button{font:inherit;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);border-radius:5px;padding:5px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
#banner{margin:0;padding:9px 24px;background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-inputValidation-warningForeground)}#banner[hidden]{display:none}[hidden]{display:none!important}.layout{flex:1;min-height:0;overflow:auto;padding:18px 24px}.history{max-width:1100px;margin:0 auto}.history-heading{display:flex;align-items:center;gap:10px;margin-bottom:10px}.history-heading h2{margin:0}.history-hint{margin:0 0 14px}.filter{margin-bottom:14px}input,select{width:100%;padding:6px 8px;border:1px solid var(--vscode-input-border,transparent);color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit}#records{display:flex;flex-direction:column;gap:10px}.record-entry{border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden;flex-shrink:0}.record-entry.expanded{border-color:var(--vscode-focusBorder)}.record{display:block;width:100%;text-align:left;padding:14px 16px;background:transparent;color:inherit;border:0;border-radius:0}.record:hover{background:var(--vscode-list-hoverBackground)}.record:focus-visible{outline-offset:-2px}.record-entry.expanded>.record{background:var(--vscode-list-inactiveSelectionBackground)}.record-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.record-toggle{margin-left:auto;font-size:12px;color:var(--vscode-textLink-foreground)}.record small{display:block;overflow-wrap:anywhere}.record-summary{margin-top:6px}.muted{color:var(--vscode-descriptionForeground);font-size:12px}.status{font-size:11px;opacity:.9}#detail{padding:18px 20px;border-top:1px solid var(--vscode-panel-border);min-width:0;overflow-wrap:anywhere}.detail-heading{display:flex;justify-content:space-between;align-items:start;gap:12px;flex-wrap:wrap}.detail-heading button{flex-shrink:0}h2{margin:0 0 10px;font-size:19px}h3{font-size:14px;margin:0 0 6px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.stats{display:flex;gap:20px;flex-wrap:wrap;padding:14px 0}.stat b{font-size:23px;display:block}.finding{border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-editorWarning-foreground,#cca700);border-radius:6px;padding:13px 15px;margin:12px 0}.finding.error{border-left-color:var(--vscode-errorForeground)}.finding p{margin:4px 0;white-space:pre-wrap}.progress{padding:16px;border:1px solid var(--vscode-panel-border);border-radius:6px;margin:14px 0}.report{overflow-wrap:anywhere}.report table{display:block;overflow:auto;border-collapse:collapse;font-size:12px}.report th,.report td{padding:5px 9px;border:1px solid var(--vscode-panel-border);text-align:left}.report pre{white-space:pre-wrap}.report h1{font-size:18px}.report h2{font-size:16px;margin-top:22px}.report h3{font-size:14px;margin-top:16px}details{margin-top:24px}summary{cursor:pointer;font-weight:600}code{font-family:var(--vscode-editor-font-family)}@media(max-width:650px){.layout{padding:14px 12px}#detail{padding:16px 12px}header{padding:16px}.record{padding:12px}}
.controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;padding:14px 24px;border-bottom:1px solid var(--vscode-panel-border)}.controls label{display:grid;gap:4px;font-size:12px;min-width:130px}.controls select{width:auto;max-width:260px}.controls .model-choice{min-width:200px}.controls .model-choice select{width:100%}.engine-note{padding:0 24px 12px;margin:0;font-size:12px;color:var(--vscode-descriptionForeground)}
</style></head><body><header><div class="heading"><h1>插件诊断中心</h1><p>全面诊断同时检查源码日志覆盖、运行错误、稳定性与速度；即使没有报错日志，也检查未记录的代码路径。后台完成后按全局通知设置提醒。</p></div><button id="start">开始诊断</button><button id="refresh" class="secondary">刷新记录</button></header>
<div class="controls" aria-label="诊断设置"><label>诊断类型<select id="diagnostic-kind"><option value="general">全面诊断（含速度与日志覆盖）</option><option value="performance">速度诊断</option></select></label><label>时间范围<select id="diagnostic-hours"><option value="24">最近 24 小时</option><option value="168">最近 7 天</option><option value="0">全部保留日志</option></select></label><label>诊断方式<select id="diagnostic-engine"><option value="model">模型诊断 + 本地检查</option><option value="rules">仅本地规则检查</option></select></label><label class="model-choice">诊断模型<select id="diagnostic-model" aria-label="诊断模型"><option value="">正在加载模型…</option></select></label><label>reasoning effort<select id="diagnostic-effort" aria-label="reasoning effort"><option value="">正在加载…</option></select></label><button id="reload-models" class="secondary">刷新模型</button></div>
<p id="engine-note" class="engine-note">模型诊断会使用当前 Codex 账号额度，将脱敏后的异常摘要和性能证据发送给所选模型；完整原始日志不上传。</p>
<div id="banner" role="status" hidden></div><main class="layout" tabindex="-1"><section id="history" class="history" aria-label="诊断记录"><div class="history-heading"><h2>诊断记录</h2><span id="record-count" class="muted"></span></div><p class="muted history-hint">每次诊断单独保存，点击记录展开或收起详情。可随时在上方开始新的诊断。</p><div class="filter"><input id="search" aria-label="搜索诊断记录" placeholder="搜索编号、项目或版本"></div><div id="records" aria-label="诊断记录"><p class="muted">正在加载记录…</p></div><section id="detail" role="region" hidden></section></section></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
