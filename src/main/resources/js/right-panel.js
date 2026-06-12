// js/right-panel.js
import { store } from './store.js';
import { parseSSEStream } from './sse.js';

const API_BASE = 'http://localhost:9900/api';

// 用于存储 Chart 实例
let currentCharts = { severity: null, type: null };

// 确认卡队列相关变量
let currentAction = null;          // 当前正在显示的操作

// DOM 元素（在 initRightPanel 中获取）
let confirmCard, confirmToolName, confirmRisk, confirmDesc, queueCounter;
let approveBtn, rejectBtn;

// ---------- 辅助函数：去除 Markdown 标记 ----------
function stripMarkdown(text) {
  if (!text) return '';
  return text.replace(/\*\*(.+?)\*\*/g, '$1')   // 粗体
      .replace(/\*(.+?)\*/g, '$1')       // 斜体
      .replace(/`(.+?)`/g, '$1')         // 行内代码
      .trim();
}

// ---------- 解析 Markdown 报告为结构化数据 ----------
function parseReportToCards(markdownText) {
  const result = {
    alert: { name: '未知告警', time: '未知', severity: 'info' },
    rootCause: '未提取到根因分析',
    logEvidence: [],
    steps: [],
    stats: { typeDistribution: {}, severityDistribution: { critical: 0, warning: 0, info: 0 } }
  };

  // 1. 告警名称、触发时间、严重度
  const nameMatch = markdownText.match(/告警名称[：:]\s*(.+)/i);
  if (nameMatch) result.alert.name = stripMarkdown(nameMatch[1]);

  const timeMatch = markdownText.match(/触发时间[：:]\s*(.+)/i);
  if (timeMatch) result.alert.time = stripMarkdown(timeMatch[1]);

  // 严重度：优先从 "严重度：xxx" 提取，否则关键词匹配
  const severityMatch = markdownText.match(/严重度[：:]\s*(.+)/i);
  if (severityMatch) {
    const sev = severityMatch[1].trim().toLowerCase();
    if (sev.includes('critical') || sev === '严重') result.alert.severity = 'critical';
    else if (sev.includes('warning') || sev === '警告') result.alert.severity = 'warning';
    else result.alert.severity = 'info';
  } else {
    if (markdownText.includes('critical')) result.alert.severity = 'critical';
    else if (markdownText.includes('warning')) result.alert.severity = 'warning';
    else result.alert.severity = 'info';
  }

  // 2. 根因分析
  const rootMatch = markdownText.match(/##?\s*根因分析\s*\n([\s\S]*?)(?=\n##|\n$)/i);
  if (rootMatch) result.rootCause = stripMarkdown(rootMatch[1].trim());

  // 3. 日志证据 (```log 代码块)
  const logBlock = markdownText.match(/```log([\s\S]*?)```/i);
  if (logBlock) {
    result.logEvidence = logBlock[1].split('\n').filter(l => l.trim().length > 0);
  } else {
    const anyCode = markdownText.match(/```([\s\S]*?)```/);
    if (anyCode) result.logEvidence = anyCode[1].split('\n').filter(l => l.trim());
  }

  // 4. 处理步骤：只提取 "## 处理步骤" 标题下的数字列表或 - 列表
  const stepsSection = markdownText.match(/##?\s*处理步骤\s*\n([\s\S]*?)(?=\n##|\n$)/i);
  if (stepsSection) {
    const lines = stepsSection[1].split('\n');
    const stepLines = lines.filter(line => line.match(/^\s*\d+\.\s+/) || line.match(/^\s*-\s+/));
    result.steps = stepLines.map(line => stripMarkdown(line.replace(/^\s*\d+\.\s*/, '').replace(/^\s*-\s*/, '').trim()));
  } else {
    // 降级：全文匹配数字列表
    const fallbackSteps = [...markdownText.matchAll(/(?:^|\n)(\d+\.\s+)([^\n]+)/g)];
    if (fallbackSteps.length) {
      result.steps = fallbackSteps.map(m => stripMarkdown(m[2]));
    }
  }

  // 5. 统计信息（基于关键词出现次数模拟）
  const cpuCnt = (markdownText.match(/CPU/gi) || []).length || 2;
  const memCnt = (markdownText.match(/内存|Memory/gi) || []).length || 1;
  const netCnt = (markdownText.match(/网络|Network/gi) || []).length || 1;
  result.stats.typeDistribution = { CPU: cpuCnt, Memory: memCnt, Network: netCnt };

  const criticalCnt = (markdownText.match(/critical|严重/gi) || []).length || 1;
  const warningCnt = (markdownText.match(/warning|警告/gi) || []).length || 2;
  const infoCnt = (markdownText.match(/info|信息/gi) || []).length || 1;
  result.stats.severityDistribution = { critical: criticalCnt, warning: warningCnt, info: infoCnt };

  return result;
}

// ---------- 渲染卡片 + 图表 ----------
function renderReportCards(reportData) {
  const { alert, rootCause, logEvidence, steps, stats } = reportData;
  const severityClass = alert.severity === 'critical' ? 'critical' : (alert.severity === 'warning' ? 'warning' : 'info');
  const severityText = alert.severity === 'critical' ? '严重' : (alert.severity === 'warning' ? '警告' : '信息');

  let html = `
    <div class="alert-card">
      <div class="card-title"><i class="fas fa-bell"></i> 告警摘要</div>
      <div><strong>名称：</strong> ${escapeHtml(alert.name)}</div>
      <div><strong>触发时间：</strong> ${escapeHtml(alert.time)}</div>
      <div><strong>严重度：</strong> <span class="badge ${severityClass}">${severityText}</span></div>
    </div>
    <div class="rootcause-card">
      <div class="card-title"><i class="fas fa-search"></i> 根因分析</div>
      <p>${escapeHtml(rootCause).replace(/\n/g, '<br>')}</p>
    </div>`;

  if (logEvidence.length) {
    html += `
      <div class="logs-card">
        <div class="card-title collapsible" id="logsToggle">
          <i class="fas fa-code"></i> 日志证据 <i class="fas fa-chevron-down" style="margin-left:auto;"></i>
        </div>
        <div id="logsContent" class="collapsible-content">
          <pre class="log-evidence">${escapeHtml(logEvidence.join('\n'))}</pre>
        </div>
      </div>`;
  }

  if (steps.length) {
    html += `<div class="steps-card"><div class="card-title"><i class="fas fa-check-circle"></i> 处理步骤</div><ul class="steps-list">${steps.map(step => `<li><input type="checkbox"> ${escapeHtml(step)}</li>`).join('')}</ul></div>`;
  }

  html += `
    <div class="stats-card">
      <div class="card-title"><i class="fas fa-chart-pie"></i> 统计与趋势</div>
      <div style="display:flex; flex-direction:column; gap:1rem;">
        <div><div style="font-size:0.8rem;">告警类型分布</div><canvas id="typeChart" style="height:160px; width:100%;"></canvas></div>
        <div><div style="font-size:0.8rem;">严重度分布</div><canvas id="severityChart" style="height:160px; width:100%;"></canvas></div>
      </div>
    </div>`;

  const reportContainer = document.getElementById('reportContainer');
  if (reportContainer) reportContainer.innerHTML = html;

  // 折叠功能
  const logsToggle = document.getElementById('logsToggle');
  if (logsToggle) {
    const logsContent = document.getElementById('logsContent');
    logsToggle.addEventListener('click', () => {
      logsContent.classList.toggle('open');
      const icon = logsToggle.querySelector('.fa-chevron-down');
      if (icon) icon.style.transform = logsContent.classList.contains('open') ? 'rotate(180deg)' : '';
    });
    if (logsContent) logsContent.classList.add('open');
  }

  // 绘制图表
  drawCharts(stats);
}

function drawCharts(stats) {
  if (currentCharts.severity) currentCharts.severity.destroy();
  if (currentCharts.type) currentCharts.type.destroy();
  const typeCanvas = document.getElementById('typeChart');
  const severityCanvas = document.getElementById('severityChart');
  if (!typeCanvas || !severityCanvas) return;
  const typeCtx = typeCanvas.getContext('2d');
  const severityCtx = severityCanvas.getContext('2d');
  const typeData = stats.typeDistribution || { CPU: 0, Memory: 0, Network: 0 };
  const severityData = stats.severityDistribution || { critical: 0, warning: 0, info: 0 };
  currentCharts.type = new Chart(typeCtx, {
    type: 'pie',
    data: { labels: Object.keys(typeData), datasets: [{ data: Object.values(typeData), backgroundColor: ['#3b82f6', '#f59e0b', '#10b981'] }] },
    options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'bottom', labels: { color: '#cbd5e1' } } } }
  });
  currentCharts.severity = new Chart(severityCtx, {
    type: 'bar',
    data: { labels: Object.keys(severityData), datasets: [{ label: '告警数量', data: Object.values(severityData), backgroundColor: ['#dc2626', '#f59e0b', '#3b82f6'] }] },
    options: { responsive: true, maintainAspectRatio: true, scales: { y: { ticks: { color: '#cbd5e1' }, grid: { color: '#334155' } }, x: { ticks: { color: '#cbd5e1' } } }, plugins: { legend: { labels: { color: '#cbd5e1' } } } }
  });
}

