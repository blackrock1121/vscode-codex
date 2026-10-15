import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { DiagnosticJobs } from './jobs';

export class DiagnosticsPage {
  private panel?: vscode.WebviewPanel;
  private selected?: string;
  private refreshSequence = 0;
  private readonly changed = () => { if (this.panel) void this.refresh(); };
  constructor(private readonly context: vscode.ExtensionContext, private readonly jobs: DiagnosticJobs,
    private readonly repair: (id: string) => Promise<void>, private readonly settings: () => Promise<void>) {
    jobs.on('changed', this.changed);
  }
  show(start = true): void {
    if (this.panel) this.panel.reveal(this.panel.viewColumn);
    else {
      const panel = vscode.window.createWebviewPanel('codex-chat.diagnostics', '速度诊断中心', vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
      this.panel = panel;
      const nonce = randomUUID().replace(/-/g, '');
      panel.webview.html = diagnosticsHtml(nonce, panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'diagnostics.js')).toString());
      panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
      panel.webview.onDidReceiveMessage(message => { void this.message(message).catch(error => this.error(error)); });
    }
    if (start) void this.jobs.start().then(record => { this.selected = record.id; return this.refresh(); }).catch(error => this.error(error));
    else void this.refresh();
  }
  private async message(message: { type?: string; id?: string }): Promise<void> {
    switch (message?.type) {
      case 'ready': case 'refresh': await this.refresh(); break;
      case 'start': this.show(true); break;
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
button{font:inherit;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);border-radius:5px;padding:5px 11px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
#banner{margin:0;padding:9px 24px;background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-inputValidation-warningForeground)}#banner[hidden]{display:none}.layout{flex:1;display:grid;grid-template-columns:280px minmax(0,1fr);min-height:0}aside{border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;min-height:0}.filter{padding:12px}input{width:100%;padding:6px 8px;border:1px solid var(--vscode-input-border,transparent);color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit}#records{overflow:auto;padding:0 8px 12px}.record{display:block;width:100%;text-align:left;padding:12px;margin:3px 0;background:transparent;color:inherit;border:1px solid transparent;border-radius:6px}.record:hover{background:var(--vscode-list-hoverBackground)}.record.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border-color:var(--vscode-focusBorder)}.record b{font-size:12px}.muted{color:var(--vscode-descriptionForeground);font-size:12px}.record.selected .muted{color:inherit;opacity:.8}.record small{display:block}.status{display:inline-block;margin-left:8px;font-size:11px;opacity:.9}main{overflow:auto;padding:22px 28px;min-width:0}h2{margin:0 0 10px;font-size:19px}h3{font-size:14px;margin:0 0 6px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.stats{display:flex;gap:20px;flex-wrap:wrap;padding:14px 0}.stat b{font-size:23px;display:block}.finding{border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-editorWarning-foreground,#cca700);border-radius:6px;padding:13px 15px;margin:12px 0}.finding.error{border-left-color:var(--vscode-errorForeground)}.finding p{margin:4px 0}.empty{padding:36px 0;color:var(--vscode-descriptionForeground)}.progress{padding:16px;border:1px solid var(--vscode-panel-border);border-radius:6px;margin:14px 0}.report{overflow-wrap:anywhere}.report table{display:block;overflow:auto;border-collapse:collapse;font-size:12px}.report th,.report td{padding:5px 9px;border:1px solid var(--vscode-panel-border);text-align:left}.report pre{white-space:pre-wrap}.report h1{font-size:18px}.report h2{font-size:16px;margin-top:22px}.report h3{font-size:14px;margin-top:16px}details{margin-top:24px}summary{cursor:pointer;font-weight:600}code{font-family:var(--vscode-editor-font-family)}@media(max-width:650px){.layout{grid-template-columns:1fr;overflow:auto}aside{max-height:260px;border-right:0;border-bottom:1px solid var(--vscode-panel-border)}main{overflow:visible;padding:18px}header{padding:16px}.layout main{min-height:300px}}
</style></head><body><header><div class="heading"><h1>速度诊断中心</h1><p>后台分析日志并保存记录，关闭页面后仍会继续。完成后发送飞书通知。</p></div><button id="start">开始诊断</button><button id="refresh" class="secondary">刷新记录</button></header>
<div id="banner" role="status" hidden></div><div class="layout"><aside><div class="filter"><input id="search" aria-label="搜索诊断记录" placeholder="搜索编号、项目或版本"></div><div id="records" aria-label="诊断记录"><p class="muted">正在加载记录…</p></div></aside><main id="detail"><p class="empty">正在准备诊断页面…</p></main></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
