# Frontend Interface Guide for OnCall Agent

This document records the frontend modules and the backend interfaces they use. The current frontend is served from `src/main/resources`, and all API calls use the shared `API_BASE` exported by `src/main/resources/js/store.js`.

## Module Scope

| Module | Files | Container | Responsibility |
|---|---|---|---|
| Chat workspace | `js/chat.js`, `styles.css` | `#chatWorkspace` | Streaming chat, visible process timeline, voice input |
| Insight panel | `js/right-panel.js`, `styles.css` | `#rightPanel` | AIOps diagnosis report, charts, automation mode, confirmation card |
| Sidebar and command area | `js/command.js`, `js/dom.js`, `styles.css` | `#leftSidebar`, `#command-palette` | Session list, upload entry, command palette, local search, shortcuts |

## HCI Feature Mapping

| Feature | Frontend Behavior | Backend Data / API | Current Status |
|---|---|---|---|
| Streaming chat | Send a question, render the assistant response as chunks arrive, and save both sides to `store.messages` | `POST /api/chat_stream` | Implemented in `js/chat.js` |
| Agent process timeline | Classify visible streamed text into Reason, Action, Observation, and Final nodes | `POST /api/chat_stream` SSE text | Implemented with keyword-based parsing |
| Voice input | Use browser speech recognition, preview transcript in the input box, then send it through the normal chat flow | Browser Web Speech API + `POST /api/chat_stream` | Implemented in `js/chat.js`; no backend change required |
| Structured diagnosis report | Stream the AIOps report and render cards/charts from the Markdown text | `POST /api/ai_ops` | Existing implementation in `js/right-panel.js` |
| Automation mode | Switch Manual, Confirm, and Auto modes in shared frontend state | Frontend state only | Existing implementation |
| Confirmation card | Show pending tool actions for approval in Confirm mode | Reserved for future write-side tool flow | Existing local implementation |
| Knowledge upload | Upload `.md` and `.txt` files as multipart form data and keep local upload status | `POST /api/upload` | Implemented in `js/command.js` |
| Session clear | Clear server-side chat history for the current session and reset local chat view | `POST /api/chat/clear` | Implemented in `js/command.js` |
| Session metadata | Read retained message-pair count and creation time | `GET /api/chat/session/{sessionId}` | Backend exists; frontend UI not implemented yet |
| Milvus health check | Check vector database connectivity | `GET /milvus/health` | Backend exists; frontend UI not implemented yet |
| Command palette and shortcuts | Support `/clear`, `/aiops`, `/upload`, `/help`, `/search`, `/mode`, Ctrl/Cmd shortcuts, and Esc close | Existing APIs plus frontend events | Implemented in `js/command.js` |
| Local search and highlighting | Search `store.messages`, `store.aiopsReportText`, and uploaded document names | Frontend state only | Implemented in `js/command.js` |

## Existing Backend APIs

| API | Method | Request Body | Response Type | Frontend Use |
|---|---|---|---|---|
| `/api/chat` | `POST` | `{ "Id": "session-001", "Question": "..." }` | JSON: `{ code, message, data: { success, answer, errorMessage } }` | Non-streaming fallback chat |
| `/api/chat_stream` | `POST` | `{ "Id": "session-001", "Question": "..." }` | SSE: `data: { "type": "content" \| "done" \| "error", "data": "..." }` | Main chat interface for member A |
| `/api/ai_ops` | `POST` | none | SSE: `data: { "type": "content" \| "done" \| "error", "data": "..." }` | AIOps report stream |
| `/api/upload` | `POST multipart/form-data` | field `file` | JSON: `{ code, message, data: { fileName, filePath, fileSize } }` | Knowledge document upload |
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
