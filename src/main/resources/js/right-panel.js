// js/right-panel.js
import { store } from './store.js';
import { parseSSEStream } from './sse.js';

const API_BASE = 'http://localhost:9900/api';

export function initRightPanel() {
  // DOM 元素
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

  // ----- 自动化档位切换 -----
  function setMode(mode) {
    store.automationMode = mode;
    store.notify();
    modeBtns.forEach(btn => {
      if (btn.dataset.mode === mode) btn.classList.add('active');
      else btn.classList.remove('active');
    });
  }

  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });
  // 初始化高亮
  setMode(store.automationMode);

  // ----- 运行 AIOps 诊断 -----
  async function runAIOps() {
    reportContainer.innerHTML = '<div class="empty-state">⏳ 正在请求诊断报告，请稍候...</div>';
    try {
      const response = await fetch(`${API_BASE}/ai_ops`, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      let fullText = '';
      await parseSSEStream(response, {
        onContent: (chunk) => {
          fullText += chunk;
          // 实时显示原始文本（后续会替换为卡片渲染）
          reportContainer.innerHTML = `<pre class="raw-report" style="white-space: pre-wrap; font-size: 0.85rem;">${escapeHtml(fullText)}</pre>`;
        },
        onDone: () => {
          store.aiopsReportText = fullText;
          store.notify();
          // TODO: 第二步将调用 parseReportToCards 并渲染卡片图表
          console.log('[RightPanel] 报告完成，长度:', fullText.length);
        },
        onError: (err) => {
          reportContainer.innerHTML = `<div class="empty-state" style="color:#f87171;">❌ 错误: ${err}</div>`;
        }
      });
    } catch (err) {
      reportContainer.innerHTML = `<div class="empty-state" style="color:#f87171;">❌ 请求失败: ${err.message}</div>`;
    }
  }

  runBtn.addEventListener('click', runAIOps);

  // ----- 确认卡逻辑（监听 store.pendingActions）-----
  function showConfirmCard(action) {
    currentAction = action;
    confirmToolName.textContent = action.toolName || '未知工具';
    confirmRisk.textContent = action.riskLevel || 'Low';
    confirmDesc.textContent = action.description || 'Agent 想要执行此操作，请确认。';
    confirmCard.classList.remove('hidden');
  }

  function hideConfirmCard() {
    confirmCard.classList.add('hidden');
    currentAction = null;
  }

  approveBtn.addEventListener('click', () => {
    if (currentAction) {
      store.resolveAction(currentAction.id, true);
      hideConfirmCard();
    }
  });
  rejectBtn.addEventListener('click', () => {
    if (currentAction) {
      store.resolveAction(currentAction.id, false);
      hideConfirmCard();
    }
  });

  // 订阅 store 变化，弹出确认卡
  store.subscribe((newStore) => {
    if (newStore.automationMode === 'confirm' && newStore.pendingActions.length > 0) {
      // 取最新的一个 action
      const latest = newStore.pendingActions[newStore.pendingActions.length - 1];
      if (!currentAction || currentAction.id !== latest.id) {
        showConfirmCard(latest);
      }
    } else if (newStore.automationMode === 'auto' && newStore.pendingActions.length > 0) {
      // 自动批准所有 action
      newStore.pendingActions.forEach(act => store.resolveAction(act.id, true));
    } else if (newStore.automationMode === 'manual') {
      // manual 模式: 仅在控制台打印，不弹卡
      if (newStore.pendingActions.length > 0) {
        console.log('[Manual Mode] 待执行操作:', newStore.pendingActions);
      }
    }
  });
}

// 小工具：防XSS
function escapeHtml(str) {
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}