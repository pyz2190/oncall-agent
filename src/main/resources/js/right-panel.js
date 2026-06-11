// js/right-panel.js
import { API_BASE, store } from './store.js';
import { parseSSEStream } from './sse.js';

// 用于存储 Chart 实例，以便更新时销毁
let severityChart = null;
let typeChart = null;

const SEVERITY_LABELS = {
  critical: '严重',
  warning: '警告',
  info: '提示'
};

export function initRightPanel() {
  const modeBtns = document.querySelectorAll('.mode-btn');
  const runBtn = document.getElementById('runAIOpsBtn');
  const exportMarkdownBtn = document.getElementById('exportMarkdownBtn');
  const exportPdfBtn = document.getElementById('exportPdfBtn');
  const reportContainer = document.getElementById('reportContainer');
  const confirmCard = document.getElementById('confirmCard');
  const confirmToolName = document.getElementById('confirmToolName');
  const confirmRisk = document.getElementById('confirmRisk');
  const confirmDesc = document.getElementById('confirmDesc');
  const approveBtn = document.getElementById('approveBtn');
  const rejectBtn = document.getElementById('rejectBtn');

  let currentAction = null;

  // ---------- 自动化档位 ----------
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

  // ---------- 报告解析函数 ----------
  function parseReportToCards(markdownText) {
    // 默认结构
    const result = {
      alerts: [],
      alert: { name: '未知告警', time: '未知', severity: 'info' },
      rootCause: '未提取到根因分析',
      logEvidence: [],
      steps: [],
      stats: { typeDistribution: {}, severityDistribution: {} }
    };

    // 1. 告警名称/时间/严重度
    const alertNameMatch = markdownText.match(/告警名称[：:]\s*(.+)/i) ||
        markdownText.match(/#+\s*Alert Summary[\s\S]*?[-*]\s*(.+)/i);
    if (alertNameMatch) result.alert.name = alertNameMatch[1].trim();

    const timeMatch = markdownText.match(/触发时间[：:]\s*(.+)/i);
    if (timeMatch) result.alert.time = timeMatch[1].trim();

    if (markdownText.includes('critical') || markdownText.includes('严重')) result.alert.severity = 'critical';
    else if (markdownText.includes('warning') || markdownText.includes('警告')) result.alert.severity = 'warning';
    else result.alert.severity = 'info';

    result.alerts = parseMarkdownAlertRows(markdownText);
    if (result.alerts.length) {
      result.alert = {
        name: result.alerts[0].name,
        time: result.alerts[0].firstSeen || result.alerts[0].lastSeen || '未知',
        severity: result.alerts[0].severity || 'info'
      };
      result.stats = buildStatsFromAlerts(result.alerts);
    }

    // 2. 根因分析 (## 根因分析 下的段落)
    const rootCauseMatch = markdownText.match(/##?\s*根因分析\s*\n([\s\S]*?)(?=\n##|\n$)/i);
    if (rootCauseMatch) result.rootCause = rootCauseMatch[1].trim();

    // 3. 日志证据 (```log ... ``` 代码块)
    const logBlock = markdownText.match(/```log([\s\S]*?)```/i);
    if (logBlock) {
      result.logEvidence = logBlock[1].split('\n').filter(l => l.trim().length > 0);
    } else {
      // 尝试匹配普通代码块
      const anyCode = markdownText.match(/```([\s\S]*?)```/);
      if (anyCode) result.logEvidence = anyCode[1].split('\n').filter(l => l.trim());
    }

    // 4. 处理步骤 (数字列表或 - [ ])
    const stepMatches = [...markdownText.matchAll(/(?:^|\n)(?:\d+\.\s*|-\s*)\[?\s*\]?\s*(.+)/g)];
    if (stepMatches.length) {
      result.steps = stepMatches.map(m => m[1].trim());
    } else {
      // 备选：匹配 "步骤" 后的列表
      const stepsSection = markdownText.match(/##?\s*处理步骤\s*\n([\s\S]*?)(?=\n##|\n$)/i);
      if (stepsSection) {
        const lines = stepsSection[1].split('\n');
        result.steps = lines.filter(l => l.match(/^\s*[-*]\s/)).map(l => l.replace(/^\s*[-*]\s/, '').trim());
      }
    }

    // 5. 统计信息（从报告中提取数字，或基于关键词构造示例数据）
    // 为了图表展示美观，我们构造一些示例数据，实际可从报告中解析 "CPU:3, Memory:2" 等
    return result;
  }

  function parseMarkdownAlertRows(markdownText) {
    const rows = [];
    let inAlertSection = false;

    markdownText.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed.includes('活跃告警清单')) {
        inAlertSection = true;
        return;
      }
      if (inAlertSection && trimmed.startsWith('##') && !trimmed.includes('活跃告警清单')) {
        inAlertSection = false;
      }
      if (!inAlertSection || !trimmed.startsWith('|') || trimmed.includes('---') || trimmed.includes('告警名称')) {
        return;
      }

      const cells = trimmed.slice(1, -1).split('|').map(cell => cell.replace(/\*\*/g, '').trim());
      if (cells.length < 3 || !cells[0] || cells[0].startsWith('[')) return;

      rows.push({
        name: cells[0],
        severity: normalizeSeverity(cells[1]),
        service: cells[2] || '',
        firstSeen: cells[3] || '',
        lastSeen: cells[4] || '',
        status: cells[5] || ''
      });
    });

    return rows;
  }

  function buildStatsFromAlerts(alerts) {
    const typeDistribution = {};
    const severityDistribution = {};

    alerts.forEach(alert => {
      const severity = normalizeSeverity(alert.severity);
      const type = classifyAlertType(`${alert.name || ''} ${alert.service || ''}`);
      severityDistribution[severity] = (severityDistribution[severity] || 0) + 1;
      typeDistribution[type] = (typeDistribution[type] || 0) + 1;
    });

    return { typeDistribution, severityDistribution };
  }

  function normalizeSeverity(value) {
    const text = String(value || '').toLowerCase();
    if (text.includes('critical') || text.includes('严重')) return 'critical';
    if (text.includes('warning') || text.includes('警告')) return 'warning';
    return 'info';
  }

  function classifyAlertType(value) {
    const text = String(value || '').toLowerCase();
    if (text.includes('cpu')) return 'CPU';
    if (text.includes('memory') || text.includes('内存') || text.includes('oom')) return 'Memory';
    if (text.includes('network') || text.includes('网络')) return 'Network';
    if (text.includes('database') || text.includes('数据库') || text.includes('db')) return 'Database';
    if (text.includes('certificate') || text.includes('证书')) return 'Certificate';
    if (text.includes('queue') || text.includes('消息')) return 'Queue';
    if (text.includes('pod') || text.includes('crashloop')) return 'Pod';
    if (text.includes('service') || text.includes('unavailable')) return 'Service';
    return 'Other';
  }

  // 渲染卡片到 reportContainer
  let currentCharts = { severity: null, type: null };
  function renderReportCards(reportData) {
    const { alert, alerts = [], rootCause, logEvidence, steps, stats } = reportData;
    const severityColor = alert.severity === 'critical' ? 'critical' : (alert.severity === 'warning' ? 'warning' : 'info');

    let html = `
      <div class="alert-card">
        <div class="card-title"><i class="fas fa-bell"></i> 告警摘要</div>
        ${alerts.length ? renderAlertTable(alerts) : `
          <div><strong>名称：</strong> ${escapeHtml(alert.name)}</div>
          <div><strong>触发时间：</strong> ${escapeHtml(alert.time)}</div>
          <div><strong>严重度：</strong> <span class="badge ${severityColor}">${SEVERITY_LABELS[alert.severity] || alert.severity}</span></div>
        `}
      </div>
      <div class="rootcause-card">
        <div class="card-title"><i class="fas fa-search"></i> 根因分析</div>
        <p>${escapeHtml(rootCause).replace(/\n/g, '<br>')}</p>
      </div>
    `;

    // 日志证据（可折叠）
    if (logEvidence.length) {
      html += `
        <div class="logs-card">
          <div class="card-title collapsible" id="logsToggle">
            <i class="fas fa-code"></i> 日志证据 <i class="fas fa-chevron-down" style="margin-left:auto;"></i>
          </div>
          <div id="logsContent" class="collapsible-content">
            <pre class="log-evidence">${escapeHtml(logEvidence.join('\n'))}</pre>
          </div>
        </div>
      `;
    }

    // 处理步骤 checklist
    if (steps.length) {
      html += `
        <div class="steps-card">
          <div class="card-title"><i class="fas fa-check-circle"></i> 处理步骤</div>
          <ul class="steps-list">
            ${steps.map(step => `<li><input type="checkbox"> ${escapeHtml(step)}</li>`).join('')}
          </ul>
        </div>
      `;
    }

    // 图表区域
    html += `
      <div class="stats-card">
        <div class="card-title"><i class="fas fa-chart-pie"></i> 统计与趋势</div>
        <div style="display:flex; flex-direction:column; gap:1rem;">
          <div>
            <div style="font-size:0.8rem; margin-bottom:0.5rem;">告警类型分布</div>
            <canvas id="typeChart" style="height:180px; width:100%;"></canvas>
          </div>
          <div>
            <div style="font-size:0.8rem; margin-bottom:0.5rem;">严重度分布</div>
            <canvas id="severityChart" style="height:180px; width:100%;"></canvas>
          </div>
        </div>
      </div>
    `;

    reportContainer.innerHTML = html;

    // 添加折叠功能
    const logsToggle = document.getElementById('logsToggle');
    if (logsToggle) {
      const logsContent = document.getElementById('logsContent');
      logsToggle.addEventListener('click', () => {
        logsContent.classList.toggle('open');
        const icon = logsToggle.querySelector('.fa-chevron-down');
        if (icon) icon.style.transform = logsContent.classList.contains('open') ? 'rotate(180deg)' : '';
      });
      // 默认展开
      logsContent.classList.add('open');
    }

    // 绘制图表
    drawCharts(stats);
  }

  function renderAlertTable(alerts) {
    return `
      <div class="alert-table">
        <div class="alert-table-row head">
          <span>告警</span>
          <span>级别</span>
          <span>服务</span>
        </div>
        ${alerts.map(alert => `
          <div class="alert-table-row">
            <span>${escapeHtml(alert.name || '未知告警')}</span>
            <span class="badge ${escapeHtml(alert.severity || 'info')}">${SEVERITY_LABELS[alert.severity] || alert.severity || '提示'}</span>
            <span>${escapeHtml(alert.service || '-')}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function drawCharts(stats) {
    // 销毁旧图表
    if (currentCharts.severity) currentCharts.severity.destroy();
    if (currentCharts.type) currentCharts.type.destroy();

    const typeCtx = document.getElementById('typeChart')?.getContext('2d');
    const severityCtx = document.getElementById('severityChart')?.getContext('2d');
    if (!typeCtx || !severityCtx) return;

    const typeData = stats.typeDistribution || {};
    const severityData = stats.severityDistribution || {};
    const hasTypeData = Object.keys(typeData).length > 0;
    const hasSeverityData = Object.keys(severityData).length > 0;

    if (!hasTypeData && !hasSeverityData) {
      typeCtx.canvas.replaceWith(emptyChartNote('暂无结构化告警类型数据'));
      severityCtx.canvas.replaceWith(emptyChartNote('暂无结构化严重度数据'));
      return;
    }

    if (hasTypeData) {
      currentCharts.type = new Chart(typeCtx, {
        type: 'pie',
        data: {
          labels: Object.keys(typeData),
          datasets: [{ data: Object.values(typeData), backgroundColor: ['#3b82f6', '#f59e0b', '#10b981', '#8b5cf6', '#ef4444'] }]
        },
        options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'bottom' } } }
      });
    } else {
      typeCtx.canvas.replaceWith(emptyChartNote('暂无结构化告警类型数据'));
    }

    if (hasSeverityData) {
      currentCharts.severity = new Chart(severityCtx, {
        type: 'bar',
        data: {
          labels: Object.keys(severityData),
          datasets: [{ label: '告警数量', data: Object.values(severityData), backgroundColor: ['#dc2626', '#f59e0b', '#3b82f6'] }]
        },
        options: { responsive: true, maintainAspectRatio: true, scales: { y: { beginAtZero: true } } }
      });
    } else {
      severityCtx.canvas.replaceWith(emptyChartNote('暂无结构化严重度数据'));
    }
  }

  function emptyChartNote(text) {
    const node = document.createElement('div');
    node.className = 'chart-empty-note';
    node.textContent = text;
    return node;
  }

  // ---------- AIOps 诊断（流式获取 + 解析渲染）----------
  async function runAIOps() {
    reportContainer.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-pulse"></i> 正在请求诊断报告，请稍候...</div>';
    store.setAgentStatus('正在生成事故诊断报告...');
    try {
      const response = await fetch(`${API_BASE}/ai_ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          automationMode: store.automationMode,
          sessionId: store.sessionId
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      let fullText = '';
      let structuredReport = null;
      const agentSteps = [];
      await parseSSEStream(response, {
        onContent: (chunk) => {
          fullText += chunk;
          // 可选：显示实时原始文本（调试用），正式可注释
          // reportContainer.innerHTML = `<pre style="font-size:0.7rem;">${escapeHtml(fullText)}</pre>`;
        },
        onDone: () => {
          store.aiopsReportText = fullText;
          store.notify();
          const parsed = structuredReport ? normalizeReportData(structuredReport) : parseReportToCards(fullText);
          renderReportCards(parsed);
          store.setAgentStatus('诊断报告已生成。');
          console.log('[RightPanel] 报告解析完成');
        },
        onAgentStep: (step) => {
          agentSteps.push(step);
          const label = step.label || 'Agent 步骤更新';
          store.setAgentStatus(label);
          if (!fullText.trim()) {
            reportContainer.innerHTML = renderAgentStepProgress(agentSteps);
          }
        },
        onActionRequired: (action) => {
          store.addAction(action);
          reportContainer.innerHTML = `
            <div class="empty-state">
              <i class="fas fa-user-check"></i>
              后端工具链正在等待审批：${escapeHtml(action.description || action.toolName || '待审批动作')}
            </div>
          `;
          store.setAgentStatus('等待工具执行审批。');
        },
        onActionStatus: (action) => {
          store.setAgentStatus(action.approved ? '工具执行已批准。' : '工具执行已拒绝。');
        },
        onReportData: (reportData) => {
          structuredReport = reportData;
        },
        onError: (err) => {
          reportContainer.innerHTML = `<div class="empty-state" style="color:#f87171;"><i class="fas fa-exclamation-circle"></i> 错误: ${err}</div>`;
          store.setAgentStatus(`错误：诊断失败：${err}`);
        }
      });
    } catch (err) {
      reportContainer.innerHTML = `<div class="empty-state" style="color:#f87171;"><i class="fas fa-exclamation-circle"></i> 请求失败: ${err.message}</div>`;
      store.setAgentStatus(`错误：诊断失败：${err.message}`);
    }
  }

  function normalizeReportData(reportData) {
    const alerts = Array.isArray(reportData.alerts) ? reportData.alerts : [];
    const firstAlert = alerts[0] || {};
    return {
      alerts,
      alert: {
        name: firstAlert.name || '未提取到告警',
        time: firstAlert.firstSeen || firstAlert.lastSeen || '未知',
        severity: firstAlert.severity || 'info'
      },
      rootCause: reportData.rootCause || '后端未提取到根因段落',
      logEvidence: Array.isArray(reportData.logEvidence) ? reportData.logEvidence : [],
      steps: Array.isArray(reportData.steps) ? reportData.steps : [],
      stats: {
        typeDistribution: reportData.typeDistribution || {},
        severityDistribution: reportData.severityDistribution || {}
      },
      source: 'backend'
    };
  }

  function renderAgentStepProgress(steps) {
    return `
      <div class="agent-progress-card">
        <div class="card-title"><i class="fas fa-route"></i> 后端 Agent 步骤</div>
        <ol>
          ${steps.slice(-6).map(step => `
            <li>
              <strong>${escapeHtml(step.label || 'Agent 步骤')}</strong>
              <span>${escapeHtml(step.detail || step.status || '')}</span>
            </li>
          `).join('')}
        </ol>
      </div>
    `;
  }

  runBtn.addEventListener('click', runAIOps);
  exportMarkdownBtn?.addEventListener('click', () => exportCurrentReport('markdown'));
  exportPdfBtn?.addEventListener('click', () => exportCurrentReport('pdf'));
  window.addEventListener('aiops:run', runAIOps);

  function exportCurrentReport(format) {
    const rawReport = (store.aiopsReportText || '').trim();
    const visibleReport = reportContainer?.innerText?.trim() || '';
    const reportText = rawReport || visibleReport;

    if (!reportText || /点击上方按钮获取诊断报告/.test(reportText)) {
      store.setAgentStatus('请先生成诊断报告，再导出。');
      return;
    }

    const markdown = buildIncidentMarkdown(reportText);
    const filename = `oncall-incident-report-${formatDateForFilename(new Date())}`;

    if (format === 'markdown') {
      downloadBlob(`${filename}.md`, markdown, 'text/markdown;charset=utf-8');
      store.setAgentStatus('Markdown 事故报告已导出。');
      return;
    }

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      store.setAgentStatus('浏览器拦截了 PDF 导出窗口，请允许弹窗后重试。');
      return;
    }

    printWindow.document.write(`
      <!doctype html>
      <html lang="zh-CN">
      <head>
        <meta charset="utf-8">
        <title>智能 OnCall 事故报告</title>
        <style>
          body { font-family: "Microsoft YaHei", Arial, sans-serif; line-height: 1.6; padding: 32px; color: #111827; }
          pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; }
        </style>
      </head>
      <body>
        <pre>${escapeHtml(markdown)}</pre>
      </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    store.setAgentStatus('PDF 打印窗口已打开。');
  }

  function buildIncidentMarkdown(reportText) {
    return [
      '# 智能 OnCall 事故报告',
      '',
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      `- 会话 ID：${store.sessionId}`,
      `- 自动化档位：${store.automationMode}`,
      '',
      '## 诊断内容',
      '',
      reportText,
      '',
      '## 交接备注',
      '',
      '- 请接班同学复核根因、处理步骤和未完成风险。',
      '- 如报告引用了知识库或日志，请在系统中点击来源继续溯源。'
    ].join('\n');
  }

  // ---------- 确认卡逻辑（与第一步相同，保留）----------
  function showConfirmCard(action) {
    currentAction = action;
    confirmToolName.textContent = action.toolName || '未知工具';
    confirmRisk.textContent = translateRisk(action.riskLevel);
    confirmDesc.textContent = action.description || '智能体想要执行此操作，请确认。';
    confirmCard.classList.remove('hidden');
  }
  function hideConfirmCard() { confirmCard.classList.add('hidden'); currentAction = null; }
  approveBtn.addEventListener('click', async () => {
    if (currentAction) {
      await store.resolveAction(currentAction.id, true);
      hideConfirmCard();
    }
  });
  rejectBtn.addEventListener('click', async () => {
    if (currentAction) {
      await store.resolveAction(currentAction.id, false);
      hideConfirmCard();
    }
  });

  store.subscribe((newStore) => {
    if ((newStore.automationMode === 'confirm' || newStore.automationMode === 'manual') && newStore.pendingActions.length > 0) {
      const latest = newStore.pendingActions[newStore.pendingActions.length - 1];
      if (!currentAction || currentAction.id !== latest.id) showConfirmCard(latest);
    } else if (newStore.automationMode === 'auto' && newStore.pendingActions.length > 0) {
      newStore.pendingActions.forEach(act => store.resolveAction(act.id, true));
    } else if (newStore.automationMode === 'manual' && newStore.pendingActions.length > 0) {
      console.log('[Manual Mode] 待执行操作:', newStore.pendingActions);
    }
  });
}

function translateRisk(riskLevel) {
  const value = String(riskLevel || 'low').toLowerCase();
  if (value === 'high') return '高';
  if (value === 'medium') return '中';
  if (value === 'low') return '低';
  return riskLevel || '低';
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  }).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(c) {
    return c;
  });
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatDateForFilename(date) {
  const pad = value => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes())
  ].join('');
}
