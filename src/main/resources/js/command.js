import { API_BASE, store } from './store.js';
import { escapeHtml, highlight } from './dom.js';

const SESSION_KEY = 'oncall.sessions';
const UPLOAD_KEY = 'oncall.uploadedDocs';
const CURRENT_SESSION_KEY = 'oncall.currentSessionId';
const MODES = ['manual', 'confirm', 'auto'];
const DEFAULT_UI_PREFS = { theme: 'light', fontScale: 1, highContrast: false };

const COMMANDS = [
  { command: '/clear', title: '清空对话', description: '清空当前服务端会话和本地消息。' },
  { command: '/aiops', title: '运行诊断', description: '启动右侧智能运维诊断流程。' },
  { command: '/upload', title: '上传文档', description: '打开 Markdown 或文本知识库上传器。' },
  { command: '/help', title: '查看帮助', description: '列出可用斜杠命令和快捷键。' },
  { command: '/search', title: '本地搜索', description: '搜索对话、诊断报告和已上传文件名。' },
  { command: '/mode', title: '切换档位', description: '切换自动化档位：手动、确认或自动。' }
];

const MODE_LABELS = {
  manual: '手动',
  confirm: '确认',
  auto: '自动'
};

const STATUS_LABELS = {
  uploading: '上传中',
  indexed: '已入库',
  failed: '失败'
};

