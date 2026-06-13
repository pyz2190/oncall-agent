# 智能 OnCall Agent · 功能与 HCI 契合介绍稿

> 一句话定位：把「告警读取 → 日志检索 → 知识库溯源 → 多 Agent 推理 → 诊断报告 → 人工审批与交接」整合进同一个 Web 工作台的 **人机协同 AIOps 值班助手**。它不追求"AI 直接给结论"，而是让排障过程**可见、可控、可信、可交接**。

---

## 一、它解决的问题

传统 OnCall 排障有三个固有痛点，本项目逐一对应：

| 痛点 | 本项目的应对 |
|---|---|
| 告警、日志、文档分散在多个平台，频繁切换工具 | 单一工作台聚合 Prometheus 告警、CLS 日志、Milvus 知识库三类数据源 |
| AI 直接给结论，缺推理过程、证据来源、人工确认 | Agent 思考时间线 + 证据溯源 + 审批门控，把黑盒拆成可观察的阶段 |
| 排查完还要手工整理事故报告，交接困难 | 结构化诊断报告 + Markdown/PDF 导出，直接用于值班交接与复盘 |

---

## 二、系统架构

前后端一体的 Spring Boot 应用，单服务监听 `http://localhost:9900`。

```
浏览器前端 (原生 HTML/CSS/JS)
   │  REST + SSE
后端 Spring Boot
   ├─ ChatController      会话 / 流式对话 / AIOps 编排 / 审批决策
   ├─ EvidenceController  证据检索（点击式溯源）
   ├─ FileUploadController 知识库上传
   ├─ ChatService         模型创建 / 提示词 / 工具注册 / ReactAgent
   ├─ AiOpsService        Planner + Executor + Supervisor 多 Agent 编排
   ├─ AutomationGateService 审批门控（CountDownLatch 真实阻塞）
   └─ RAG / Vector*       文档切分、向量化、检索
   │
   ├─ DashScope (Qwen 系列)     对话、推理、报告生成
   ├─ Milvus 向量库             知识库检索与证据引用
   ├─ Prometheus               告警/指标（当前 mock，演示稳定）
   └─ 腾讯云 CLS MCP Server     真实日志查询（SSE MCP 接入）
```

**技术栈**：Java 17 · Spring Boot · Spring AI Alibaba（ReactAgent / SupervisorAgent / Graph）· DashScope Qwen · Milvus · MCP（Model Context Protocol）· SSE 流式。

---

## 三、功能全景

### A. 智能对话与 Agent 推理

1. **多轮流式对话**（`/api/chat_stream`，SSE）
   - 模型回复以 chunk 形式实时推送，避免长等待的黑盒感。
   - 后端维护**会话记忆窗口**（每个 session 保留最近 6 组问答对，线程安全），支持多轮上下文。
   - 同时提供非流式 `/api/chat` 作为兜底。

2. **Agent 思考时间线**（结构化 `agent_step` 事件）
   - 后端把真实执行阶段拆成结构化节点：`构建上下文(reason)` → `注册工具(action)` → `模型推理(reason)` → `工具调用完成(observation)` → `模型输出完成 / 会话写入(final)`。
   - 每个步骤带 `phase / label / detail / toolName / status / timestamp`，前端据此渲染 Reason–Action–Observation–Final 时间线（文本关键字解析仅作降级兜底）。

3. **工具调用（ReAct 范式）**，后端注册四类本地工具：
   - `getCurrentDateTime` 时间工具
   - `queryPrometheusAlerts` Prometheus 告警查询（mock/真实双模式）
   - `queryInternalDocs` 知识库 RAG 检索
   - `queryLogs` / 腾讯云 CLS MCP 日志查询（mock 时走本地工具，真实时走 MCP）
   - 设计上**普通聊天默认只注册本地安全工具**，降低外部工具 schema 对基础对话的干扰。

### B. AIOps 自动诊断（多 Agent 协作）

