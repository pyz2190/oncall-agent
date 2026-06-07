# Frontend Interface Guide for OnCall Agent

This document describes the frontend features planned for the HCI-oriented OnCall Agent console and the backend APIs each feature should call.

## Overall Product Concept

The upgraded OnCall Agent should be presented as a **Human-AI Collaborative OnCall Console**, not just a chatbot.

The goal is to help on-call engineers understand incidents faster by combining:

- natural language interaction
- transparent agent reasoning
- structured incident diagnosis
- evidence-based RAG retrieval
- command-based navigation
- controllable automation
- searchable history and source highlighting

The backend keeps responsibility for chat, RAG, document indexing, tool calling, and AIOps diagnosis. The frontend owns the interaction layer and should make the agent's process visible and controllable.

## Recommended Frontend Layout

```text
OnCall Agent Console
├── Left Sidebar
│   ├── Session List
│   ├── Knowledge Upload
│   └── Command Shortcuts
├── Center Workspace
│   ├── Chat Panel
│   ├── Voice Input
│   └── Slash Command Input
├── Right Insight Panel
│   ├── Agent Timeline
│   ├── Evidence Sources
│   └── Automation Mode
└── AIOps Report View
    ├── Alert Cards
    ├── Root Cause Cards
    ├── Log Evidence
    ├── Action Steps
    └── Summary / Risk Level
```

## HCI Feature Table

| New Feature | HCI Course Module | Frontend Behavior | Backend Data / API | Current Backend Support | Frontend Work Needed |
|---|---|---|---|---|---|
| Agent reasoning timeline | Direct Manipulation / Transparency | Visualize Reason → Action → Observation → Final as a timeline | `POST /api/chat_stream`, `POST /api/ai_ops` SSE streams | Partially supported through streamed text | Parse SSE text first; optionally request structured SSE events later |
| Voice input | Expressive Human and Command Languages / Speech Recognition | Convert speech to text, preview the transcript, then send it as a question | Browser Web Speech API + `POST /api/chat_stream` | Supported; no backend change needed | Add microphone UI, recording state, transcript editing, and send action |
| Structured diagnosis report | Data Visualization | Convert AIOps report into alert cards, root cause cards, log evidence, steps, severity, and charts | `POST /api/ai_ops` SSE stream | Supported as streamed Markdown text | Parse report sections and render them as cards and charts |
| Confirmation cards and automation levels | Control / Trust / Direct Manipulation | Provide Manual, Confirm, and Auto modes; ask for confirmation before risky actions | Frontend local state for now | Not required for current read-only tools | Add mode switch and confirmation card UI |
| Command palette and slash commands | Expressive Command Languages / Fluid Navigation | Support `/clear`, `/upload`, `/aiops`, `/help`, `/search`, `/mode` | Existing REST/SSE APIs | Supported through API mapping | Implement command parser and keyboard shortcuts |
| Search and highlighting | Information Search | Search chat history, diagnosis reports, uploaded document names, and highlight matches | Existing streamed content plus local message cache | Partially supported | Store frontend-side messages and parsed reports; optionally add backend history/source APIs later |

## Existing Backend APIs

| API | Method | Request Body | Response Type | Use Case |
|---|---|---|---|---|
| `/api/chat` | `POST` | `{ "Id": "session-001", "Question": "..." }` | JSON | Non-streaming chat |
| `/api/chat_stream` | `POST` | `{ "Id": "session-001", "Question": "..." }` | SSE | Main streaming chat |
| `/api/ai_ops` | `POST` | none | SSE | Automated incident diagnosis |
| `/api/upload` | `POST multipart/form-data` | `file=@runbook.md` | JSON | Upload and index a knowledge document |
| `/api/chat/clear` | `POST` | `{ "Id": "session-001" }` | JSON | Clear a session |
| `/api/chat/session/{sessionId}` | `GET` | none | JSON | Read session metadata |
| `/milvus/health` | `GET` | none | JSON | Check vector database connection |

## Request Examples

### Streaming Chat

```http
POST /api/chat_stream
Content-Type: application/json

{
  "Id": "session-001",
  "Question": "How should I handle a service unavailable alert?"
}
```

### AIOps Diagnosis

```http
POST /api/ai_ops
```

### Upload Runbook

```bash
curl -X POST http://localhost:9900/api/upload \
  -F "file=@aiops-docs/service_unavailable.md"
```

### Clear Session

```http
POST /api/chat/clear
Content-Type: application/json

{
  "Id": "session-001"
}
```

## Feature Details

### 1. Agent Reasoning Timeline

Frontend should display the agent process in a timeline:

```text
[Reason] The user is asking about a service unavailable alert.
[Action] queryPrometheusAlerts
[Observation] Found ServiceUnavailable and HighCPUUsage alerts.
[Action] queryInternalDocs
[Observation] Retrieved the service unavailable runbook.
[Final] Generated diagnosis and response plan.
```