export function initCommand() {
  const sidebarNode = document.getElementById('leftSidebar');
  const paletteNode = ensurePaletteNode();
  if (!sidebarNode || !paletteNode) return;

  const state = {
    sessions: normalizeSessions(loadJson(SESSION_KEY, []), store.sessionId),
    uploads: loadJson(UPLOAD_KEY, []),
    paletteOpen: false,
    paletteQuery: '',
    selectedIndex: 0,
    searchQuery: '',
    status: '',
    uiPrefs: { ...DEFAULT_UI_PREFS, ...store.uiPrefs }
  };
  applyUiPrefs(state.uiPrefs);

  if (!state.sessions.length) {
    state.sessions.unshift(createSession(store.sessionId, '当前会话'));
    saveSessions(state.sessions);
  } else if (!state.sessions.some(session => session.id === store.sessionId)) {
    store.setState({ sessionId: state.sessions[0].id, messages: [] });
  }
  saveSessions(state.sessions);
  saveCurrentSession(store.sessionId);
  store.setState({ uploadedDocs: state.uploads });

  function render() {
    sidebarNode.innerHTML = renderSidebar(state);
    bindSidebar();
    renderPalette();
  }

  function bindSidebar() {
    sidebarNode.querySelector('#newSessionBtn')?.addEventListener('click', newSession);
    sidebarNode.querySelector('#openPaletteBtn')?.addEventListener('click', () => openPalette());
    sidebarNode.querySelector('#openUploadBtn')?.addEventListener('click', openUploadPicker);
    sidebarNode.querySelector('#openUploadDrop')?.addEventListener('click', openUploadPicker);
    sidebarNode.querySelector('#clearChatBtn')?.addEventListener('click', clearCurrentSession);
    sidebarNode.querySelector('#themeToggleBtn')?.addEventListener('click', () => {
      updateUiPrefs({ theme: state.uiPrefs.theme === 'dark' ? 'light' : 'dark' });
    });
    sidebarNode.querySelector('#fontDecreaseBtn')?.addEventListener('click', () => {
      updateUiPrefs({ fontScale: Math.max(0.9, Number((state.uiPrefs.fontScale - 0.05).toFixed(2))) });
    });
    sidebarNode.querySelector('#fontIncreaseBtn')?.addEventListener('click', () => {
      updateUiPrefs({ fontScale: Math.min(1.25, Number((state.uiPrefs.fontScale + 0.05).toFixed(2))) });
    });
    sidebarNode.querySelector('#contrastToggleBtn')?.addEventListener('click', () => {
      updateUiPrefs({ highContrast: !state.uiPrefs.highContrast });
    });
    sidebarNode.querySelector('#resetA11yBtn')?.addEventListener('click', () => {
      updateUiPrefs({ ...DEFAULT_UI_PREFS });
    });

    sidebarNode.querySelector('#uploadInput')?.addEventListener('change', event => {
      uploadFiles([...event.target.files]);
      event.target.value = '';
    });

    sidebarNode.querySelector('#sidebarSearchInput')?.addEventListener('input', event => {
      state.searchQuery = event.target.value;
      render();
      sidebarNode.querySelector('#sidebarSearchInput')?.focus();
    });

    sidebarNode.querySelectorAll('[data-session-id]').forEach(button => {
      button.addEventListener('click', () => switchSession(button.dataset.sessionId));
    });

    sidebarNode.querySelectorAll('[data-delete-session-id]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        deleteSession(button.dataset.deleteSessionId);
      });
    });

    sidebarNode.querySelectorAll('[data-run-command]').forEach(button => {
      button.addEventListener('click', () => executeRaw(button.dataset.runCommand));
    });

    sidebarNode.querySelectorAll('[data-search-target]').forEach(button => {
      button.addEventListener('click', () => jumpToResult(button.dataset.searchTarget));
    });
  }

  function renderPalette() {
    paletteNode.hidden = !state.paletteOpen;
    if (!state.paletteOpen) return;

    const query = state.paletteQuery.trim();
    const matches = filterCommands(query);
    state.selectedIndex = Math.min(state.selectedIndex, Math.max(matches.length - 1, 0));

    paletteNode.innerHTML = `
      <div class="palette-backdrop" data-close-palette></div>
      <section class="palette-dialog" role="dialog" aria-modal="true" aria-label="命令面板">
        <div class="palette-input-row">
          <span>/</span>
          <input id="paletteInput" autocomplete="off" spellcheck="false"
            placeholder="输入命令或搜索关键词" value="${escapeHtml(state.paletteQuery).replace(/"/g, '&quot;')}">
        </div>
        <div class="palette-results">
          ${matches.map((item, index) => renderPaletteItem(item, index === state.selectedIndex)).join('')}
        </div>
        <div class="palette-help">回车执行选中命令，Esc 关闭，控制键或命令键 + K 打开此面板。</div>
      </section>
    `;

    paletteNode.querySelector('[data-close-palette]')?.addEventListener('click', closePalette);
    const input = paletteNode.querySelector('#paletteInput');
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
    input?.addEventListener('input', event => {
      state.paletteQuery = event.target.value;
      state.selectedIndex = 0;
      renderPalette();
    });
    input?.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        state.selectedIndex = Math.min(state.selectedIndex + 1, matches.length - 1);
        renderPalette();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
        renderPalette();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const selected = matches[state.selectedIndex];
        executeRaw(selected?.command || state.paletteQuery);
      } else if (event.key === 'Escape') {
        closePalette();
      }
    });

    paletteNode.querySelectorAll('[data-palette-command]').forEach(button => {
      button.addEventListener('click', () => executeRaw(button.dataset.paletteCommand));
    });
  }

  function openPalette(initialValue = '') {
    state.paletteOpen = true;
    state.paletteQuery = initialValue;
    state.selectedIndex = 0;
    renderPalette();
  }

  function closePalette() {
    state.paletteOpen = false;
    state.paletteQuery = '';
    renderPalette();
  }

  async function executeRaw(rawValue) {
    const raw = (rawValue || '').trim();
    if (!raw) return;

    const [command, ...parts] = raw.split(/\s+/);
    const args = parts.join(' ');

    if (command === '/clear') {
      closePalette();
      await clearCurrentSession();
    } else if (command === '/aiops') {
      closePalette();
      state.status = '已启动智能运维诊断。';
      window.dispatchEvent(new CustomEvent('aiops:run'));
      render();
    } else if (command === '/upload') {
      closePalette();
      openUploadPicker();
    } else if (command === '/help') {
      state.status = '可用命令：/clear、/aiops、/upload、/search 关键词、/mode manual|confirm|auto。';
      render();
      openPalette('/');
    } else if (command === '/search') {
      closePalette();
      state.searchQuery = args;
      state.status = args ? `正在搜索“${args}”。` : '请在左侧搜索框输入关键词。';
      render();
      sidebarNode.querySelector('#sidebarSearchInput')?.focus();
    } else if (command === '/mode') {
      closePalette();
      setAutomationMode(args.toLowerCase());
    } else if (!raw.startsWith('/')) {
      closePalette();
      state.searchQuery = raw;
      render();
    } else {
      state.status = `未知命令：${raw}`;
      render();
    }
  }

  async function clearCurrentSession() {
    state.status = '正在清空当前会话...';
    render();

    try {
      await fetch(`${API_BASE}/chat/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Id: store.sessionId })
      });
      state.status = '当前会话已清空。';
    } catch (error) {
      state.status = `本地对话已清空，服务端清空失败：${error.message}`;
    }

    store.setState({ messages: [] });
    window.dispatchEvent(new CustomEvent('chat:clear'));
    touchSession(store.sessionId);
    render();
  }

  function newSession() {
    const nextId = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const session = createSession(nextId, `会话 ${state.sessions.length + 1}`);
    state.sessions = [session, ...state.sessions];
    saveSessions(state.sessions);
    saveCurrentSession(nextId);
    store.setState({ sessionId: nextId, messages: [] });
    state.status = '已新建会话。';
    window.dispatchEvent(new CustomEvent('chat:session-changed'));
    render();
  }

  function switchSession(sessionId) {
    if (!sessionId || sessionId === store.sessionId) return;
    saveCurrentSession(sessionId);
    store.setState({ sessionId, messages: [] });
    state.status = `已切换到 ${sessionId}。`;
    window.dispatchEvent(new CustomEvent('chat:session-changed'));
    render();
  }

  async function deleteSession(sessionId) {
    if (!sessionId) return;
    const session = state.sessions.find(item => item.id === sessionId);
    const label = session?.name || sessionId;
    const confirmed = window.confirm(`删除“${label}”？此操作会移除左侧会话记录，并清空服务端对应会话。`);
    if (!confirmed) return;

    try {
      await fetch(`${API_BASE}/chat/session/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE'
      });
    } catch (error) {
      console.warn(`[command] Failed to delete server session ${sessionId}`, error);
    }

    state.sessions = state.sessions.filter(item => item.id !== sessionId);
    if (!state.sessions.length) {
      const nextId = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      state.sessions = [createSession(nextId, '当前会话')];
    }

    if (store.sessionId === sessionId) {
      const next = state.sessions[0];
      saveCurrentSession(next.id);
      store.setState({ sessionId: next.id, messages: [] });
      window.dispatchEvent(new CustomEvent('chat:session-changed'));
    }

    saveSessions(state.sessions);
    state.status = `已删除会话：${label}。`;
    render();
  }

  async function uploadFiles(files) {
    const candidates = files.filter(file => /\.(md|txt)$/i.test(file.name));
    if (files.length && !candidates.length) {
      state.status = '后端仅支持上传 .md 和 .txt 文件。';
      render();
      return;
    }

    for (const file of candidates) {
      const pendingDoc = createUploadRecord(file, 'uploading');
      upsertUpload(pendingDoc);
      state.status = `正在上传 ${file.name}...`;
      render();

      try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch(`${API_BASE}/upload`, {
          method: 'POST',
          body: formData
        });
        const payload = await readJson(response);
        if (!response.ok || payload.code >= 400) {
          throw new Error(payload.message || `HTTP ${response.status}`);
        }

        const data = payload.data || {};
        upsertUpload({
          id: pendingDoc.id,
          name: data.fileName || file.name,
          size: data.fileSize || file.size,
          path: data.filePath || '',
          status: 'indexed',
          uploadedAt: Date.now()
        });
        state.status = `${file.name} 已上传并进入知识库。`;
      } catch (error) {
        upsertUpload({
          ...pendingDoc,
          status: 'failed',
          error: error.message,
          uploadedAt: Date.now()
        });
        state.status = `${file.name} 上传失败：${error.message}`;
      }
      render();
    }
  }

  function openUploadPicker() {
    sidebarNode.querySelector('#uploadInput')?.click();
  }

  function setAutomationMode(mode) {
    if (!MODES.includes(mode)) {
      state.status = '用法：/mode manual | confirm | auto';
      render();
      return;
    }

    const rightPanelButton = document.querySelector(`.mode-btn[data-mode="${mode}"]`);
    if (rightPanelButton) {
      rightPanelButton.click();
    } else {
      store.setState({ automationMode: mode });
    }
    state.status = `自动化档位已切换为：${MODE_LABELS[mode] || mode}。`;
    render();
  }

  function updateUiPrefs(nextPrefs) {
    state.uiPrefs = {
      ...state.uiPrefs,
      ...nextPrefs
    };
    applyUiPrefs(state.uiPrefs);
    state.status = '可读性设置已更新。';
    store.setUiPrefs(state.uiPrefs);
  }

  function upsertUpload(doc) {
    state.uploads = [doc, ...state.uploads.filter(item => item.id !== doc.id && item.name !== doc.name)];
    saveUploads(state.uploads);
    store.setState({ uploadedDocs: state.uploads });
  }

  function touchSession(sessionId) {
    state.sessions = state.sessions.map(session => (
      session.id === sessionId ? { ...session, updatedAt: Date.now() } : session
    ));
    saveSessions(state.sessions);
  }

  function bindGlobalShortcuts() {
    document.addEventListener('keydown', event => {
      const commandKey = event.ctrlKey || event.metaKey;
      if (!commandKey && event.key !== 'Escape') return;

      const key = event.key.toLowerCase();
      if (commandKey && key === 'k') {
        event.preventDefault();
        openPalette();
      } else if (commandKey && key === 'u') {
        event.preventDefault();
        openUploadPicker();
      } else if (commandKey && key === 'l') {
        event.preventDefault();
        clearCurrentSession();
      } else if (commandKey && event.key === 'Enter') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('chat:submit'));
      } else if (event.key === 'Escape' && state.paletteOpen) {
        event.preventDefault();
        closePalette();
      }
    });
  }

  window.addEventListener('command:execute', event => {
    executeRaw(event.detail?.raw);
  });

  window.addEventListener('chat:session-activity', () => {
    touchSession(store.sessionId);
    render();
  });

  bindGlobalShortcuts();
  store.subscribe((newStore) => {
    state.uiPrefs = { ...DEFAULT_UI_PREFS, ...newStore.uiPrefs };
    applyUiPrefs(state.uiPrefs);
    render();
  });
  render();
}