4. **Planner + Executor + Supervisor 三角色编排**（`/api/ai_ops`，SSE）
   - **Planner（兼 Replanner）**：拆解告警、规划/再规划下一步，输出 `decision = PLAN | EXECUTE | FINISH`。
   - **Executor**：只执行 Planner 的第一步，收集日志/指标/文档证据并结构化回传。
   - **Supervisor**：调度二者形成「规划 → 执行 → 再规划」闭环，直至 FINISH。
   - 强约束 **禁止编造数据**：同一工具连续 3 次失败即终止该方向，并在报告中如实说明"无法完成"的原因。

5. **结构化诊断报告 + 图表数据**（`report_data` 事件）
   - 报告严格遵循固定 Markdown 模板：活跃告警清单 → 逐告警根因分析 → 处理方案执行 → 结论 / 风险评估。
   - 后端从报告文本解析出 `report_data`（告警表行、根因、日志证据、处理步骤、按类型/严重度的分布统计），前端**优先用结构化数据渲染卡片、告警表和统计图**，不再依赖前端假数据；无数据时显示空状态。
   - **失败/超时也产出真实结构化报告**：90 秒超时或工具链异常时，生成"诊断未完成"报告而非编造结论，明确指出可能原因（DashScope 耗时、MCP 可达性、网络等）。

### C. 知识库与证据溯源

6. **知识库上传与自动向量化**（`/api/upload`）
   - 上传 `.md` / `.txt` 文档 → 切分 → 向量化 → 写入 Milvus。
   - 仓库内置 10 份 runbook（CPU/内存/磁盘高占用、服务不可用、慢响应、证书过期、连接池耗尽、消息积压、网络分区、Pod CrashLoop）。

7. **点击式证据溯源**（`/api/evidence/search`）
   - Agent 回答下方展示 `[1] [2]` 式来源标记，可点击展开原始知识库片段（含标题、片段、相似度分数、元数据）。
   - 提示词层面也强约束：用了文档/日志/告警证据必须说明出处，没证据要声明需补数据。

### D. 人机协同与可访问性

8. **三档自动化 + 后端真实审批门控**
   - 手动 / 确认 / 自动三档。
   - **关键点：审批不是前端按钮假象，而是后端用 `CountDownLatch` 真正阻塞工具链**——`action_required` 事件创建待审批动作，前端确认卡调 `/api/actions/{id}/decision`，批准才放行、拒绝或 5 分钟超时则取消，全程 `action_status` 回传。

9. **语音输入**：浏览器 Web Speech API 转写后走正常聊天流，适合夜间值班/不便打字场景（无需后端改动）。

10. **反馈闭环**：每条回复可标记"有帮助 / 没帮助 / 推理有问题"，形成人机协作闭环并为优化留数据。

11. **事故报告导出与交接**：诊断结果可导出 Markdown 或打印为 PDF 交接报告。

12. **命令中心与快捷键**：命令面板 + slash 命令（`/clear` `/aiops` `/upload` `/help` `/search` `/mode`）+ `Ctrl/Cmd+K/U/L/Enter`、`Esc`，以及本地搜索高亮。

13. **可访问性设置**：深色模式、字号调节、高对比模式，适配夜间值班与不同阅读需求（localStorage 持久化）。

14. **上手引导与上下文感知**：首次进入展示示例问题与上传引导（空状态）；持续摘要当前排障上下文与已索引文档。

---

## 四、与 HCI 的契合点（答辩核心）

每个 HCI 原则都映射到**具体可演示的交互**，而非口号：

