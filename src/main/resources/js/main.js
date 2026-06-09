import { initChat } from './chat.js';
import { store } from './store.js';
import { initRightPanel } from './right-panel.js';

window.store = store;

initChat(document.getElementById('chatWorkspace'));
initRightPanel();