function renderSidebar(state) {
  const results = buildSearchResults(state.searchQuery);
  const uploadCount = state.uploads.length;
  const messageCount = store.messages.length;

  return `
    <div class="command-sidebar">
      <div class="command-topbar">
        <div>
          <div class="sidebar-title">命令中心</div>
          <div class="sidebar-subtitle">${messageCount} 条消息 · ${uploadCount} 份文档</div>
        </div>
        <button id="newSessionBtn" class="icon-btn" title="新建会话">+</button>
      </div>

      <div class="command-actions">
        <button id="openPaletteBtn" class="command-action" title="快捷键：控制键或命令键 + K"><span>命令面板</span></button>
        <button id="openUploadBtn" class="command-action" title="快捷键：控制键或命令键 + U"><span>上传文档</span></button>
        <button id="clearChatBtn" class="command-action" title="快捷键：控制键或命令键 + L"><span>清空对话</span></button>
      </div>

      <section class="sidebar-section">
        <div class="section-label">可读性设置</div>
        <div class="accessibility-controls">
          <button id="themeToggleBtn" type="button">${state.uiPrefs.theme === 'dark' ? '浅色模式' : '深色模式'}</button>
          <button id="fontDecreaseBtn" type="button">字号 -</button>
          <button id="fontIncreaseBtn" type="button">字号 +</button>
          <button id="contrastToggleBtn" type="button">${state.uiPrefs.highContrast ? '关闭高对比' : '高对比'}</button>
          <button id="resetA11yBtn" type="button">恢复默认</button>
        </div>
      </section>

      <section class="sidebar-section">
        <div class="section-label">会话列表</div>
        <div class="session-list">
          ${state.sessions.map(session => `
            <div class="session-row ${session.id === store.sessionId ? 'active' : ''}">
              <button class="session-item" data-session-id="${escapeHtml(session.id)}" title="${escapeHtml(session.id)}">
                <span>${escapeHtml(session.name)}</span>
                <small>${formatTime(session.updatedAt)}</small>
              </button>
              <button class="session-delete-btn" type="button" data-delete-session-id="${escapeHtml(session.id)}" title="删除会话" aria-label="删除会话">×</button>
            </div>
          `).join('')}
        </div>
      </section>

      <section class="sidebar-section">
        <div class="section-label">知识库上传</div>
        <input id="uploadInput" type="file" accept=".md,.txt" multiple hidden>
        <button class="upload-drop" id="openUploadDrop" type="button">
          <strong>上传 .md / .txt</strong>
          <span>文件会以 multipart 字段 file 发送到后端。</span>
        </button>
        <div class="upload-list">
          ${state.uploads.slice(0, 8).map(doc => renderUpload(doc)).join('') || '<div class="muted">暂未上传文档。</div>'}
        </div>
      </section>

      <section class="sidebar-section">
        <div class="section-label">本地搜索</div>
        <input id="sidebarSearchInput" class="sidebar-input" value="${escapeHtml(state.searchQuery).replace(/"/g, '&quot;')}"
          placeholder="搜索对话、报告、上传文档">
        <div class="search-results">
          ${state.searchQuery ? renderSearchResults(results, state.searchQuery) : '<div class="muted">使用 /search 关键词，或直接在这里输入。</div>'}
        </div>
      </section>

      <section class="sidebar-section">
        <div class="section-label">斜杠命令</div>
        <div class="command-list">
          ${COMMANDS.map(item => `
            <button data-run-command="${escapeHtml(item.command)}" class="mini-command">
              <code>${escapeHtml(item.command)}</code>
              <span>${escapeHtml(item.title)}</span>
            </button>
          `).join('')}
        </div>
      </section>

      ${state.status ? `<div class="sidebar-status">${escapeHtml(state.status)}</div>` : ''}
    </div>
  `;
}

