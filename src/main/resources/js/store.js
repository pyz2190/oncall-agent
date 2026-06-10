export const API_BASE = '/api';

export const store = {
  sessionId: 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  messages: [],
  automationMode: 'confirm',
  aiopsReportText: '',
  uploadedDocs: [],
  pendingActions: [],
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

  resolveAction(actionId, approved) {
    this.pendingActions = this.pendingActions.filter(action => action.id !== actionId);
    if (approved) {
      console.log(`[store] Action ${actionId} approved`);
    }
    this.notify();
  }
};

window.store = store;
