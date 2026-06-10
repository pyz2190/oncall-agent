import { initChat } from './chat.js';
import { initCommand } from './command.js';
import { store } from './store.js';
import { initRightPanel } from './right-panel.js';

window.store = store;

initChat(document.getElementById('chatWorkspace'));
initRightPanel();
initCommand();
