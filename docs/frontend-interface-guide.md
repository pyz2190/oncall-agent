# Frontend Interface Guide for OnCall Agent

This document records the frontend modules and the backend interfaces they use. The current frontend is served from `src/main/resources`, and all API calls use the shared `API_BASE` exported by `src/main/resources/js/store.js`.

## Module Scope

| Module | Files | Container | Responsibility |
|---|---|---|---|
| Chat workspace | `js/chat.js`, `styles.css` | `#chatWorkspace` | Streaming chat, visible process timeline, voice input, evidence provenance, feedback, status, context hints |
| Insight panel | `js/right-panel.js`, `styles.css` | `#rightPanel` | AIOps diagnosis report, charts, export handoff, automation mode, confirmation card |
| Sidebar and command area | `js/command.js`, `js/dom.js`, `styles.css` | `#leftSidebar`, `#command-palette` | Session list, upload entry, command palette, local search, shortcuts, accessibility preferences |

## HCI Feature Mapping

| Feature | Frontend Behavior | Backend Data / API | Current Status |
|---|---|---|---|
| Streaming chat | Send a question, render the assistant response as chunks arrive, and save both sides to `store.messages` | `POST /api/chat_stream` | Implemented in `js/chat.js` |
| Agent process timeline | Render backend `agent_step` events as Reason, Action, Observation, and Final nodes; text keyword parsing remains only as fallback | `POST /api/chat_stream` SSE `agent_step` | Implemented with structured backend events |
| Voice input | Use browser speech recognition, preview transcript in the input box, then send it through the normal chat flow | Browser Web Speech API + `POST /api/chat_stream` | Implemented in `js/chat.js`; no backend change required |
| Structured diagnosis report | Stream the AIOps report and render cards/charts from backend `report_data`; Markdown parsing remains only as fallback | `POST /api/ai_ops` SSE `report_data` | Implemented in `js/right-panel.js` |
| Automation mode | Manual/Confirm pauses backend AIOps tool execution until approval; Auto approves the backend action gate directly | `POST /api/ai_ops`, `POST /api/actions/{actionId}/decision` | Implemented with backend approval gate |
| Confirmation card | Show pending backend tool action and send approve/reject decision back to the server | `action_required` SSE + decision API | Implemented in `js/right-panel.js` |
| Knowledge upload | Upload `.md` and `.txt` files as multipart form data and keep local upload status | `POST /api/upload` | Implemented in `js/command.js` |
| Session clear | Clear server-side chat history for the current session and reset local chat view | `POST /api/chat/clear` | Implemented in `js/command.js` |
| Session metadata | Read retained message-pair count and creation time | `GET /api/chat/session/{sessionId}` | Backend exists; frontend UI not implemented yet |
| Milvus health check | Check vector database connectivity | `GET /milvus/health` | Backend exists; frontend UI not implemented yet |
| Command palette and shortcuts | Support `/clear`, `/aiops`, `/upload`, `/help`, `/search`, `/mode`, Ctrl/Cmd shortcuts, and Esc close | Existing APIs plus frontend events | Implemented in `js/command.js` |
| Local search and highlighting | Search `store.messages`, `store.aiopsReportText`, and uploaded document names | Frontend state only | Implemented in `js/command.js` |
| Evidence provenance | Show clickable `[1] [2]`-style source markers below assistant answers and expand the original knowledge snippet | `POST /api/evidence/search` | Implemented in `js/chat.js` and `EvidenceController` |
| Feedback loop | Let users mark each assistant answer as helpful, not helpful, or reasoning issue | Frontend localStorage key `oncall.feedback` | Implemented in `js/chat.js` |
| Export and handoff | Export the current diagnosis as Markdown or open a print-to-PDF handoff report | `POST /api/ai_ops` result + frontend export | Implemented in `js/right-panel.js` |
| Accessibility settings | Toggle dark mode, high contrast mode, and font size | Frontend localStorage key `oncall.uiPrefs` | Implemented in `js/command.js` and `styles.css` |
| Agent status indicator | Show global status such as thinking, retrieving evidence, and report generation | Shared frontend state `store.agentStatus` | Implemented in `js/chat.js` and `js/right-panel.js` |
| Onboarding / empty state | Show example questions and upload guidance before the first message | Frontend only | Implemented in `js/chat.js` |
| Context awareness | Summarize the active troubleshooting context and uploaded indexed docs | Shared frontend state `store.contextSummary` | Implemented in `js/chat.js` |

