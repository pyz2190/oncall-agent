import { parseSSEStream } from './sse.js';
import { API_BASE, store } from './store.js';

const TIMELINE_LIMIT = 8;
const EXAMPLE_PROMPTS = [
  'ServiceUnavailable 告警应该怎么排查？',
  '根据知识库总结一次 Pod CrashLoopBackOff 的处理步骤。',
  '帮我生成一份数据库连接池耗尽的值班交接说明。'
];

export function initChat(mountNode) {
  if (!mountNode) return;

  mountNode.innerHTML = `
    <section class="chat-shell">
      <header class="chat-header">
        <div>
          <h1>智能 OnCall 助手</h1>
          <p>对话、诊断过程、证据来源和交互反馈会在这里连续呈现。</p>
        </div>
        <div class="session-pill" title="当前会话 ID">${store.sessionId}</div>
      </header>

      <div class="chat-assist-row">
        <div class="agent-status-bar" id="agentStatusBar" aria-live="polite">
          <span class="status-dot"></span>
          <span>状态：<strong id="agentStatusText">${escapeHtml(store.agentStatus)}</strong></span>
        </div>
        <div class="context-strip" id="contextStrip" title="当前会话上下文">
          上下文：${escapeHtml(store.contextSummary)}
        </div>
      </div>

      <div class="chat-messages" id="chatMessages">
        ${renderChatEmpty()}
      </div>

      <form class="composer" id="chatComposer">
        <button class="voice-btn" id="voiceBtn" type="button" aria-label="语音输入">
          <span class="voice-dot"></span>
          <span class="voice-label">语音</span>
        </button>
        <textarea id="chatInput" rows="1" placeholder="输入问题，Ctrl / Cmd + Enter 发送"></textarea>
        <button class="send-btn" id="sendBtn" type="submit">发送</button>
      </form>

      <div class="chat-status" id="chatStatus" aria-live="polite"></div>
    </section>
  `;

  const messagesNode = mountNode.querySelector('#chatMessages');
  const form = mountNode.querySelector('#chatComposer');
  const input = mountNode.querySelector('#chatInput');
  const voiceBtn = mountNode.querySelector('#voiceBtn');
  const statusNode = mountNode.querySelector('#chatStatus');
  const sendBtn = mountNode.querySelector('#sendBtn');
  const sessionPill = mountNode.querySelector('.session-pill');
  const agentStatusBar = mountNode.querySelector('#agentStatusBar');
  const agentStatusText = mountNode.querySelector('#agentStatusText');
  const contextStrip = mountNode.querySelector('#contextStrip');
  const recognition = createSpeechRecognition(input, voiceBtn, statusNode);

  bindEmptyStatePrompts(messagesNode, input);

  const renderSharedState = () => {
    const status = store.agentStatus || '就绪';
    agentStatusText.textContent = status;
    contextStrip.textContent = `上下文：${store.contextSummary || '暂无上下文'}`;
    agentStatusBar.classList.toggle('is-working', /正在|连接|接收|检索|生成|思考/.test(status));
    agentStatusBar.classList.toggle('is-error', /失败|错误/.test(status));
  };
  store.subscribe(renderSharedState);
  renderSharedState();

  voiceBtn.addEventListener('click', () => {
    if (!recognition) {
      setStatus(statusNode, '当前浏览器不支持语音输入，可以直接键入问题。', true);
      return;
    }
    toggleRecognition(recognition, voiceBtn, statusNode);
  });

  input.addEventListener('input', () => autoResize(input));
  input.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;

    input.value = '';
    autoResize(input);

    if (question.startsWith('/')) {
      window.dispatchEvent(new CustomEvent('command:execute', { detail: { raw: question } }));
      return;
    }

    await sendQuestion(question, { messagesNode, input, sendBtn, statusNode });
  });

  window.addEventListener('chat:submit', () => {
    form.requestSubmit();
  });

  window.addEventListener('chat:clear', () => {
    store.messages = [];
    store.setContextSummary('暂无上下文');
    store.notify();
    messagesNode.innerHTML = renderChatEmpty();
    bindEmptyStatePrompts(messagesNode, input);
    setStatus(statusNode, '');
  });

  window.addEventListener('chat:session-changed', () => {
    if (sessionPill) {
      sessionPill.textContent = store.sessionId;
    }
    store.setContextSummary('暂无上下文');
    messagesNode.innerHTML = renderChatEmpty();
    bindEmptyStatePrompts(messagesNode, input);
    setStatus(statusNode, '');
  });
}