// ---------- 确认卡队列逻辑 ----------
function updateQueueCounter() {
  if (!queueCounter) return;
  const queueLength = store.pendingActions.length;
  if (queueLength > 1) {
    queueCounter.textContent = ` (还有 ${queueLength - 1} 个等待)`;
    queueCounter.style.display = 'inline';
  } else {
    queueCounter.style.display = 'none';
  }
}

function showConfirmCard(action) {
  if (!confirmCard) return;
  currentAction = action;
  confirmToolName.textContent = action.toolName || '未知工具';
  confirmRisk.textContent = action.riskLevel || 'Low';
  confirmDesc.textContent = action.description || 'Agent 想要执行此操作，请确认。';
  confirmCard.classList.remove('hidden');
  updateQueueCounter();
}

function hideConfirmCard() {
  if (confirmCard) confirmCard.classList.add('hidden');
  currentAction = null;
}

function resolveCurrentAction(approved) {
  if (!currentAction) return;
  store.resolveAction(currentAction.id, approved);
  // resolveAction 会触发 store.notify()，进而执行 subscribe 中的 showNextPendingAction
}

function showNextPendingAction() {
  if (store.pendingActions.length === 0) {
    hideConfirmCard();
    return;
  }
  // 如果当前有卡片且对应的操作仍在队列中，只更新计数器
  if (currentAction && store.pendingActions.some(a => a.id === currentAction.id)) {
    updateQueueCounter();
    return;
  }
  // 否则显示队列中的第一个
  const nextAction = store.pendingActions[0];
  if (nextAction) {
    showConfirmCard(nextAction);
  } else {
    hideConfirmCard();
  }
}

