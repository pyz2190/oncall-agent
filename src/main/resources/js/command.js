import { API_BASE, store } from './store.js';
import { escapeHtml, highlight } from './dom.js';

const SESSION_KEY = 'oncall.sessions';
const UPLOAD_KEY = 'oncall.uploadedDocs';
const MODES = ['manual', 'confirm', 'auto'];

const COMMANDS = [
  { command: '/clear', title: 'Clear chat', description: 'Clear the current server session and local messages.' },
  { command: '/aiops', title: 'Run AIOps', description: 'Start the right-panel diagnosis workflow.' },
  { command: '/upload', title: 'Upload docs', description: 'Open the Markdown / text upload picker.' },
  { command: '/help', title: 'Show help', description: 'List available slash commands and shortcuts.' },
  { command: '/search', title: 'Search', description: 'Search chat, AIOps report text, and uploaded file names.' },
  { command: '/mode', title: 'Set mode', description: 'Switch automation mode: manual, confirm, or auto.' }
];

export function initCommand() {
  const sidebarNode = document.getElementById('leftSidebar');
  const paletteNode = ensurePaletteNode();
  if (!sidebarNode || !paletteNode) return;

  const state = {
    sessions: loadJson(SESSION_KEY, []),
    uploads: loadJson(UPLOAD_KEY, []),
    paletteOpen: false,
    paletteQuery: '',
    selectedIndex: 0,
    searchQuery: '',
    status: ''
  };

  if (!state.sessions.some(session => session.id === store.sessionId)) {
    state.sessions.unshift(createSession(store.sessionId, 'Current session'));
    saveSessions(state.sessions);
  }
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
      <section class="palette-dialog" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="palette-input-row">
          <span>/</span>
          <input id="paletteInput" autocomplete="off" spellcheck="false"
            placeholder="Type a command or search text" value="${escapeHtml(state.paletteQuery).replace(/"/g, '&quot;')}">
        </div>
        <div class="palette-results">
          ${matches.map((item, index) => renderPaletteItem(item, index === state.selectedIndex)).join('')}
        </div>
        <div class="palette-help">Enter runs selected command. Esc closes. Ctrl/Cmd+K opens this panel.</div>
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
      state.status = 'AIOps diagnosis started.';
      window.dispatchEvent(new CustomEvent('aiops:run'));
      render();
    } else if (command === '/upload') {
      closePalette();
      openUploadPicker();
    } else if (command === '/help') {
      state.status = 'Commands: /clear, /aiops, /upload, /search keyword, /mode manual|confirm|auto.';
      render();
      openPalette('/');
    } else if (command === '/search') {
      closePalette();
      state.searchQuery = args;
      state.status = args ? `Search results for "${args}".` : 'Type a keyword in the sidebar search box.';
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
      state.status = `Unknown command: ${raw}`;
      render();
    }
  }

  async function clearCurrentSession() {
    state.status = 'Clearing current session...';
    render();

    try {
      await fetch(`${API_BASE}/chat/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Id: store.sessionId })
      });
      state.status = 'Current session cleared.';
    } catch (error) {
      state.status = `Local chat cleared. Server clear failed: ${error.message}`;
    }

    store.setState({ messages: [] });
    window.dispatchEvent(new CustomEvent('chat:clear'));
    touchSession(store.sessionId);
    render();
  }

  function newSession() {
    const nextId = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const session = createSession(nextId, `Session ${state.sessions.length + 1}`);
    state.sessions = [session, ...state.sessions];
    saveSessions(state.sessions);
    store.setState({ sessionId: nextId, messages: [] });
    state.status = 'New session created.';
    window.dispatchEvent(new CustomEvent('chat:session-changed'));
    render();
  }

  function switchSession(sessionId) {
    if (!sessionId || sessionId === store.sessionId) return;
    store.setState({ sessionId, messages: [] });
    touchSession(sessionId);
    state.status = `Switched to ${sessionId}.`;
    window.dispatchEvent(new CustomEvent('chat:session-changed'));
    render();
  }

  async function uploadFiles(files) {
    const candidates = files.filter(file => /\.(md|txt)$/i.test(file.name));
    if (files.length && !candidates.length) {
      state.status = 'Only .md and .txt files are accepted by the backend.';
      render();
      return;
    }

    for (const file of candidates) {
      const pendingDoc = createUploadRecord(file, 'uploading');
      upsertUpload(pendingDoc);
      state.status = `Uploading ${file.name}...`;
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
        state.status = `${file.name} uploaded and indexed.`;
      } catch (error) {
        upsertUpload({
          ...pendingDoc,
          status: 'failed',
          error: error.message,
          uploadedAt: Date.now()
        });
        state.status = `${file.name} upload failed: ${error.message}`;
      }
      render();
    }
  }

  function openUploadPicker() {
    sidebarNode.querySelector('#uploadInput')?.click();
  }

  function setAutomationMode(mode) {
    if (!MODES.includes(mode)) {
      state.status = 'Usage: /mode manual | confirm | auto';
      render();
      return;
    }

    const rightPanelButton = document.querySelector(`.mode-btn[data-mode="${mode}"]`);
    if (rightPanelButton) {
      rightPanelButton.click();
    } else {
      store.setState({ automationMode: mode });
    }
    state.status = `Automation mode set to ${mode}.`;
    render();
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

  bindGlobalShortcuts();
  store.subscribe(() => render());
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
          <div class="sidebar-title">Command Center</div>
          <div class="sidebar-subtitle">${messageCount} messages · ${uploadCount} docs</div>
        </div>
        <button id="newSessionBtn" class="icon-btn" title="New session">+</button>
      </div>

      <div class="command-actions">
        <button id="openPaletteBtn" class="command-action">Ctrl/Cmd K <span>Palette</span></button>
        <button id="openUploadBtn" class="command-action">Ctrl/Cmd U <span>Upload</span></button>
        <button id="clearChatBtn" class="command-action">Ctrl/Cmd L <span>Clear</span></button>
      </div>

      <section class="sidebar-section">
        <div class="section-label">Sessions</div>
        <div class="session-list">
          ${state.sessions.map(session => `
            <button class="session-item ${session.id === store.sessionId ? 'active' : ''}" data-session-id="${escapeHtml(session.id)}">
              <span>${escapeHtml(session.name)}</span>
              <small>${formatTime(session.updatedAt)}</small>
            </button>
          `).join('')}
        </div>
      </section>

      <section class="sidebar-section">
        <div class="section-label">Knowledge upload</div>
        <input id="uploadInput" type="file" accept=".md,.txt" multiple hidden>
        <button class="upload-drop" id="openUploadDrop" type="button">
          <strong>Upload .md / .txt</strong>
          <span>Files are sent as multipart field "file".</span>
        </button>
        <div class="upload-list">
          ${state.uploads.slice(0, 8).map(doc => renderUpload(doc)).join('') || '<div class="muted">No uploaded docs yet.</div>'}
        </div>
      </section>

      <section class="sidebar-section">
        <div class="section-label">Local search</div>
        <input id="sidebarSearchInput" class="sidebar-input" value="${escapeHtml(state.searchQuery).replace(/"/g, '&quot;')}"
          placeholder="Search chat, report, uploads">
        <div class="search-results">
          ${state.searchQuery ? renderSearchResults(results, state.searchQuery) : '<div class="muted">Use /search keyword or type here.</div>'}
        </div>
      </section>

      <section class="sidebar-section">
        <div class="section-label">Slash commands</div>
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
      <span class="upload-status ${escapeHtml(doc.status)}">${escapeHtml(doc.status)}</span>
    </div>
  `;
}

function renderSearchResults(results, keyword) {
  if (!results.length) return '<div class="muted">No matches found.</div>';
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
    return [{ command: `/search ${keyword}`, title: `Search "${keyword}"`, description: 'Search local chat, reports, and uploads.' }];
  }

  if (normalized.startsWith('/mode ')) {
    const modeQuery = normalized.replace('/mode ', '').trim();
    const modes = MODES.filter(mode => !modeQuery || mode.startsWith(modeQuery));
    return modes.map(mode => ({ command: `/mode ${mode}`, title: `Mode: ${mode}`, description: `Switch automation mode to ${mode}.` }));
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
        source: message.role === 'user' ? 'Chat: user' : 'Chat: agent',
        title: message.role === 'user' ? 'User message' : 'Agent response',
        preview: makePreview(text, q),
        target: message.id
      });
    }
  }

  if (store.aiopsReportText?.toLowerCase().includes(q.toLowerCase())) {
    results.push({
      source: 'AIOps',
      title: 'Diagnosis report',
      preview: makePreview(store.aiopsReportText, q),
      target: 'reportContainer'
    });
  }

  for (const doc of store.uploadedDocs || []) {
    if (doc.name?.toLowerCase().includes(q.toLowerCase())) {
      results.push({
        source: 'Upload',
        title: doc.name,
        preview: `${doc.status} · ${formatBytes(doc.size)}`,
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

function saveUploads(uploads) {
  localStorage.setItem(UPLOAD_KEY, JSON.stringify(uploads.slice(0, 30)));
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
  if (!time) return 'now';
  return new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