async function sendQuestion(question, view) {
  const { messagesNode, input, sendBtn, statusNode } = view;
  clearEmptyState(messagesNode);

  const userMessage = {
    id: makeId('user'),
    role: 'user',
    content: question,
    createdAt: Date.now()
  };
  store.addMessage(userMessage);
  store.setContextSummary(buildContextSummary(question));
  appendMessage(messagesNode, userMessage);

  const assistantMessage = {
    id: makeId('assistant'),
    role: 'assistant',
    content: '',
    question,
    createdAt: Date.now()
  };
  const assistantNode = appendMessage(messagesNode, assistantMessage, true);
  const contentNode = assistantNode.querySelector('.message-content');
  const timelineNode = assistantNode.querySelector('.agent-timeline');

  setBusy(input, sendBtn, true);
  setStatus(statusNode, '正在连接流式接口...');

  let answer = '';
  let finished = false;
  const structuredSteps = [];

  try {
    const response = await fetch(`${API_BASE}/chat_stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Id: store.sessionId, Question: question })
    });

    if (!response.ok) {
      throw new Error(`接口返回 HTTP ${response.status}`);
    }

    await parseSSEStream(response, {
      onContent(chunk) {
        answer += chunk;
        assistantMessage.content = answer;
        contentNode.innerHTML = renderMarkdown(answer);
        renderTimeline(timelineNode, structuredSteps.length ? structuredSteps : buildTimeline(answer, false));
        scrollToBottom(messagesNode);
        setStatus(statusNode, '正在接收回复...');
      },
      onDone() {
        if (finished) return;
        finished = true;
        assistantMessage.content = answer || '已完成，但没有收到文本内容。';
        store.addMessage({ ...assistantMessage });
        store.setContextSummary(buildContextSummary(question, assistantMessage.content));
        contentNode.innerHTML = renderMarkdown(assistantMessage.content);
        renderTimeline(timelineNode, structuredSteps.length ? structuredSteps : buildTimeline(assistantMessage.content, true));
        renderFeedback(assistantNode, assistantMessage, statusNode);
        setStatus(statusNode, '正在检索知识库来源...');
        loadEvidence(question, assistantMessage.id, assistantNode, statusNode);
      },
      onAgentStep(step) {
        structuredSteps.push(normalizeAgentStep(step));
        renderTimeline(timelineNode, structuredSteps);
        if (step.label) {
          setStatus(statusNode, `${step.label}...`);
        }
      },
      onError(message) {
        throw new Error(message || '流式接口返回错误');
      }
    });
  } catch (error) {
    assistantMessage.content = `请求失败：${error.message}`;
    store.addMessage({ ...assistantMessage });
    contentNode.innerHTML = escapeHtml(assistantMessage.content);
    assistantNode.classList.add('is-error');
    renderFeedback(assistantNode, assistantMessage, statusNode);
    setStatus(statusNode, error.message, true);
  } finally {
    setBusy(input, sendBtn, false);
    input.focus();
    scrollToBottom(messagesNode);
  }
}

function normalizeAgentStep(step) {
  const phase = step.phase || 'reason';
  const time = step.timestamp
    ? new Date(step.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  return {
    kind: phase,
    label: step.label || timelineLabel(phase),
    text: [step.detail, step.toolName ? `工具：${step.toolName}` : '', step.status ? `状态：${step.status}` : '']
      .filter(Boolean)
      .join('；'),
    time
  };
}

function appendMessage(messagesNode, message, withTimeline = false) {
  const row = document.createElement('article');
  row.className = `message-row ${message.role}`;
  row.id = message.id;

  const time = new Date(message.createdAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });
  const assistantExtras = message.role === 'assistant'
    ? '<div class="evidence-slot"></div><div class="feedback-slot"></div>'
    : '';

  row.innerHTML = `
    <div class="message-meta">
      <span>${message.role === 'user' ? '你' : '智能体'}</span>
      <time>${time}</time>
    </div>
    ${withTimeline ? '<div class="agent-timeline"></div>' : ''}
    <div class="message-bubble">
      <div class="message-content">${renderMarkdown(message.content)}</div>
    </div>
    ${assistantExtras}
  `;

  messagesNode.appendChild(row);
  scrollToBottom(messagesNode);
  return row;
}

function buildTimeline(text, complete) {
  const segments = text
    .replace(/\r/g, '')
    .split(/\n+|(?<=[。！？.!?])\s+/)
    .map(item => item.trim())
    .filter(Boolean);

  const nodes = [];
  for (const segment of segments) {
    const kind = classifyTimelineSegment(segment, complete);
    if (!kind) continue;

    const summary = segment.length > 120 ? `${segment.slice(0, 120)}...` : segment;
    if (nodes.some(node => node.kind === kind && node.text === summary)) continue;

    nodes.push({
      kind,
      label: timelineLabel(kind),
      text: summary,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    });

    if (nodes.length >= TIMELINE_LIMIT) break;
  }

  if (nodes.length === 0) {
    nodes.push({
      kind: complete ? 'final' : 'reason',
      label: complete ? '最终回复' : '推理',
      text: complete ? '已汇总为最终回复。' : '正在根据可见上下文组织回复。',
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    });
  }

  return nodes;
}

function classifyTimelineSegment(segment, complete) {
  const lower = segment.toLowerCase();
  if (/queryprometheusalerts|querylogs|queryinternaldocs|调用|查询|检索|工具|tool|action/.test(lower)) {
    return 'action';
  }
  if (/找到|返回|结果|告警|日志|证据|发现|observation|observed/.test(lower)) {
    return 'observation';
  }
  if (/结论|建议|处理方案|最终|报告|final|recommendation|summary/.test(lower)) {
    return 'final';
  }
  if (/需要|分析|判断|原因|因为|考虑|reason|root cause/.test(lower)) {
    return 'reason';
  }
  return complete && lower.length > 30 ? 'final' : null;
}

function renderTimeline(timelineNode, nodes) {
  timelineNode.innerHTML = `
    <details class="timeline-card" open>
      <summary>智能体过程时间线</summary>
      <ol>
        ${nodes.map(node => `
          <li class="timeline-item ${node.kind}">
            <span class="timeline-mark">${node.label[0]}</span>
            <div>
              <div class="timeline-head">
                <span>${node.label}</span>
                <time>${node.time}</time>
              </div>
              <p>${escapeHtml(node.text)}</p>
            </div>
          </li>
        `).join('')}
      </ol>
    </details>
  `;
}

function renderFeedback(row, message, statusNode) {
  const slot = row.querySelector('.feedback-slot');
  if (!slot) return;

  const selected = store.feedback.find(item => item.messageId === message.id)?.type;
  const options = [
    { type: 'helpful', label: '👍 有帮助' },
    { type: 'unhelpful', label: '👎 没帮助' },
    { type: 'reasoning', label: '这步推理有问题' }
  ];

  slot.innerHTML = `
    <div class="feedback-bar" aria-label="回答反馈">
      <span>反馈</span>
      ${options.map(option => `
        <button type="button" class="feedback-btn ${selected === option.type ? 'active' : ''}"
          data-feedback-type="${option.type}">
          ${option.label}
        </button>
      `).join('')}
      ${selected ? '<small>已记录到本地反馈。</small>' : ''}
    </div>
  `;

  slot.querySelectorAll('[data-feedback-type]').forEach(button => {
    button.addEventListener('click', () => {
      const type = button.dataset.feedbackType;
      store.addFeedback({
        messageId: message.id,
        sessionId: store.sessionId,
        type,
        question: message.question || '',
        answer: message.content || ''
      });
      renderFeedback(row, message, statusNode);
      setStatus(statusNode, '反馈已记录在本地。');
      window.setTimeout(() => setStatus(statusNode, '就绪'), 1200);
    });
  });
}

async function loadEvidence(question, messageId, row, statusNode) {
  const slot = row.querySelector('.evidence-slot');
  if (!slot) return;

  slot.innerHTML = '<div class="evidence-panel is-loading">正在检索知识库来源...</div>';

  try {
    const response = await fetch(`${API_BASE}/evidence/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: question, topK: 3 })
    });
    const payload = await response.json();
    const evidenceItems = Array.isArray(payload.data) ? payload.data : [];
    store.setEvidence(messageId, evidenceItems);
    renderEvidence(row, messageId, evidenceItems, payload.code >= 400 ? payload.message : '');
    setStatus(statusNode, evidenceItems.length ? '已关联知识库来源。' : '回复完成，未检索到知识库来源。');
  } catch (error) {
    renderEvidence(row, messageId, [], `证据检索失败：${error.message}`);
    setStatus(statusNode, `证据检索失败：${error.message}`, true);
  } finally {
    window.setTimeout(() => {
      if (!/失败|错误/.test(store.agentStatus)) {
        store.setAgentStatus('就绪');
      }
    }, 1500);
  }
}