Current backend support:

- `POST /api/chat_stream`
- `POST /api/ai_ops`

Current SSE messages are text-oriented. The frontend can start with keyword parsing:

- `query`
- `tool`
- `alert`
- `log`
- `root cause`
- `recommendation`
- `report`

Future backend enhancement:

```json
{ "type": "reason", "data": "Need to inspect active alerts first." }
```

```json
{ "type": "action", "tool": "queryPrometheusAlerts", "params": {} }
```

```json
{ "type": "observation", "data": "Found 3 active alerts." }
```

### 2. Voice Input

No backend change is required. Use the browser Web Speech API:

```js
const recognition = new window.webkitSpeechRecognition();
recognition.lang = "zh-CN";
recognition.continuous = false;
recognition.interimResults = true;
```

Frontend should provide:

- microphone button
- recording indicator
- live transcript preview
- manual transcript edit
- send button
- recognition failure message

The final transcript should be sent to:

```text
POST /api/chat_stream
```

### 3. Structured AIOps Report Visualization

Call:

```text
POST /api/ai_ops
```

Parse the streamed Markdown report into:

- alert summary
- root cause
- log evidence
- executed steps
- suggested actions
- risk level

Recommended UI components:

- alert cards
- severity tags
- root cause cards
- collapsible log evidence panel
- action checklist
- risk badge
- simple charts for alert type, severity, and duration

Since the current backend does not expose time-series metrics, trend charts can use derived report data first.

### 4. Confirmation Cards and Automation Levels

Frontend modes:

```text
Manual: Agent only suggests actions.
Confirm: User approval is required before risky actions.
Auto: Low-risk actions may run automatically.
```

Current backend tools are primarily query-oriented, so this can be implemented as frontend state first.

Example confirmation card:

```text
Agent wants to query application logs.
Risk: Low
Action: queryLogs
[Approve] [Reject]
```

Future backend endpoint if write-side operations are added:

```http
POST /api/tool/confirm
Content-Type: application/json

{
  "sessionId": "session-001",
  "toolCallId": "tool-123",
  "approved": true
}
```

### 5. Command Palette and Slash Commands

| Slash Command | Frontend Behavior | API |
|---|---|---|
| `/clear` | Clear current session | `POST /api/chat/clear` |
| `/aiops` | Start AIOps diagnosis | `POST /api/ai_ops` |
| `/upload` | Open upload panel | `POST /api/upload` |
| `/help` | Show command list | Frontend local |
| `/search keyword` | Search local history and reports | Frontend local |
| `/mode manual` | Switch to manual mode | Frontend local |
| `/mode confirm` | Switch to confirmation mode | Frontend local |
| `/mode auto` | Switch to auto mode | Frontend local |

Recommended shortcuts:

```text
Ctrl / Cmd + K      Open command palette
Ctrl / Cmd + U      Open upload panel
Ctrl / Cmd + L      Clear current session
Ctrl / Cmd + Enter  Send question
Esc                 Close dialog
```

### 6. Search and Highlighting

Frontend should support:

- search current chat
- search AIOps report
- search uploaded document names
- highlight keyword matches
- jump to matched message or report section

Short-term implementation:

- store streamed chat messages in frontend state
- store parsed AIOps report sections in frontend state
- search locally

Suggested future backend APIs:

```text
GET /api/chat/session/{sessionId}/history
GET /api/knowledge/sources
GET /api/knowledge/sources/{fileName}
POST /api/ai_ops/json
```

## Vibe Coding Prompt

Use this prompt when generating the frontend:

```text
Build a Human-AI OnCall Agent frontend.

The app should be an HCI-oriented incident response console, not a simple chatbot.

It has:
1. A central streaming chat workspace connected to POST /api/chat_stream.
2. A right-side Agent Timeline that visualizes Reason, Action, Observation, and Final Answer from SSE messages.
3. A voice input button using the browser Web Speech API.
4. An AIOps report dashboard connected to POST /api/ai_ops, parsing the streamed Markdown report into alert cards, root cause cards, log evidence, action steps, and risk summary.
5. A command palette opened by Ctrl/Cmd+K, supporting /clear, /upload, /aiops, /help, /search, and /mode commands.
6. A knowledge upload panel connected to POST /api/upload.
7. A local search panel that searches chat history and diagnosis reports with highlighted matches.
8. An automation mode switch with Manual, Confirm, and Auto modes. Risky actions should show a confirmation card before execution.

The design should emphasize transparency, controllability, information search, and reduced cognitive load for OnCall engineers.
```

## Suggested Development Order

1. Main chat page connected to `/api/chat_stream`
2. AIOps diagnosis view connected to `/api/ai_ops`
3. Structured report cards
4. Agent timeline
5. Voice input
6. Command palette
7. Search and highlighting
8. Automation modes and confirmation cards
