import MarkdownIt from 'markdown-it';
import type { DiagnosticRecord } from '../diagnostics/jobs';

declare const acquireVsCodeApi: () => { postMessage: (message: unknown) => void; getState: () => any; setState: (value: unknown) => void };
const api = acquireVsCodeApi();
const $ = (id: string) => document.getElementById(id)!;
const markdown = new MarkdownIt({ html: false, linkify: false });
let records: DiagnosticRecord[] = [], selectedId = api.getState()?.selectedId as string | undefined, workspaceId = '';
const reports = new Map<string, string>();
const requested = new Set<string>();
let pendingRepair: string | undefined;
const status = { running: '诊断中', completed: '已完成', failed: '失败', interrupted: '已中断' };
const notice = { pending: '诊断结束后发送', sending: '正在发送', sent: '已发送', failed: '发送失败', not_configured: '未配置' };
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}
function button(text: string, action: () => void, disabled = false, secondary = false) {
  const element = node('button', text, secondary ? 'secondary' : ''); element.disabled = disabled; element.onclick = action; return element;
}
function send(type: string, id?: string) { api.postMessage({ type, id }); }
function select(id: string) { selectedId = id; api.setState({ selectedId }); requested.add(id); send('select', id); render(); }
function render() {
  const query = ($('search') as HTMLInputElement).value.trim().toLowerCase();
  const list = $('records'); list.replaceChildren();
  for (const record of records.filter(r => `${r.id} ${r.workspaceName} ${r.pluginVersion}`.toLowerCase().includes(query))) {
    const item = node('button', '', `record${record.id === selectedId ? ' selected' : ''}`);
    item.append(node('b', `诊断 ${record.id.slice(0, 8)}`), node('span', status[record.status], 'status'),
      node('small', new Date(record.createdAt).toLocaleString(), 'muted'), node('small', `${record.workspaceName} · ${record.pluginVersion}`, 'muted'));
    item.onclick = () => select(record.id); list.append(item);
  }
  if (!list.childElementCount) list.append(node('p', records.length ? '没有匹配的记录' : '暂无诊断记录', 'muted'));
  const current = records.find(r => r.id === selectedId), detail = $('detail'); detail.replaceChildren();
  if (!current) { detail.append(node('p', '点击“开始诊断”，在后台查找任务耗时和重复失败的共性。', 'empty')); return; }
  detail.append(node('h2', `诊断 ${current.id.slice(0, 8)} · ${status[current.status]}`),
    node('p', `${current.workspaceName} · 插件 ${current.pluginVersion} · ${new Date(current.createdAt).toLocaleString()}`, 'muted'));
  if (current.status === 'running') { detail.append(node('div', `${current.progress} 关闭页面不会中断诊断。`, 'progress')); return; }
  if (current.error) detail.append(node('p', current.error, 'progress'));
  const summary = current.summary;
  if (summary) {
    const stats = node('div', '', 'stats');
    for (const [label, value] of [['分析任务', summary.turns], ['工具调用', summary.tools], ['失败调用', summary.failures], ['待核验问题', current.findings.length]]) {
      const stat = node('div', '', 'stat'); stat.append(node('b', String(value)), node('span', String(label), 'muted')); stats.append(stat);
    }
    detail.append(stats);
    if (!summary.turns) detail.append(node('p', '当前日志样本不足。先使用插件完成任务，再开始一次新诊断。', 'progress'));
  }
  detail.append(node('p', `飞书通知：${notice[current.notification.status]}${current.notification.message ? ` · ${current.notification.message}` : ''}`, 'muted'));
  const actions = node('div', '', 'actions'), wrongWorkspace = current.workspaceId !== workspaceId;
  const repairing = current.repair?.status === 'creating' || pendingRepair === current.id;
  if (current.status === 'completed') {
    actions.append(button(current.repair?.sessionId ? '查看修复会话' : repairing ? '正在创建修复会话…' : '创建修复会话', () => {
      if (pendingRepair === current.id || current.repair?.status === 'creating') return;
      pendingRepair = current.id; render(); send('repair', current.id);
    }, wrongWorkspace || repairing || !current.findings.length));
  }
  if (current.notification.status === 'failed' || current.notification.status === 'not_configured') actions.append(button('重试飞书通知', () => send('notify', current.id), false, true));
  actions.append(button('飞书通知设置', () => send('settings'), false, true)); detail.append(actions);
  if (wrongWorkspace) detail.append(node('p', '修复会话需要在这条诊断所属的工作区创建。', 'muted'));
  if (current.repair?.message) detail.append(node('p', current.repair.message, 'progress'));
  for (const finding of current.findings) {
    const item = node('section', '', `finding ${finding.severity}`);
    item.append(node('h3', finding.title), node('p', finding.evidence), node('p', finding.recommendation, 'muted'));
    if (finding.traceIds.length) item.append(node('p', `任务：${finding.traceIds.join('、')}`, 'muted')); detail.append(item);
  }
  if (current.status === 'completed' && !current.findings.length && summary?.turns) detail.append(node('p', '当前采样中没有发现符合检查条件的问题。可查看完整报告。', 'progress'));
  if (current.status === 'completed') {
    const details = node('details'), title = node('summary', '完整诊断证据'); details.append(title);
    const report = node('div', '', 'report'); report.innerHTML = reports.get(current.id) ?? '<p>正在加载报告…</p>'; details.append(report); detail.append(details);
    if (!reports.has(current.id) && !requested.has(current.id)) { requested.add(current.id); send('select', current.id); }
  }
}
$('start').onclick = () => send('start');
$('refresh').onclick = () => { requested.clear(); $('banner').hidden = true; send('refresh'); };
$('search').oninput = render;
window.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'state') {
    records = message.records; workspaceId = message.workspaceId;
    for (const record of records) if (record.status === 'running') requested.delete(record.id);
    if (!records.some(r => r.id === selectedId) || message.selectedId && message.selectedId !== selectedId) selectedId = message.selectedId;
    if (pendingRepair && ['started', 'failed'].includes(records.find(r => r.id === pendingRepair)?.repair?.status ?? '')) pendingRepair = undefined;
    render();
  } else if (message?.type === 'detail') {
    requested.delete(message.id); reports.set(message.id, markdown.render(message.report));
    if (reports.size > 8) reports.delete(reports.keys().next().value!);
    render();
  }
  else if (message?.type === 'error') { pendingRepair = undefined; $('banner').textContent = message.message; $('banner').hidden = false; render(); }
});
send('ready');