function renderEvidence(row, messageId, evidenceItems, errorMessage = '') {
  const slot = row.querySelector('.evidence-slot');
  if (!slot) return;

  if (!evidenceItems.length) {
    slot.innerHTML = `
      <div class="evidence-panel empty">
        <strong>来源引用</strong>
        <span>${escapeHtml(errorMessage || '暂无匹配的知识库片段。')}</span>
      </div>
    `;
    return;
  }

  slot.innerHTML = `
    <div class="evidence-panel">
      <div class="evidence-head">
        <strong>来源引用</strong>
        <span>点击编号查看原文片段</span>
      </div>
      <div class="citation-list">
        ${evidenceItems.map(item => `
          <button type="button" class="citation-chip" data-source-index="${item.index}">
            [${item.index}] ${escapeHtml(item.title || '知识库片段')}
          </button>
        `).join('')}
      </div>
      <div class="evidence-list">
        ${evidenceItems.map(item => renderEvidenceCard(messageId, item)).join('')}
      </div>
    </div>
  `;

  slot.querySelectorAll('[data-source-index]').forEach(button => {
    button.addEventListener('click', () => {
      const detail = document.getElementById(sourceDomId(messageId, button.dataset.sourceIndex));
      if (!detail) return;
      detail.open = true;
      detail.scrollIntoView({ behavior: 'smooth', block: 'center' });
      detail.classList.add('search-hit');
      window.setTimeout(() => detail.classList.remove('search-hit'), 1200);
    });
  });
}

