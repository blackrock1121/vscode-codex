import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { DiagnosticJobs } from './jobs';
import { DiagnosticOptions, DEFAULT_DIAGNOSTIC_OPTIONS, diagnosticOptions } from './options';
import type { ModelChoice } from '../shared';
export interface DiagnosticConfiguration { models: ModelChoice[]; options: DiagnosticOptions }

export class DiagnosticsPage {
  private panel?: vscode.WebviewPanel;
  private selected?: string;
  private refreshSequence = 0;
  private readonly changed = () => { if (this.panel) void this.refresh(); };
  constructor(private readonly context: vscode.ExtensionContext, private readonly jobs: DiagnosticJobs,
    private readonly repair: (id: string) => Promise<void>, private readonly settings: () => Promise<void>,
    private readonly configuration?: { load: () => Promise<DiagnosticConfiguration>; save: (options: DiagnosticOptions) => Promise<void> }) {
    jobs.on('changed', this.changed);
  }
  show(start = true): void {
    if (this.panel) this.panel.reveal(this.panel.viewColumn);
    else {
      const panel = vscode.window.createWebviewPanel('codex-chat.diagnostics', '插件诊断中心', vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
      this.panel = panel;
      const nonce = randomUUID().replace(/-/g, '');
      panel.webview.html = diagnosticsHtml(nonce, panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'diagnostics.js')).toString());
      panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
      panel.webview.onDidReceiveMessage(message => { void this.message(message).catch(error => this.error(error)); });
    }
    if (start) void this.begin().catch(error => this.error(error));
    else void this.refresh();
  }
  private async begin(settings?: unknown): Promise<void> {
    const options = diagnosticOptions(settings ?? (this.configuration ? (await this.configuration.load()).options : DEFAULT_DIAGNOSTIC_OPTIONS));
    await this.configuration?.save(options);
    const record = await this.jobs.start(options); this.selected = record.id;
    await this.refresh();
    this.panel?.webview.postMessage({ type: 'started' });
  }
  private async message(message: { type?: string; id?: string; options?: unknown }): Promise<void> {
    switch (message?.type) {
      case 'ready':
        await this.refresh();
        if (this.configuration) void this.configuration.load().then(config => this.panel?.webview.postMessage({ type: 'configuration', ...config })).catch(error => this.error(error));
        break;
      case 'refresh': await this.refresh(); break;
      case 'start': await this.begin(message.options); break;
      case 'configure': await this.configuration?.save(diagnosticOptions(message.options)); break;
      case 'reloadModels': if (this.configuration) this.panel?.webview.postMessage({ type: 'configuration', ...await this.configuration.load() }); break;
      case 'cancel': await this.jobs.cancel(message.id!); break;
      case 'select': {
        const record = await this.jobs.get(message.id!); this.selected = record.id;
        if (record.status !== 'completed') { await this.refresh(); break; }
        const report = await this.jobs.report(record.id);
        this.panel?.webview.postMessage({ type: 'detail', id: record.id, report }); break;
      }
      case 'repair': await this.repair(message.id!); await this.refresh(); break;
      case 'notify': await this.jobs.retryNotification(message.id!); await this.refresh(); break;
      case 'settings': await this.settings(); break;
    }
  }
  private async refresh(): Promise<void> {
    const sequence = ++this.refreshSequence;
    try {
      const records = await this.jobs.list();
      if (sequence !== this.refreshSequence) return;
      if (!records.some(r => r.id === this.selected)) this.selected = records[0]?.id;
      this.panel?.webview.postMessage({ type: 'state', records, selectedId: this.selected, workspaceId: this.jobs.scope.workspaceId });
    } catch (error) { this.error(error); }
  }
  private error(error: unknown): void {
    this.panel?.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : '操作未完成，请重试。' });
  }
  dispose(): void { this.jobs.off('changed', this.changed); this.panel?.dispose(); }
}

