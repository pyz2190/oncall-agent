// js/store.js
export const store = {
  sessionId: 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  messages: [],            // 成员 A 写入
  automationMode: 'confirm',  // 'manual' | 'confirm' | 'auto'，成员 C / 右侧面板可改
  aiopsReportText: '',     // 成员 B 写入
  pendingActions: [],      // 成员 A 添加 Action，成员 B 消费

  // 监听器模式（简单版，让视图可以订阅变化）
  listeners: [],
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  },
  notify() {
    this.listeners.forEach(listener => listener(this));
  },
  setState(newState) {
    Object.assign(this, newState);
    this.notify();
  },
  // 便捷方法
  addAction(action) {
    this.pendingActions = [...this.pendingActions, action];
    this.notify();
  },
  resolveAction(actionId, approved) {
    this.pendingActions = this.pendingActions.filter(a => a.id !== actionId);
    if (approved) console.log(`[store] Action ${actionId} approved (simulated)`);
    this.notify();
  }
};

// 可选：挂载到 window 方便调试
window.store = store;