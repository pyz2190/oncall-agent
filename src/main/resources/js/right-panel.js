// js/right-panel.js
import { API_BASE, store } from './store.js';
import { parseSSEStream } from './sse.js';

// 用于存储 Chart 实例，以便更新时销毁
let severityChart = null;
let typeChart = null;

export function initRightPanel() {
  const modeBtns = document.querySelectorAll('.mode-btn');
  const runBtn = document.getElementById('runAIOpsBtn');
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
      alert: { name: '未知告警', time: '未知', severity: 'info' },
      rootCause: '未提取到根因分析',
      logEvidence: [],
      steps: [],
      stats: { typeDistribution: {}, severityDistribution: { critical: 0, warning: 0, info: 0 } }
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
    const cpuCount = (markdownText.match(/CPU/gi) || []).length;
    const memCount = (markdownText.match(/Memory|内存/gi) || []).length;
    const netCount = (markdownText.match(/Network|网络/gi) || []).length;
    if (cpuCount + memCount + netCount > 0) {
      result.stats.typeDistribution = { CPU: cpuCount || 2, Memory: memCount || 1, Network: netCount || 1 };
    } else {
      result.stats.typeDistribution = { CPU: 3, Memory: 2, Network: 1 };
    }

    // 严重度分布：根据报告中关键词出现频率模拟
    const criticalCount = (markdownText.match(/critical|严重|宕机/i) || []).length;
    const warningCount = (markdownText.match(/warning|警告|超限/i) || []).length;
    const infoCount = (markdownText.match(/info|信息|正常/i) || []).length;
    result.stats.severityDistribution = {
      critical: criticalCount || 1,
      warning: warningCount || 2,
      info: infoCount || 3
    };

    return result;
  }

  // 渲染卡片到 reportContainer
  let currentCharts = { severity: null, type: null };
  function renderReportCards(reportData) {
    const { alert, rootCause, logEvidence, steps, stats } = reportData;
    const severityColor = alert.severity === 'critical' ? 'critical' : (alert.severity === 'warning' ? 'warning' : 'info');

    let html = `
      <div class="alert-card">
        <div class="card-title"><i class="fas fa-bell"></i> 告警摘要</div>
        <div><strong>名称：</strong> ${escapeHtml(alert.name)}</div>
        <div><strong>触发时间：</strong> ${escapeHtml(alert.time)}</div>
        <div><strong>严重度：</strong> <span class="badge ${severityColor}">${alert.severity.toUpperCase()}</span></div>
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

  function drawCharts(stats) {
    // 销毁旧图表
    if (currentCharts.severity) currentCharts.severity.destroy();
    if (currentCharts.type) currentCharts.type.destroy();

    const typeCtx = document.getElementById('typeChart')?.getContext('2d');
    const severityCtx = document.getElementById('severityChart')?.getContext('2d');
    if (!typeCtx || !severityCtx) return;

    const typeData = stats.typeDistribution || { CPU: 0, Memory: 0, Network: 0 };
    const severityData = stats.severityDistribution || { critical: 0, warning: 0, info: 0 };

    currentCharts.type = new Chart(typeCtx, {
      type: 'pie',
      data: {
        labels: Object.keys(typeData),
        datasets: [{ data: Object.values(typeData), backgroundColor: ['#3b82f6', '#f59e0b', '#10b981'] }]
      },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { position: 'bottom', labels: { color: '#cbd5e1' } } } }
    });

    currentCharts.severity = new Chart(severityCtx, {
      type: 'bar',
      data: {
        labels: Object.keys(severityData),
        datasets: [{ label: '告警数量', data: Object.values(severityData), backgroundColor: ['#dc2626', '#f59e0b', '#3b82f6'] }]
      },
      options: { responsive: true, maintainAspectRatio: true, scales: { y: { ticks: { color: '#cbd5e1' }, grid: { color: '#334155' } }, x: { ticks: { color: '#cbd5e1' } } }, plugins: { legend: { labels: { color: '#cbd5e1' } } } }
    });
  }

  // ---------- AIOps 诊断（流式获取 + 解析渲染）----------
  async function runAIOps() {
    reportContainer.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-pulse"></i> 正在请求诊断报告，请稍候...</div>';
    try {
      const response = await fetch(`${API_BASE}/ai_ops`, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      let fullText = '';
      await parseSSEStream(response, {
        onContent: (chunk) => {
          fullText += chunk;
          // 可选：显示实时原始文本（调试用），正式可注释
          // reportContainer.innerHTML = `<pre style="font-size:0.7rem;">${escapeHtml(fullText)}</pre>`;
        },
        onDone: () => {
          store.aiopsReportText = fullText;
          store.notify();
          // 解析并渲染卡片
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

  runBtn.addEventListener('click', runAIOps);
  window.addEventListener('aiops:run', runAIOps);

  // ---------- 确认卡逻辑（与第一步相同，保留）----------
  function showConfirmCard(action) {
    currentAction = action;
    confirmToolName.textContent = action.toolName || '未知工具';
    confirmRisk.textContent = action.riskLevel || 'Low';
    confirmDesc.textContent = action.description || 'Agent 想要执行此操作，请确认。';
    confirmCard.classList.remove('hidden');
  }
  function hideConfirmCard() { confirmCard.classList.add('hidden'); currentAction = null; }
  approveBtn.addEventListener('click', () => {
    if (currentAction) { store.resolveAction(currentAction.id, true); hideConfirmCard(); }
  });
  rejectBtn.addEventListener('click', () => {
    if (currentAction) { store.resolveAction(currentAction.id, false); hideConfirmCard(); }
  });

  store.subscribe((newStore) => {
    if (newStore.automationMode === 'confirm' && newStore.pendingActions.length > 0) {
      const latest = newStore.pendingActions[newStore.pendingActions.length - 1];
      if (!currentAction || currentAction.id !== latest.id) showConfirmCard(latest);
    } else if (newStore.automationMode === 'auto' && newStore.pendingActions.length > 0) {
      newStore.pendingActions.forEach(act => store.resolveAction(act.id, true));
    } else if (newStore.automationMode === 'manual' && newStore.pendingActions.length > 0) {
      console.log('[Manual Mode] 待执行操作:', newStore.pendingActions);
    }
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  }).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(c) {
    return c;
  });
}