export function diagnosticsHtml(nonce: string, script: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px/1.6 var(--vscode-font-family);height:100vh;display:flex;flex-direction:column}
header{padding:20px 24px 15px;border-bottom:1px solid var(--vscode-panel-border);display:flex;gap:16px;align-items:center;flex-wrap:wrap}h1{font-size:20px;margin:0;font-weight:600}header p{margin:4px 0 0;color:var(--vscode-descriptionForeground)}.heading{flex:1;min-width:220px}
button{font:inherit;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);border-radius:5px;padding:5px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
#banner{margin:0;padding:9px 24px;background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-inputValidation-warningForeground)}#banner[hidden]{display:none}.layout{flex:1;display:grid;grid-template-columns:280px minmax(0,1fr);min-height:0}aside{border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;min-height:0}.filter{padding:12px}input,select{width:100%;padding:6px 8px;border:1px solid var(--vscode-input-border,transparent);color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit}#records{overflow:auto;padding:0 8px 12px}.record{display:block;width:100%;text-align:left;padding:12px;margin:3px 0;background:transparent;color:inherit;border:1px solid transparent;border-radius:6px}.record:hover{background:var(--vscode-list-hoverBackground)}.record.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border-color:var(--vscode-focusBorder)}.record b{font-size:12px}.muted{color:var(--vscode-descriptionForeground);font-size:12px}.record.selected .muted{color:inherit;opacity:.8}.record small{display:block}.status{display:inline-block;margin-left:8px;font-size:11px;opacity:.9}main{overflow:auto;padding:22px 28px;min-width:0}h2{margin:0 0 10px;font-size:19px}h3{font-size:14px;margin:0 0 6px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.stats{display:flex;gap:20px;flex-wrap:wrap;padding:14px 0}.stat b{font-size:23px;display:block}.finding{border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-editorWarning-foreground,#cca700);border-radius:6px;padding:13px 15px;margin:12px 0}.finding.error{border-left-color:var(--vscode-errorForeground)}.finding p{margin:4px 0;white-space:pre-wrap}.empty{padding:36px 0;color:var(--vscode-descriptionForeground)}.progress{padding:16px;border:1px solid var(--vscode-panel-border);border-radius:6px;margin:14px 0}.report{overflow-wrap:anywhere}.report table{display:block;overflow:auto;border-collapse:collapse;font-size:12px}.report th,.report td{padding:5px 9px;border:1px solid var(--vscode-panel-border);text-align:left}.report pre{white-space:pre-wrap}.report h1{font-size:18px}.report h2{font-size:16px;margin-top:22px}.report h3{font-size:14px;margin-top:16px}details{margin-top:24px}summary{cursor:pointer;font-weight:600}code{font-family:var(--vscode-editor-font-family)}@media(max-width:650px){.layout{grid-template-columns:1fr;overflow:auto}aside{max-height:260px;border-right:0;border-bottom:1px solid var(--vscode-panel-border)}main{overflow:visible;padding:18px}header{padding:16px}.layout main{min-height:300px}}
.controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;padding:14px 24px;border-bottom:1px solid var(--vscode-panel-border)}.controls label{display:grid;gap:4px;font-size:12px;min-width:130px}.controls select{width:auto;max-width:260px}.controls .model-choice{min-width:200px}.controls .model-choice select{width:100%}.engine-note{padding:0 24px 12px;margin:0;font-size:12px;color:var(--vscode-descriptionForeground)}
</style></head><body><header><div class="heading"><h1>插件诊断中心</h1><p>检查本机整个插件的错误、压缩、稳定性与速度，跨工作区、窗口、会话和版本。后台完成后发送飞书通知。</p></div><button id="start">开始诊断</button><button id="refresh" class="secondary">刷新记录</button></header>
<div class="controls" aria-label="诊断设置"><label>诊断类型<select id="diagnostic-kind"><option value="general">全面诊断</option><option value="performance">速度诊断</option></select></label><label>时间范围<select id="diagnostic-hours"><option value="24">最近 24 小时</option><option value="168">最近 7 天</option><option value="0">全部保留日志</option></select></label><label>诊断方式<select id="diagnostic-engine"><option value="model">模型诊断 + 本地检查</option><option value="rules">仅本地规则检查</option></select></label><label class="model-choice">诊断模型<select id="diagnostic-model" aria-label="诊断模型"><option value="">正在加载模型…</option></select></label><label>reasoning effort<select id="diagnostic-effort" aria-label="reasoning effort"><option value="">正在加载…</option></select></label><button id="reload-models" class="secondary">刷新模型</button></div>
<p id="engine-note" class="engine-note">模型诊断会使用当前 Codex 账号额度，将脱敏后的异常摘要和性能证据发送给所选模型；完整原始日志不上传。</p>
<div id="banner" role="status" hidden></div><div class="layout"><aside><div class="filter"><input id="search" aria-label="搜索诊断记录" placeholder="搜索编号、项目或版本"></div><div id="records" aria-label="诊断记录"><p class="muted">正在加载记录…</p></div></aside><main id="detail"><p class="empty">正在准备诊断页面…</p></main></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
