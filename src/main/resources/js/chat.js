import { parseSSEStream } from './sse.js';
import { API_BASE, store } from './store.js';

const TIMELINE_LIMIT = 8;

export function initChat(mountNode) {
  if (!mountNode) return;

  mountNode.innerHTML = `
    <section class="chat-shell">
      <header class="chat-header">
        <div>
          <h1>OnCall Agent</h1>
          <p>对话、诊断过程和证据会在这里连续呈现。</p>
        </div>
        <div class="session-pill" title="当前会话 ID">${store.sessionId}</div>
      </header>

      <div class="chat-messages" id="chatMessages">
        <div class="chat-empty">
          <strong>开始一次排障对话</strong>
          <span>可以描述告警、日志现象，或询问下一步处理建议。</span>
        </div>
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
  const recognition = createSpeechRecognition(input, voiceBtn, statusNode);

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
    store.notify();
    messagesNode.innerHTML = renderChatEmpty();
    setStatus(statusNode, '');
  });

  window.addEventListener('chat:session-changed', () => {
    if (sessionPill) {
      sessionPill.textContent = store.sessionId;
    }
    messagesNode.innerHTML = renderChatEmpty();
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
  appendMessage(messagesNode, userMessage);

  const assistantMessage = {
    id: makeId('assistant'),
    role: 'assistant',
    content: '',
    createdAt: Date.now()
  };
  const assistantNode = appendMessage(messagesNode, assistantMessage, true);
  const contentNode = assistantNode.querySelector('.message-content');
  const timelineNode = assistantNode.querySelector('.agent-timeline');

  setBusy(input, sendBtn, true);
  setStatus(statusNode, '正在连接流式接口...');

  let answer = '';
  let finished = false;

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
        renderTimeline(timelineNode, buildTimeline(answer, false));
        scrollToBottom(messagesNode);
        setStatus(statusNode, '正在接收回复...');
      },
      onDone() {
        if (finished) return;
        finished = true;
        assistantMessage.content = answer || '已完成，但没有收到文本内容。';
        store.addMessage({ ...assistantMessage });
        contentNode.innerHTML = renderMarkdown(assistantMessage.content);
        renderTimeline(timelineNode, buildTimeline(assistantMessage.content, true));
        setStatus(statusNode, '回复完成。');
      },
      onError(message) {
        throw new Error(message || '流式接口返回错误');
      }
    });
  } catch (error) {
    assistantMessage.content = `请求失败：${error.message}`;
    contentNode.innerHTML = escapeHtml(assistantMessage.content);
    assistantNode.classList.add('is-error');
    setStatus(statusNode, error.message, true);
  } finally {
    setBusy(input, sendBtn, false);
    input.focus();
    scrollToBottom(messagesNode);
  }
}

function appendMessage(messagesNode, message, withTimeline = false) {
  const row = document.createElement('article');
  row.className = `message-row ${message.role}`;
  row.id = message.id;

  const time = new Date(message.createdAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });

  row.innerHTML = `
    <div class="message-meta">
      <span>${message.role === 'user' ? '你' : 'Agent'}</span>
      <time>${time}</time>
    </div>
    ${withTimeline ? '<div class="agent-timeline"></div>' : ''}
    <div class="message-bubble">
      <div class="message-content">${renderMarkdown(message.content)}</div>
    </div>
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
      label: complete ? 'Final' : 'Reason',
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
      <summary>Agent 过程时间线</summary>
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
  return String(value).replace(/[&<>"']/g, char => ({
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
  statusNode.textContent = message;
  statusNode.classList.toggle('error', Boolean(isError));
}

function clearEmptyState(messagesNode) {
  messagesNode.querySelector('.chat-empty')?.remove();
}

function renderChatEmpty() {
  return `
    <div class="chat-empty">
      <strong>New incident chat</strong>
      <span>Describe an alert, paste a log symptom, or ask for the next response step.</span>
    </div>
  `;
}

function scrollToBottom(messagesNode) {
  messagesNode.scrollTop = messagesNode.scrollHeight;
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function timelineLabel(kind) {
  return {
    reason: 'Reason',
    action: 'Action',
    observation: 'Observation',
    final: 'Final'
  }[kind];
}