| HCI 原则 | 在本系统中的体现 | 支撑的技术实现 |
|---|---|---|
| **可见性 / 系统状态可见**（Visibility of system status） | Agent 思考时间线让用户实时看到 AI 处于"思考/行动/观察/总结"哪个阶段；全局状态指示器显示"思考中/检索证据/生成报告" | 结构化 `agent_step` SSE 事件 + 流式 chunk |
| **用户控制与自由**（User control & freedom） | 高风险工具链执行前必须经确认卡批准；可拒绝、可切换自动化档位 | `AutomationGateService` 后端 `CountDownLatch` 门控 + 决策 API |
| **可信度 / 减少黑盒**（Trust & transparency） | 回答与报告展示证据来源、可展开原文；强约束禁止编造、失败如实说明 | 证据溯源 API + RAG + Planner/Executor 防幻觉提示词 |
| **匹配真实世界 / 一致性** | 报告固定模板与右侧图表数据一致；告警类型/严重度统一归一化 | `report_data` 结构化解析，前端优先渲染 |
| **容错与诚实失败**（Error prevention / honesty） | 超时、失败、空结果都生成结构化"未完成"报告，不伪造根因 | 超时(90s)/异常分支的 `buildAiOpsFailureReport` |
| **可学习性 / 易上手**（Learnability） | 空状态示例问题、清晰中文按钮、命令面板与快捷键降低上手成本 | 命令中心 + onboarding 空状态 |
| **可访问性**（Accessibility） | 深色模式、字号、高对比适配夜间与不同视力需求；语音输入降低打字门槛 | CSS 主题变量 + Web Speech API |
| **协作性 / 工作交接**（Collaboration & handoff） | 反馈机制形成人机闭环；事故报告导出支撑值班交接与复盘 | 反馈状态 + Markdown/PDF 导出 |

**一句话总结契合点**：系统把 AI 从"给答案的黑盒"重构成"可被人类监督、纠正、接管的协作者"——这正是 Human-AI Interaction 的核心议题（透明性、可控性、信任校准、人在回路）。

---

## 五、技术亮点（可在答辩强调）

- **SSE 全链路流式契约**：`content` / `agent_step` / `action_required` / `action_status` / `report_data` / `done` / `error` 七类事件，前后端契约清晰，时间线、审批、报告全部事件驱动。
- **后端真实审批门控**：不是前端假按钮，而是后端线程级阻塞，体现"人在回路"的真实工程实现。
- **多 Agent 编排闭环**：Planner/Executor/Supervisor 的规划-执行-再规划，并带防幻觉与失败终止策略。
- **MCP 工具接入**：通过 SSE MCP Server 接入腾讯云 CLS 真实日志能力，Prometheus 保留 mock 保证课堂演示稳定。
- **RAG 证据闭环**：Markdown → Milvus → 检索 → 可点击溯源，让结论可追溯到原文。

---

## 六、推荐演示流程（5 分钟脚本）

1. 打开首页，展示工作台整体布局与空状态引导。
2. 聊天框输入普通问题 → 展示**流式回复**与 **Agent 思考时间线**。
3. 切换深色/字号/高对比 → 说明**可访问性**设计。
4. 右侧 AIOps 面板选「确认」模式运行 → 展示后端**审批确认卡**；**拒绝一次**，说明后端真的不会执行工具链。
5. 再选「自动」模式运行 → 展示告警报告、右侧**结构化图表**与告警表。
6. 展示**证据来源**点击展开、**反馈按钮**、**报告导出**。
7. 说明腾讯云 CLS MCP 已接入、Prometheus 当前为 mock 以保证演示稳定。

---

## 七、演示环境

| 组件 | 地址 / 说明 |
|---|---|
| 后端 | `http://localhost:9900` |
| 腾讯云 CLS MCP SSE | `http://localhost:3000/sse` |
| Milvus | `localhost:19530` |
| DashScope | 需有效 API Key 且账号不欠费 |
| Prometheus | 当前 mock 模式，便于稳定展示告警与指标 |

> 启动：`docker compose -f vector-database.yml up -d` 起 Milvus，`make init` 灌入示例 runbook，`mvn spring-boot:run` 启动服务。
</content>
</invoke>