function renderUpload(doc) {
  return `
    <div class="upload-item" data-upload-name="${escapeHtml(doc.name)}">
      <div>
        <strong>${escapeHtml(doc.name)}</strong>
        <small>${formatBytes(doc.size)} · ${formatTime(doc.uploadedAt)}</small>
      </div>
      <span class="upload-status ${escapeHtml(doc.status)}">${escapeHtml(STATUS_LABELS[doc.status] || doc.status)}</span>
    </div>
  `;
}

function renderSearchResults(results, keyword) {
  if (!results.length) return '<div class="muted">没有找到匹配结果。</div>';
  return results.slice(0, 12).map(result => `
    <button class="search-result" data-search-target="${escapeHtml(result.target)}">
      <span>${escapeHtml(result.source)}</span>
      <strong>${highlight(result.title, keyword)}</strong>
      <small>${highlight(result.preview, keyword)}</small>
    </button>
  `).join('');
}

function renderPaletteItem(item, selected) {
  return `
    <button class="palette-item ${selected ? 'is-selected' : ''}" data-palette-command="${escapeHtml(item.command)}">
      <code>${escapeHtml(item.command)}</code>
      <span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.description)}</small>
      </span>
    </button>
  `;
}

function filterCommands(query) {
  const normalized = query.toLowerCase();
  if (!normalized || normalized === '/') return COMMANDS;

  if (normalized.startsWith('/search ') || normalized.startsWith('search ')) {
    const keyword = query.replace(/^\/?search\s+/i, '');
    return [{ command: `/search ${keyword}`, title: `搜索“${keyword}”`, description: '搜索本地对话、报告和上传文档。' }];
  }

  if (normalized.startsWith('/mode ')) {
    const modeQuery = normalized.replace('/mode ', '').trim();
    const modes = MODES.filter(mode => !modeQuery || mode.startsWith(modeQuery));
    return modes.map(mode => ({ command: `/mode ${mode}`, title: `档位：${MODE_LABELS[mode] || mode}`, description: `切换自动化档位为${MODE_LABELS[mode] || mode}。` }));
  }

  return COMMANDS.filter(item => (
    item.command.includes(normalized) ||
    item.title.toLowerCase().includes(normalized) ||
    item.description.toLowerCase().includes(normalized)
  ));
}