function renderEvidenceCard(messageId, item) {
  return `
    <details class="evidence-card" id="${sourceDomId(messageId, item.index)}">
      <summary>
        <span>[${item.index}] ${escapeHtml(item.title || '知识库片段')}</span>
        <small>匹配分 ${Number(item.score || 0).toFixed(2)}</small>
      </summary>
      <p>${escapeHtml(item.snippet || '暂无片段内容。')}</p>
      ${item.metadata ? `<code>${escapeHtml(item.metadata)}</code>` : ''}
    </details>
  `;
}

function sourceDomId(messageId, index) {
  return `${messageId}-source-${index}`;
}

function createSpeechRecognition(input, voiceBtn, statusNode) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    voiceBtn.classList.add('unsupported');
    voiceBtn.title = '当前浏览器不支持 Web Speech API';
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.isRunning = false;

  let finalTranscript = '';

  recognition.onstart = () => {
    recognition.isRunning = true;
    finalTranscript = input.value.trim();
    voiceBtn.classList.add('recording');
    setStatus(statusNode, '正在听写，识别结果会实时填入输入框。');
  };

  recognition.onresult = event => {
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript = [finalTranscript, transcript].filter(Boolean).join(' ');
      } else {
        interimTranscript += transcript;
      }
    }
    input.value = [finalTranscript, interimTranscript].filter(Boolean).join(' ');
    autoResize(input);
  };

  recognition.onerror = event => {
    setStatus(statusNode, `语音识别失败：${event.error}`, true);
  };

  recognition.onend = () => {
    recognition.isRunning = false;
    voiceBtn.classList.remove('recording');
    setStatus(statusNode, input.value.trim() ? '可以编辑识别文本后发送。' : '');
  };

  return recognition;
}