## Existing Backend APIs

| API | Method | Request Body | Response Type | Frontend Use |
|---|---|---|---|---|
| `/api/chat` | `POST` | `{ "Id": "session-001", "Question": "..." }` | JSON: `{ code, message, data: { success, answer, errorMessage } }` | Non-streaming fallback chat |
| `/api/chat_stream` | `POST` | `{ "Id": "session-001", "Question": "..." }` | SSE: `content`, `agent_step`, `done`, `error` | Main chat interface and structured agent timeline |
| `/api/ai_ops` | `POST` | `{ "automationMode": "manual|confirm|auto", "sessionId": "..." }` | SSE: `action_required`, `action_status`, `agent_step`, `content`, `report_data`, `done`, `error` | AIOps approval flow, report stream, structured charts |
| `/api/actions/{actionId}/decision` | `POST` | `{ "approved": true, "operator": "frontend" }` | JSON: `{ code, message, data: { id, status, approved, ... } }` | Approve or reject a pending backend tool action |
| `/api/upload` | `POST multipart/form-data` | field `file` | JSON: `{ code, message, data: { fileName, filePath, fileSize } }` | Knowledge document upload |
| `/api/evidence/search` | `POST` | `{ "query": "...", "topK": 3 }` | JSON: `{ code, message, data: [{ index, id, title, snippet, score, metadata }] }` | Clickable evidence provenance for assistant answers |
| `/api/chat/clear` | `POST` | `{ "Id": "session-001" }` | JSON: `{ code, message, data }` | Clear one session |
| `/api/chat/session/{sessionId}` | `GET` | none | JSON: `{ code, message, data: { sessionId, messagePairCount, createTime } }` | Session metadata |
| `/milvus/health` | `GET` | none | JSON: `{ message, collections }` or `{ error }` | Vector database health check |

## Member A Interface Check

Member A only needs the streaming chat interface:

```http
POST /api/chat_stream
Content-Type: application/json

{
  "Id": "session-001",
  "Question": "服务不可用告警应该怎么处理？"
}
```

The backend `ChatRequest` accepts `Id` and `Question`, with aliases for lowercase variants. The frontend now sends the exact documented field names, so the request body matches the controller.

The response format also matches the shared SSE parser:

```text
data: {"type":"content","data":"partial answer"}
data: {"type":"agent_step","data":{"phase":"action","label":"工具调用完成","detail":"..."}}
data: {"type":"done","data":null}
```

No new backend API is required for member A. Voice input uses the browser Web Speech API and then sends text through `/api/chat_stream`.

## Member C Interface Check

Member C uses existing backend interfaces and does not require new endpoints.

### Clear Chat

```http
POST /api/chat/clear
Content-Type: application/json

{
  "Id": "session-001"
}
```

The frontend sends the current `store.sessionId`. After the request, it clears local `store.messages` and dispatches `chat:clear` so the chat workspace can reset its own view.

### Upload Knowledge Document

```http
POST /api/upload
Content-Type: multipart/form-data

file=@service_unavailable.md
```

The frontend accepts `.md` and `.txt` files, sends each file with multipart field name `file`, and stores upload status locally for search and display.

### Local Commands

| Command | Behavior | Backend API |
|---|---|---|
| `/clear` | Clear current session | `POST /api/chat/clear` |
| `/aiops` | Dispatch `aiops:run` to the insight panel | `POST /api/ai_ops` through existing insight panel code |
| `/upload` | Open file picker | `POST /api/upload` after file selection |
| `/help` | Show command list | none |
| `/search keyword` | Search local chat, report text, and upload names | none |
| `/mode manual|confirm|auto` | Switch shared automation mode | none |

Keyboard shortcuts:

```text
Ctrl / Cmd + K      Open command palette
Ctrl / Cmd + U      Open upload picker
Ctrl / Cmd + L      Clear current session
Ctrl / Cmd + Enter  Submit chat input
Esc                 Close command palette
```