function buildSearchResults(keyword) {
  const q = keyword.trim();
  if (!q) return [];

  const results = [];
  for (const message of store.messages) {
    const text = message.content || '';
    if (text.toLowerCase().includes(q.toLowerCase())) {
      results.push({
        source: message.role === 'user' ? '对话：用户' : '对话：智能体',
        title: message.role === 'user' ? '用户消息' : '智能体回复',
        preview: makePreview(text, q),
        target: message.id
      });
    }
  }

  if (store.aiopsReportText?.toLowerCase().includes(q.toLowerCase())) {
    results.push({
      source: '智能运维诊断',
      title: '诊断报告',
      preview: makePreview(store.aiopsReportText, q),
      target: 'reportContainer'
    });
  }

  for (const doc of store.uploadedDocs || []) {
    if (doc.name?.toLowerCase().includes(q.toLowerCase())) {
      results.push({
        source: '上传文档',
        title: doc.name,
        preview: `${STATUS_LABELS[doc.status] || doc.status} · ${formatBytes(doc.size)}`,
        target: `upload:${doc.name}`
      });
    }
  }

  return results;
}

function jumpToResult(target) {
  let node = null;
  if (target?.startsWith('upload:')) {
    const name = target.slice('upload:'.length);
    node = Array.from(document.querySelectorAll('[data-upload-name]'))
      .find(item => item.dataset.uploadName === name);
  } else {
    node = document.getElementById(target);
  }

  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.add('search-hit');
  window.setTimeout(() => node.classList.remove('search-hit'), 1400);
}