function toggleRecognition(recognition, voiceBtn, statusNode) {
  if (recognition.isRunning) {
    recognition.stop();
    return;
  }

  try {
    recognition.start();
  } catch (error) {
    voiceBtn.classList.remove('recording');
    setStatus(statusNode, error.message, true);
  }
}

function renderMarkdown(text) {
  if (!text) return '';

  if (window.marked?.parse) {
    return window.marked.parse(text);
  }

  return escapeHtml(text)
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\n/g, '<br>');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function autoResize(input) {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function setBusy(input, sendBtn, busy) {
  input.disabled = busy;
  sendBtn.disabled = busy;
}

function setStatus(statusNode, message, isError = false) {
  statusNode.textContent = message || '';
  statusNode.classList.toggle('error', Boolean(isError));
  const globalStatus = isError && message ? `错误：${message}` : (message || '就绪');
  if (store.agentStatus !== globalStatus) {
    store.setAgentStatus(globalStatus);
  }
}

function clearEmptyState(messagesNode) {
  messagesNode.querySelector('.chat-empty')?.remove();
}

function renderChatEmpty() {
  return `
    <div class="chat-empty">
      <strong>开始一次排障对话</strong>
      <span>描述告警、粘贴日志现象，或询问下一步处理建议。</span>
      <div class="onboarding-actions">
        ${EXAMPLE_PROMPTS.map(prompt => `
          <button type="button" class="example-chip" data-example-prompt="${escapeHtml(prompt).replace(/"/g, '&quot;')}">
            ${escapeHtml(prompt)}
          </button>
        `).join('')}
      </div>
      <small>也可以先在左侧上传知识库文档，再让智能体按文档给出处理步骤。</small>
    </div>
  `;
}

function bindEmptyStatePrompts(messagesNode, input) {
  messagesNode.querySelectorAll('[data-example-prompt]').forEach(button => {
    button.addEventListener('click', () => {
      input.value = button.dataset.examplePrompt || '';
      autoResize(input);
      input.focus();
    });
  });
}

function buildContextSummary(question, answer = '') {
  const lastQuestion = question || [...store.messages].reverse().find(item => item.role === 'user')?.content || '';
  const docs = (store.uploadedDocs || []).filter(doc => doc.status === 'indexed').length;
  const issue = extractIssue(`${lastQuestion} ${answer}`);
  const parts = [];

  if (issue) parts.push(`正在排查 ${issue}`);
  if (docs) parts.push(`已上传 ${docs} 份知识库文档`);
  if (lastQuestion) parts.push(`最近问题：${truncate(lastQuestion, 32)}`);

  return parts.join('；') || '暂无上下文';
}

function extractIssue(text) {
  const patterns = [
    /([A-Za-z][A-Za-z0-9_-]{2,40}(?:Error|Exception|Unavailable|Timeout|BackOff|Backlog))/,
    /(ServiceUnavailable|CrashLoopBackOff|OOMKilled|连接池耗尽|证书过期|消息堆积|网络分区|日志查询|数据库|Pod)/i
  ];

  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) return match[1];
  }
  return '';
}

function truncate(text, limit) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function scrollToBottom(messagesNode) {
  messagesNode.scrollTop = messagesNode.scrollHeight;
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function timelineLabel(kind) {
  return {
    reason: '推理',
    action: '动作',
    observation: '观察',
    final: '结论'
  }[kind];
}
