# OnCall Agent Backend

This repository contains the backend service for an intelligent OnCall assistant. It provides conversational diagnosis, runbook retrieval, document indexing, and an AIOps workflow for incident analysis.

The frontend is intentionally not included. Any web or mobile interface can call the REST and SSE APIs exposed by this service.

## Project Overview

The complete OnCall Agent project is designed as a human-AI collaborative incident response console. The backend provides the diagnosis and retrieval capabilities, while the frontend should focus on HCI-oriented interaction:

- transparent agent reasoning and diagnosis timelines
- voice-driven question input
- structured incident report visualization
- controllable automation levels
- command palette and slash commands
- searchable chat history and evidence highlighting

For the full frontend feature and API mapping table, see:

[docs/frontend-interface-guide.md](docs/frontend-interface-guide.md)

## Main Modules

```text
src/main/java/org/example
├── controller      HTTP endpoints for chat, file upload, and health checks
├── service         Chat, AIOps, RAG, vector indexing, and vector search logic
├── agent/tool      Tools exposed to the agent runtime
├── client          Milvus client initialization
├── config          Spring Boot configuration classes
├── dto             Request and response objects
└── constant        Shared vector database constants
```

## Features

- Multi-turn chat with session memory
- SSE streaming chat endpoint
- Runbook upload and automatic vector indexing
- RAG-based internal document retrieval
- AIOps diagnosis workflow based on planner, executor, and replanner roles
- Prometheus alert query tool
- CLS log query tool with mock mode for local demonstrations
- Milvus vector database integration

## Requirements

- Java 17
- Maven 3.8+
- Docker Desktop
- DashScope API key

## Configuration

Set the DashScope key before starting the service:

```bash
export DASHSCOPE_API_KEY=your-api-key
```

On Windows PowerShell:

```powershell
$env:DASHSCOPE_API_KEY="your-api-key"
```

The default configuration in `src/main/resources/application.yml` enables mock data for Prometheus and CLS logs. This makes local classroom demos repeatable without requiring external monitoring systems.

For a real deployment, update:

- `prometheus.base-url`
- `prometheus.mock-enabled=false`
- `cls.mock-enabled=false`
- Spring AI MCP SSE endpoint for Tencent CLS

## Run Locally

Start Milvus:

```bash
docker compose -f vector-database.yml up -d
```

Start the application:

```bash
mvn spring-boot:run
```

The API service listens on:

```text
http://localhost:9900
```

The original Makefile also provides:

```bash
make init
```

This starts the vector database and uploads the sample runbooks in `aiops-docs`.

## Core APIs

| API | Method | Purpose | Frontend Usage |
|---|---|---|---|
| `/api/chat` | `POST` | Non-streaming chat response | Simple Q&A |
| `/api/chat_stream` | `POST` | SSE streaming chat response | Main chat workspace and agent timeline |
| `/api/ai_ops` | `POST` | SSE AIOps diagnosis report | Incident report dashboard |
| `/api/upload` | `POST multipart/form-data` | Upload runbooks and index them into the vector store | Knowledge base upload panel |
| `/api/chat/clear` | `POST` | Clear one chat session | `/clear` slash command |
| `/api/chat/session/{sessionId}` | `GET` | Read session metadata | Session status panel |
| `/milvus/health` | `GET` | Check vector database status | System health indicator |

### Chat

```http
POST /api/chat
Content-Type: application/json

{
  "Id": "session-001",
  "Question": "How should I handle service unavailable alerts?"
}
```

### Streaming Chat

```http
POST /api/chat_stream
Content-Type: application/json

{
  "Id": "session-001",
  "Question": "Explain the current incident diagnosis steps."
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

### Milvus Health Check

```http
GET /milvus/health
```

## Notes for Course Demonstration

For an HCI project, this backend supports a human-AI collaborative OnCall interface. A separate frontend can visualize alert context, agent plans, retrieved evidence, and diagnosis timelines while calling these APIs.