function createSession(id, name) {
  return { id, name, updatedAt: Date.now() };
}

function normalizeSessions(sessions, currentSessionId) {
  const seen = new Set();
  const currentSessions = [];
  const others = [];

  for (const session of sessions || []) {
    if (!session?.id || seen.has(session.id)) continue;
    seen.add(session.id);
    const normalized = {
      id: session.id,
      name: session.name || '会话',
      updatedAt: session.updatedAt || Date.now()
    };
    if (normalized.name === '当前会话') currentSessions.push(normalized);
    else others.push(normalized);
  }

  if (currentSessions.length <= 1) {
    return [...currentSessions, ...others];
  }

  const keepCurrent = currentSessions.find(item => item.id === currentSessionId);
  const keepLatest = [...currentSessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return [keepCurrent || keepLatest, ...others];
}

function createUploadRecord(file, status) {
  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    size: file.size,
    status,
    uploadedAt: Date.now()
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return { code: response.ok ? 200 : response.status, message: response.statusText };
  }
}

function ensurePaletteNode() {
  let node = document.getElementById('command-palette');
  if (!node) {
    node = document.createElement('div');
    node.id = 'command-palette';
    node.hidden = true;
    document.body.appendChild(node);
  }
  return node;
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function saveSessions(sessions) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessions.slice(0, 12)));
}

function saveCurrentSession(sessionId) {
  localStorage.setItem(CURRENT_SESSION_KEY, sessionId);
}

function saveUploads(uploads) {
  localStorage.setItem(UPLOAD_KEY, JSON.stringify(uploads.slice(0, 30)));
}

function applyUiPrefs(prefs) {
  const normalized = { ...DEFAULT_UI_PREFS, ...(prefs || {}) };
  document.body.classList.toggle('theme-dark', normalized.theme === 'dark');
  document.body.classList.toggle('high-contrast', Boolean(normalized.highContrast));
  document.documentElement.style.setProperty('--app-font-scale', String(normalized.fontScale || 1));
}

function makePreview(text, keyword) {
  const value = String(text || '').replace(/\s+/g, ' ');
  const index = value.toLowerCase().indexOf(keyword.toLowerCase());
  if (index < 0) return value.slice(0, 120);
  const start = Math.max(0, index - 40);
  return value.slice(start, start + 140);
}

function formatBytes(size = 0) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(time) {
  if (!time) return '刚刚';
  return new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
