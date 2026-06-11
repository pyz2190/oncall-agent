export const API_BASE = '/api';

const FEEDBACK_KEY = 'oncall.feedback';
const UI_PREFS_KEY = 'oncall.uiPrefs';

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const store = {
  sessionId: 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  messages: [],
  automationMode: 'confirm',
  aiopsReportText: '',
  uploadedDocs: [],
  pendingActions: [],
  feedback: loadJson(FEEDBACK_KEY, []),
  evidenceByMessage: {},
  uiPrefs: loadJson(UI_PREFS_KEY, { theme: 'light', fontScale: 1, highContrast: false }),
  agentStatus: '就绪',
  contextSummary: '暂无上下文',
  listeners: [],

  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(item => item !== listener);
    };
  },

  notify() {
    this.listeners.forEach(listener => listener(this));
  },

  setState(newState) {
    Object.assign(this, newState);
    this.notify();
  },

  addMessage(message) {
    this.messages = [...this.messages, message];
    this.notify();
  },

  addUploadedDoc(doc) {
    this.uploadedDocs = [doc, ...this.uploadedDocs.filter(item => item.name !== doc.name)];
    this.notify();
  },

  addAction(action) {
    this.pendingActions = [...this.pendingActions, action];
    this.notify();
  },

  setAgentStatus(status) {
    this.agentStatus = status || '就绪';
    this.notify();
  },

  setContextSummary(summary) {
    this.contextSummary = summary || '暂无上下文';
    this.notify();
  },

  setEvidence(messageId, evidenceItems) {
    this.evidenceByMessage = {
      ...this.evidenceByMessage,
      [messageId]: evidenceItems || []
    };
    this.notify();
  },

  addFeedback(feedbackItem) {
    const next = [
      {
        ...feedbackItem,
        createdAt: feedbackItem.createdAt || Date.now()
      },
      ...this.feedback.filter(item => (
        item.messageId !== feedbackItem.messageId || item.type !== feedbackItem.type
      ))
    ].slice(0, 100);
    this.feedback = next;
    saveJson(FEEDBACK_KEY, next);
    this.notify();
  },

  setUiPrefs(prefs) {
    this.uiPrefs = {
      ...this.uiPrefs,
      ...prefs
    };
    saveJson(UI_PREFS_KEY, this.uiPrefs);
    this.notify();
  },

  async resolveAction(actionId, approved) {
    const action = this.pendingActions.find(item => item.id === actionId);

    if (action) {
      try {
        await fetch(`${API_BASE}/actions/${encodeURIComponent(actionId)}/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved, operator: 'frontend' })
        });
      } catch (error) {
        console.warn(`[store] Action ${actionId} decision sync failed`, error);
      }
    }

    this.pendingActions = this.pendingActions.filter(item => item.id !== actionId);
    this.notify();
  }
};

window.store = store;
