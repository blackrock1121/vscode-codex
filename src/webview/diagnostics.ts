import { installWebviewErrors } from './errors';
import MarkdownIt from 'markdown-it';
import type { DiagnosticRecord } from '../diagnostics/jobs';
import { kindLabel, DiagnosticOptions } from '../diagnostics/options';
import type { ModelChoice } from '../shared';

declare const acquireVsCodeApi: () => { postMessage: (message: unknown) => void; getState: () => any; setState: (value: unknown) => void };
const api = acquireVsCodeApi();
installWebviewErrors(category => api.postMessage({ type: 'webviewError', category }));
const $ = (id: string) => document.getElementById(id)!;
const markdown = new MarkdownIt({ html: false, linkify: false });
let records: DiagnosticRecord[] = [], selectedId = api.getState()?.selectedId as string | undefined, workspaceId = '';
const reports = new Map<string, string>();
const requested = new Set<string>();
const expandedReports = new Set<string>();
let pendingRepair: string | undefined;
let models: ModelChoice[] = [], settings: DiagnosticOptions = { kind: 'general', hours: 24, engine: 'model' }, starting = false;
let settingsEdited = false;
const status = { running: '诊断中', completed: '已完成', failed: '失败', interrupted: '已中断' };
const notice = { pending: '诊断结束后发送', sending: '正在发送', sent: '已发送', failed: '发送失败', not_configured: '未开启', skipped: '已按设置跳过' };
const scopeLabel = (record: DiagnosticRecord) => record.diagnosticScope === 'local-plugin-full' ? '整个插件 · 全量' : '旧版全局采样';
const recordStatus = (record: DiagnosticRecord) => record.modelAnalysis?.status === 'failed' && record.status === 'completed' ? '部分完成' : status[record.status];
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}
function button(text: string, action: () => void, disabled = false, secondary = false) {
  const element = node('button', text, secondary ? 'secondary' : ''); element.disabled = disabled; element.onclick = action; return element;
}
function send(type: string, id?: string) { api.postMessage({ type, id }); }
function select(id?: string) {
  selectedId = id; api.setState({ selectedId, options: settings });
  if (id) { requested.add(id); send('select', id); }
  else send('collapse');
  render();
}
const control = (id: string) => $(id) as HTMLSelectElement;
function updateControls() {
  const isModel = settings.engine === 'model', model = models.find(m => m.id === settings.model);
  control('diagnostic-kind').value = settings.kind; control('diagnostic-hours').value = String(settings.hours); control('diagnostic-engine').value = settings.engine;
  const pick = control('diagnostic-model'); pick.replaceChildren();
  if (!models.length || !settings.model) pick.append(new Option(models.length ? '请选择诊断模型' : '模型列表尚未加载', ''));
  for (const m of models) pick.append(new Option(m.name || m.id, m.id));
  if (settings.model && !model) pick.append(new Option(`${settings.model}（当前不可用）`, settings.model));
  pick.value = settings.model ?? ''; pick.disabled = !isModel || !models.length;
  const efforts = control('diagnostic-effort'); efforts.replaceChildren();
  for (const effort of model?.efforts ?? []) efforts.append(new Option(effort, effort));
  efforts.value = settings.effort ?? ''; efforts.disabled = !isModel || !model;
  ($('start') as HTMLButtonElement).disabled = starting || isModel && (!model || !model.efforts.includes(settings.effort ?? ''));
  $('start').textContent = starting ? '正在创建诊断…' : '开始诊断';
  $('engine-note').textContent = isModel ? '模型诊断会使用当前 Codex 账号额度，将脱敏后的异常摘要和性能证据发送给所选模型；完整原始日志不上传。' : '仅在本机执行规则检查，不调用模型、不消耗模型额度。';
}
for (const id of ['diagnostic-kind', 'diagnostic-hours', 'diagnostic-engine', 'diagnostic-model', 'diagnostic-effort']) $(id).onchange = () => {
  settingsEdited = true;
  const model = models.find(m => m.id === control('diagnostic-model').value), currentEffort = control('diagnostic-effort').value;
  settings = { kind: control('diagnostic-kind').value as DiagnosticOptions['kind'], hours: Number(control('diagnostic-hours').value) as DiagnosticOptions['hours'],
    engine: control('diagnostic-engine').value as DiagnosticOptions['engine'], model: model?.id,
    effort: model?.efforts.includes(currentEffort) ? currentEffort : model?.defaultEffort ?? model?.efforts[0] };
  updateControls(); api.setState({ selectedId, options: settings });
  if (settings.engine === 'rules' || settings.model && settings.effort) api.postMessage({ type: 'configure', options: settings });
  if (id === 'diagnostic-engine' && settings.engine === 'model' && !models.length) send('reloadModels');
};
function render() {
  const detail = $('detail'), previous = detail.dataset.recordId, oldDetails = detail.querySelector('details');
  if (previous && oldDetails) { if (oldDetails.open) expandedReports.add(previous); else expandedReports.delete(previous); }
  const query = ($('search') as HTMLInputElement).value.trim().toLowerCase();
  // 详情随记录展开；先移出列表，避免重建列表时丢失详情容器。
  detail.hidden = true; $('history').append(detail);
  const list = $('records'); list.replaceChildren();
  const visible = records.filter(r => `${r.id} ${r.workspaceName} ${r.pluginVersion} ${r.summary?.versions.join(' ') ?? ''} ${scopeLabel(r)}`.toLowerCase().includes(query));
  $('record-count').textContent = query ? `${visible.length} / ${records.length} 条` : `${records.length} 条`;
  for (const record of visible) {
    const expanded = record.id === selectedId;
    const entry = node('section', '', `record-entry${expanded ? ' expanded' : ''}`);
    const item = node('button', '', 'record'); item.id = `record-${record.id}`; item.dataset.recordId = record.id;
    item.setAttribute('aria-expanded', String(expanded));
    if (expanded) item.setAttribute('aria-controls', 'detail');
    const heading = node('span', '', 'record-heading');
    heading.append(node('b', `诊断 ${record.id.slice(0, 8)}`), node('span', recordStatus(record), 'status'), node('span', expanded ? '收起详情 ▴' : '展开详情 ▾', 'record-toggle'));
    item.append(heading,
      node('small', new Date(record.createdAt).toLocaleString(), 'muted'), node('small', `${kindLabel(record.options?.kind)} · ${scopeLabel(record)} · ${record.pluginVersion}`, 'muted'),
      node('small', `发起位置：${record.workspaceName}`, 'muted'));
    item.append(node('small', record.status === 'running' ? record.progress : record.error ?? `待核验问题 ${record.findings.length} 项 · 通知：${notice[record.notification.status]}`, 'record-summary'));
    item.onclick = () => { select(expanded ? undefined : record.id); document.getElementById(item.id)?.focus({ preventScroll: true }); };
    entry.append(item); list.append(entry);
    if (expanded) { detail.hidden = false; detail.setAttribute('aria-labelledby', item.id); entry.append(detail); }
  }
  if (!list.childElementCount) list.append(node('p', records.length ? '没有匹配的记录' : '暂无诊断记录', 'muted'));
  const current = visible.find(r => r.id === selectedId); detail.replaceChildren(); detail.dataset.recordId = current?.id ?? '';
  if (!current) return;
  const detailHeading = node('div', '', 'detail-heading');
  const collapse = button('收起详情', () => { select(); document.getElementById(`record-${current.id}`)?.focus({ preventScroll: true }); }, false, true);
  collapse.id = 'collapse-detail';
  detailHeading.append(node('h2', `诊断 ${current.id.slice(0, 8)} · ${recordStatus(current)}`), collapse);
  detail.append(detailHeading,
    node('p', `范围：${scopeLabel(current)} · 诊断器 ${current.pluginVersion} · ${new Date(current.createdAt).toLocaleString()}`, 'muted'),
    node('p', `发起位置：${current.workspaceName}；此位置不限制诊断范围。`, 'muted'));
  detail.append(node('p', `${kindLabel(current.options?.kind)} · ${current.options?.hours ? `最近 ${current.options.hours} 小时` : '全部保留日志'} · ${current.options?.engine === 'model' ? `模型 ${current.options.model} / ${current.options.effort}` : '本地规则检查（未使用模型）'}`, 'muted'));
  const coverage = current.coverage;
  if (coverage) {
    detail.append(node('p', `覆盖 ${coverage.windows} 个窗口、${coverage.sessions} 个会话/子线程；完整读取 ${coverage.readFiles}/${coverage.files} 个日志文件，${coverage.records} 条结构化记录，${(coverage.bytes / 1048576).toFixed(2)} MiB。`, 'progress'),
      node('p', `日志日期：${coverage.firstDay ?? '无'} 至 ${coverage.lastDay ?? '无'}；采集时间：${coverage.fromMs ? new Date(coverage.fromMs).toLocaleString() : '未记录'} 至 ${coverage.toMs ? new Date(coverage.toMs).toLocaleString() : '未记录'}。`, 'muted'),
      node('p', `证据缺口：未完整读取文件 ${coverage.unreadableFiles}；损坏行 ${coverage.invalidLines}；超长行 ${coverage.oversizedLines}；缓冲丢弃行 ${coverage.droppedLines}。已删除、未采集和其他机器的日志无法覆盖。`, 'muted'));
  }
  if (current.status === 'running') { detail.append(node('div', `${current.progress} 关闭页面不会中断诊断。`, 'progress'), button('停止诊断', () => send('cancel', current.id), false, true)); return; }
  if (current.error) detail.append(node('p', current.error, 'progress'));
  if (coverage?.requestedFromMs) detail.append(node('p', `检查区间：${new Date(coverage.requestedFromMs).toLocaleString()} 至 ${new Date(coverage.requestedToMs!).toLocaleString()}；时间未标注、未纳入区间统计 ${coverage.unknownTimeLines ?? 0} 行。`, 'muted'));
  if (current.general) detail.append(node('p', `日志检查：错误 ${current.general.errors} 条，警告 ${current.general.warnings} 条；压缩错误 ${current.general.compactionErrors} 条，重试 ${current.general.retries} 条，明确恢复 ${current.general.recoveries} 条。`, 'progress'));
  const audit = current.loggingAudit;
  if (audit) detail.append(node('p', audit.status === 'unavailable' ? '源码日志覆盖审查不可用，不能据此认定日志完整。' :
    `源码日志覆盖：构建 ${audit.version}，检查 ${audit.files} 个文件、${audit.operations} 个操作路径及 ${audit.catches} 个错误处理器；${audit.candidates} 处待核验线索，${audit.unsupported} 个组件尚无自动规则。此项不依赖运行日志，不受日志时间范围限制。`, 'progress'));
  else if (current.options?.kind === 'general') detail.append(node('p', '本条历史诊断未包含源码日志覆盖审查，请重新开始全面诊断。', 'muted'));
  if (current.modelAnalysis) detail.append(node('p', `模型诊断：${current.modelAnalysis.status === 'completed' ? '已完成' : '失败，本地检查结果已保留'} · ${current.modelAnalysis.model} / ${current.modelAnalysis.effort} · ${(current.modelAnalysis.durationMs / 1000).toFixed(1)} 秒${current.modelAnalysis.message ? ` · ${current.modelAnalysis.message}` : ''}`, 'progress'));
  if (current.modelAnalysis?.evidenceSent !== undefined) detail.append(node('p', `模型输入：${current.modelAnalysis.evidenceSent} 组分类证据；另有 ${current.modelAnalysis.evidenceOmitted ?? 0} 组仅保留在本地结果中。`, 'muted'));
  const summary = current.summary;
  if (summary) {
    const stats = node('div', '', 'stats');
    for (const [label, value] of [['分析任务', summary.turns], ['工具调用', summary.tools], ['失败调用', summary.failures], ['待核验问题', current.findings.length]]) {
      const stat = node('div', '', 'stat'); stat.append(node('b', String(value)), node('span', String(label), 'muted')); stats.append(stat);
    }
    detail.append(stats);
    detail.append(node('p', `被分析的插件版本：${summary.versions.join('、') || '旧日志未标注'}`, 'muted'));
    if (!summary.turns && !current.general?.groups) detail.append(node('p', '当前区间没有完整任务样本；日志异常检查不依赖完整轮次，仍会检查区间内报错。', 'progress'));
  }
  detail.append(node('p', `通知：${notice[current.notification.status]}${current.notification.message ? ` · ${current.notification.message}` : ''}`, 'muted'));
  const actions = node('div', '', 'actions');
  const wrongWorkspace = current.repair?.sessionId ? (current.repair.workspaceId ?? current.workspaceId) !== workspaceId :
    current.diagnosticScope !== 'local-plugin-full' && current.workspaceId !== workspaceId;
  const repairing = current.repair?.status === 'creating' || pendingRepair === current.id;
  if (current.status === 'completed') {
    actions.append(button(current.repair?.sessionId ? '查看修复会话' : repairing ? '正在创建修复会话…' : '创建修复会话', () => {
      if (pendingRepair === current.id || current.repair?.status === 'creating') return;
      pendingRepair = current.id; render(); send('repair', current.id);
    }, wrongWorkspace || repairing || !current.findings.length));
  }
  if (current.notification.status === 'failed' || current.notification.status === 'not_configured' || current.notification.status === 'skipped') actions.append(button('重试通知', () => send('notify', current.id), false, true));
  actions.append(button('全局通知设置', () => send('settings'), false, true)); detail.append(actions);
  if (wrongWorkspace) detail.append(node('p', '请到已有修复会话或旧诊断所属的工作区打开修复会话。', 'muted'));
  else if (current.diagnosticScope === 'local-plugin-full' && !current.repair?.sessionId) detail.append(node('p', '修复会话在当前工作区创建，目标为插件源码；会先核验源码位置，避免修改无关业务项目。', 'muted'));
  if (current.repair?.message) detail.append(node('p', current.repair.message, 'progress'));
  for (const finding of current.findings) {
    const item = node('section', '', `finding ${finding.severity}`);
    item.append(node('h3', `${finding.origin === 'model' ? '模型结论 · ' : ''}${finding.title}`), node('p', finding.evidence), node('p', finding.recommendation, 'muted'));
    if (finding.traceIds.length) item.append(node('p', `任务：${finding.traceIds.join('、')}`, 'muted')); detail.append(item);
  }
  if (current.status === 'completed' && !current.findings.length && summary?.turns) detail.append(node('p', '已读取的日志中没有发现符合检查条件的问题。可查看完整报告。', 'progress'));
  if (current.status === 'completed') {
    const details = node('details'), title = node('summary', '完整诊断证据'); details.append(title);
    details.open = expandedReports.has(current.id);
    details.addEventListener('toggle', () => { if (details.open) expandedReports.add(current.id); else expandedReports.delete(current.id); });
    const report = node('div', '', 'report'); report.innerHTML = reports.get(current.id) ?? '<p>正在加载报告…</p>'; details.append(report); detail.append(details);
    if (!reports.has(current.id) && !requested.has(current.id)) { requested.add(current.id); send('select', current.id); }
  }
}
$('start').onclick = () => { if (starting) return; starting = true; updateControls(); api.postMessage({ type: 'start', options: settings }); };
$('reload-models').onclick = () => send('reloadModels');
$('refresh').onclick = () => { requested.clear(); $('banner').hidden = true; send('refresh'); };
$('search').oninput = render;
window.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'configuration') {
    models = message.models; if (!settingsEdited) settings = message.options;
    updateControls();
    if (message.error) { $('banner').textContent = message.error; $('banner').hidden = false; }
  }
  else if (message?.type === 'started') { starting = false; updateControls(); if (message.id) select(message.id); }
  else if (message?.type === 'reveal') {
    ($('search') as HTMLInputElement).value = ''; select(message.id);
    document.getElementById(`record-${message.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }
  else if (message?.type === 'state') {
    records = message.records; workspaceId = message.workspaceId;
    for (const record of records) if (record.status === 'running') requested.delete(record.id);
    // 展开状态由用户操作决定，后台刷新和迟到的消息不能重新展开已收起的记录。
    if (selectedId && !records.some(r => r.id === selectedId)) { selectedId = undefined; api.setState({ selectedId, options: settings }); }
    if (pendingRepair && ['started', 'failed'].includes(records.find(r => r.id === pendingRepair)?.repair?.status ?? '')) pendingRepair = undefined;
    render();
  } else if (message?.type === 'detail') {
    requested.delete(message.id); reports.set(message.id, markdown.render(message.report));
    if (reports.size > 8) reports.delete(reports.keys().next().value!);
    render();
  }
  else if (message?.type === 'error') { starting = false; updateControls(); pendingRepair = undefined; $('banner').textContent = message.message; $('banner').hidden = false; render(); }
});
updateControls();
send('ready');