// ---------- AIOps 诊断（SSE 流式获取）----------
async function runAIOps() {
  const reportContainer = document.getElementById('reportContainer');
  if (!reportContainer) return;
  reportContainer.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-pulse"></i> 正在请求诊断报告，请稍候...</div>';
  try {
    const response = await fetch(`${API_BASE}/ai_ops`, { method: 'POST' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let fullText = '';
    await parseSSEStream(response, {
      onContent: (chunk) => { fullText += chunk; },
      onDone: () => {
        store.aiopsReportText = fullText;
        store.notify();
        const parsed = parseReportToCards(fullText);
        renderReportCards(parsed);
        console.log('[RightPanel] 报告解析完成');
      },
      onError: (err) => {
        reportContainer.innerHTML = `<div class="empty-state" style="color:#f87171;"><i class="fas fa-exclamation-circle"></i> 错误: ${err}</div>`;
      }
    });
  } catch (err) {
    reportContainer.innerHTML = `<div class="empty-state" style="color:#f87171;"><i class="fas fa-exclamation-circle"></i> 请求失败: ${err.message}</div>`;
  }
}

// ---------- 初始化右侧面板 ----------
export function initRightPanel() {
  // 获取 DOM 元素
  const modeBtns = document.querySelectorAll('.mode-btn');
  const runBtn = document.getElementById('runAIOpsBtn');
  confirmCard = document.getElementById('confirmCard');
  confirmToolName = document.getElementById('confirmToolName');
  confirmRisk = document.getElementById('confirmRisk');
  confirmDesc = document.getElementById('confirmDesc');
  approveBtn = document.getElementById('approveBtn');
  rejectBtn = document.getElementById('rejectBtn');
  queueCounter = document.getElementById('queueCounter');

  // 自动化档位切换 UI
  function setMode(mode) {
    store.automationMode = mode;
    store.notify();
    modeBtns.forEach(btn => {
      if (btn.dataset.mode === mode) btn.classList.add('active');
      else btn.classList.remove('active');
    });
  }
  modeBtns.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
  setMode(store.automationMode);

  // 绑定运行诊断按钮
  if (runBtn) runBtn.addEventListener('click', runAIOps);

  // 确认卡按钮事件
  if (approveBtn) approveBtn.addEventListener('click', () => resolveCurrentAction(true));
  if (rejectBtn) rejectBtn.addEventListener('click', () => resolveCurrentAction(false));

  // 订阅 store 变化，处理确认卡队列
  store.subscribe((newStore) => {
    const mode = newStore.automationMode;
    const actions = newStore.pendingActions;

    if (mode === 'confirm') {
      showNextPendingAction();
    } else if (mode === 'auto' && actions.length > 0) {
      // 自动批准所有
      actions.forEach(act => store.resolveAction(act.id, true));
    } else if (mode === 'manual') {
      if (actions.length > 0) {
        console.log('[Manual Mode] 待执行操作（未弹卡）:', actions);
      }
      hideConfirmCard();
    } else {
      hideConfirmCard();
    }
  });

  console.log('[RightPanel] 初始化完成');
}

// 防 XSS 辅助函数
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}