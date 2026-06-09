# Frontend Interface Guide for OnCall Agent

This document records the frontend modules and the backend interfaces they use. The current frontend is served from `src/main/resources`, and all API calls use the shared `API_BASE` exported by `src/main/resources/js/store.js`.

## Module Scope

| Module | Files | Container | Responsibility |
|---|---|---|---|
| Chat workspace | `js/chat.js`, `styles.css` | `#chatWorkspace` | Streaming chat, visible process timeline, voice input |
| Insight panel | `js/right-panel.js`, `styles.css` | `#rightPanel` | AIOps diagnosis report, charts, automation mode, confirmation card |
| Sidebar and command area | Not implemented yet | `#leftSidebar` | Session list, upload entry, command palette |

## HCI Feature Mapping

| Feature | Frontend Behavior | Backend Data / API | Current Status |
|---|---|---|---|
| Streaming chat | Send a question, render the assistant response as chunks arrive, and save both sides to `store.messages` | `POST /api/chat_stream` | Implemented in `js/chat.js` |
| Agent process timeline | Classify visible streamed text into Reason, Action, Observation, and Final nodes | `POST /api/chat_stream` SSE text | Implemented with keyword-based parsing |
| Voice input | Use browser speech recognition, preview transcript in the input box, then send it through the normal chat flow | Browser Web Speech API + `POST /api/chat_stream` | Implemented in `js/chat.js`; no backend change required |
| Structured diagnosis report | Stream the AIOps report and render cards/charts from the Markdown text | `POST /api/ai_ops` | Existing implementation in `js/right-panel.js` |
| Automation mode | Switch Manual, Confirm, and Auto modes in shared frontend state | Frontend state only | Existing implementation |
| Confirmation card | Show pending tool actions for approval in Confirm mode | Reserved for future write-side tool flow | Existing local implementation |
| Knowledge upload | Upload a document for indexing | `POST /api/upload` | Backend exists; sidebar UI not implemented yet |
| Session clear | Clear server-side chat history for the current session | `POST /api/chat/clear` | Backend exists; command UI not implemented yet |
| Session metadata | Read retained message-pair count and creation time | `GET /api/chat/session/{sessionId}` | Backend exists; frontend UI not implemented yet |
| Milvus health check | Check vector database connectivity | `GET /milvus/health` | Backend exists; frontend UI not implemented yet |

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
