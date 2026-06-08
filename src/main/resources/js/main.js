// js/main.js
import { store } from './store.js';
import { initRightPanel } from './right-panel.js';

// 可以挂载全局 store 方便调试
window.store = store;

// 初始化右侧面板
initRightPanel();

// 等待其他成员模块加载（可选，占位）
console.log('OnCall Agent 已启动，sessionId:', store.sessionId);