package org.example.controller;

import com.alibaba.cloud.ai.dashscope.api.DashScopeApi;
import com.alibaba.cloud.ai.dashscope.chat.DashScopeChatModel;
import com.alibaba.cloud.ai.dashscope.chat.DashScopeChatOptions;
import com.alibaba.cloud.ai.graph.NodeOutput;
import com.alibaba.cloud.ai.graph.OverAllState;
import com.alibaba.cloud.ai.graph.agent.ReactAgent;
import com.alibaba.cloud.ai.graph.streaming.OutputType;
import com.alibaba.cloud.ai.graph.streaming.StreamingOutput;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Getter;
import lombok.Setter;
import org.example.service.AutomationGateService;
import org.example.service.AiOpsService;
import org.example.service.ChatService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import reactor.core.publisher.Flux;

import java.io.IOException;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;

/**
 * REST and SSE endpoints for chat sessions, incident diagnosis, and session
 * management.
 */
@RestController
@RequestMapping("/api")
public class ChatController {

    private static final Logger logger = LoggerFactory.getLogger(ChatController.class);
    private static final ObjectMapper SSE_OBJECT_MAPPER = new ObjectMapper();

    @Autowired
    private AiOpsService aiOpsService;
    
    @Autowired
    private ChatService chatService;

    @Autowired
    private AutomationGateService automationGateService;

    @Autowired
    private ToolCallbackProvider tools;

    @Value("${aiops.analysis-timeout-seconds:90}")
    private long aiOpsAnalysisTimeoutSeconds;

    private final ExecutorService executor = Executors.newCachedThreadPool();

    private final Map<String, SessionInfo> sessions = new ConcurrentHashMap<>();
    
    /** Number of user/assistant message pairs retained for each session. */
    private static final int MAX_WINDOW_SIZE = 6;

    /**
     * Runs a non-streaming agent chat request and returns the complete answer.
     */
    @PostMapping("/chat")
    public ResponseEntity<ApiResponse<ChatResponse>> chat(@RequestBody ChatRequest request) {
        try {
            logger.info("收到对话请求 - SessionId: {}, Question: {}", request.getId(), request.getQuestion());

            if (request.getQuestion() == null || request.getQuestion().trim().isEmpty()) {
                logger.warn("问题内容为空");
                return ResponseEntity.ok(ApiResponse.success(ChatResponse.error("问题内容不能为空")));
            }

            SessionInfo session = getOrCreateSession(request.getId());
            
            List<Map<String, String>> history = session.getHistory();
            logger.info("会话历史消息对数: {}", history.size() / 2);

            DashScopeApi dashScopeApi = chatService.createDashScopeApi();
            DashScopeChatModel chatModel = chatService.createStandardChatModel(dashScopeApi);

            chatService.logAvailableTools();

            logger.info("开始 ReactAgent 对话（支持自动工具调用）");
            
            String systemPrompt = chatService.buildSystemPrompt(history);
            
            ReactAgent agent = chatService.createReactAgent(chatModel, systemPrompt);
            
            String fullAnswer = chatService.executeChat(agent, request.getQuestion());
            
            session.addMessage(request.getQuestion(), fullAnswer);
            logger.info("已更新会话历史 - SessionId: {}, 当前消息对数: {}", 
                request.getId(), session.getMessagePairCount());
            
            return ResponseEntity.ok(ApiResponse.success(ChatResponse.success(fullAnswer)));

        } catch (Exception e) {
            logger.error("对话失败", e);
            return ResponseEntity.ok(ApiResponse.success(ChatResponse.error(e.getMessage())));
        }
    }

    /**
     * Clears one chat session.
     */
    @PostMapping("/chat/clear")
    public ResponseEntity<ApiResponse<String>> clearChatHistory(@RequestBody ClearRequest request) {
        try {
            logger.info("收到清空会话历史请求 - SessionId: {}", request.getId());

            if (request.getId() == null || request.getId().isEmpty()) {
                return ResponseEntity.ok(ApiResponse.error("会话ID不能为空"));
            }

            SessionInfo session = sessions.get(request.getId());
            if (session != null) {
                session.clearHistory();
                return ResponseEntity.ok(ApiResponse.success("会话历史已清空"));
            } else {
                return ResponseEntity.ok(ApiResponse.error("会话不存在"));
            }

        } catch (Exception e) {
            logger.error("清空会话历史失败", e);
            return ResponseEntity.ok(ApiResponse.error(e.getMessage()));
        }
    }

    /**
     * Runs a streaming agent chat request with session memory.
     */
    @PostMapping(value = "/chat_stream", produces = "text/event-stream;charset=UTF-8")
    public SseEmitter chatStream(@RequestBody ChatRequest request) {
        SseEmitter emitter = new SseEmitter(300000L);

        if (request.getQuestion() == null || request.getQuestion().trim().isEmpty()) {
            logger.warn("问题内容为空");
            try {
                emitter.send(SseEmitter.event().name("message").data(SseMessage.error("问题内容不能为空").toJson()));
                emitter.complete();
            } catch (IOException e) {
                emitter.completeWithError(e);
            }
            return emitter;
        }

        executor.execute(() -> {
            try {
                logger.info("收到 ReactAgent 对话请求 - SessionId: {}, Question: {}", request.getId(), request.getQuestion());

                SessionInfo session = getOrCreateSession(request.getId());
                
                List<Map<String, String>> history = session.getHistory();
                logger.info("ReactAgent 会话历史消息对数: {}", history.size() / 2);

                DashScopeApi dashScopeApi = chatService.createDashScopeApi();
                DashScopeChatModel chatModel = chatService.createStandardChatModel(dashScopeApi);

                chatService.logAvailableTools();

                logger.info("开始 ReactAgent 流式对话（支持自动工具调用）");
                
                String systemPrompt = chatService.buildSystemPrompt(history);
                sendAgentStep(emitter, "reason", "构建上下文", "已读取当前会话历史并生成系统提示词。", "chat_stream", null, "finished");
                
                ReactAgent agent = chatService.createReactAgent(chatModel, systemPrompt);
                sendAgentStep(emitter, "action", "注册工具", "已注册时间、监控、知识库等本地工具。", "chat_stream", "LocalToolProvider", "finished");
                
                StringBuilder fullAnswerBuilder = new StringBuilder();
                AtomicBoolean modelStepSent = new AtomicBoolean(false);
                
                Flux<NodeOutput> stream = agent.stream(request.getQuestion());
                
                stream.subscribe(
                    output -> {
                        try {
                            if (output instanceof StreamingOutput streamingOutput) {
                                OutputType type = streamingOutput.getOutputType();
                                
                                if (type == OutputType.AGENT_MODEL_STREAMING) {
                                    if (modelStepSent.compareAndSet(false, true)) {
                                        sendAgentStep(emitter, "reason", "模型推理", "模型开始基于上下文和工具结果生成回复。", output.node(), null, "running");
                                    }
                                    String chunk = streamingOutput.message().getText();
                                    if (chunk != null && !chunk.isEmpty()) {
                                        fullAnswerBuilder.append(chunk);
                                        
                                        emitter.send(SseEmitter.event()
                                                .name("message")
                                                .data(SseMessage.content(chunk).toJson()));
                                        
                                        logger.info("发送流式内容: {}", chunk);
                                    }
                                } else if (type == OutputType.AGENT_MODEL_FINISHED) {
                                    logger.info("模型输出完成");
                                    sendAgentStep(emitter, "final", "模型输出完成", "模型已完成当前轮回复生成。", output.node(), null, "finished");
                                } else if (type == OutputType.AGENT_TOOL_FINISHED) {
                                    logger.info("工具调用完成: {}", output.node());
                                    sendAgentStep(emitter, "observation", "工具调用完成", "后端 Agent 工具节点已返回结果。", output.node(), extractToolName(output.node()), "finished");
                                } else if (type == OutputType.AGENT_HOOK_FINISHED) {
                                    logger.debug("Hook 执行完成: {}", output.node());
                                    sendAgentStep(emitter, "action", "Agent Hook 完成", "后端 Agent Hook 已执行完毕。", output.node(), null, "finished");
                                }
                            }
                        } catch (IOException e) {
                            logger.error("发送流式消息失败", e);
                            throw new RuntimeException(e);
                        }
                    },
                    error -> {
                        String errorMessage = extractClientErrorMessage(error);
                        logger.error("ReactAgent 流式对话失败: {}", errorMessage, error);
                            try {
                                emitter.send(SseEmitter.event()
                                        .name("message")
                                        .data(SseMessage.error(errorMessage).toJson()));
                            } catch (IOException ex) {
                            logger.error("发送错误消息失败", ex);
                        }
                        emitter.complete();
                    },
                    () -> {
                        try {
                            String fullAnswer = fullAnswerBuilder.toString();
                            logger.info("ReactAgent 流式对话完成 - SessionId: {}, 答案长度: {}", 
                                request.getId(), fullAnswer.length());
                            
                            session.addMessage(request.getQuestion(), fullAnswer);
                            logger.info("已更新会话历史 - SessionId: {}, 当前消息对数: {}", 
                                request.getId(), session.getMessagePairCount());
                            sendAgentStep(emitter, "final", "会话写入完成", "已将本轮问答写入后端会话窗口。", "chat_stream", null, "finished");
                            
                            emitter.send(SseEmitter.event()
                                    .name("message")
                                    .data(SseMessage.done().toJson()));
                            emitter.complete();
                        } catch (IOException e) {
                            logger.error("发送完成消息失败", e);
                            emitter.completeWithError(e);
                        }
                    }
                );

            } catch (Exception e) {
                logger.error("ReactAgent 对话初始化失败", e);
                try {
                    emitter.send(SseEmitter.event()
                            .name("message")
                            .data(SseMessage.error(e.getMessage()).toJson()));
                } catch (IOException ex) {
                    logger.error("发送错误消息失败", ex);
                }
                emitter.complete();
            }
        });

        return emitter;
    }

    /**
     * Starts the incident diagnosis workflow and streams the final report.
     */
    @PostMapping(value = "/ai_ops", produces = "text/event-stream;charset=UTF-8")
    public SseEmitter aiOps(@RequestBody(required = false) AiOpsRequest request) {
        SseEmitter emitter = new SseEmitter(600000L);

        executor.execute(() -> {
            try {
                logger.info("收到 AI 智能运维请求 - 启动多 Agent 协作流程");
                String automationMode = normalizeAutomationMode(request == null ? null : request.getAutomationMode());

                DashScopeApi dashScopeApi = chatService.createDashScopeApi();
                DashScopeChatModel chatModel = DashScopeChatModel.builder()
                        .dashScopeApi(dashScopeApi)
                        .defaultOptions(DashScopeChatOptions.builder()
                                .withModel(DashScopeChatModel.DEFAULT_MODEL_NAME)
                                .withTemperature(0.3)
                                .withMaxToken(8000)
                                .withTopP(0.9)
                                .build())
                        .build();

                ToolCallback[] toolCallbacks = tools.getToolCallbacks();

                AutomationGateService.PendingAction action = automationGateService.createAction(
                        automationMode,
                        "ai_ops_tool_chain",
                        "medium",
                        "允许智能体调用 Prometheus、腾讯云 CLS MCP、知识库检索等工具生成诊断报告。"
                );

                if ("auto".equals(automationMode)) {
                    action = automationGateService.approveAutomatically(action);
                    emitter.send(SseEmitter.event().name("message").data(SseMessage.actionStatus(action).toJson()));
                    sendAgentStep(emitter, "action", "自动审批通过", "自动模式已放行后端工具链。", "automation_gate", action.getToolName(), "approved");
                } else {
                    emitter.send(SseEmitter.event().name("message").data(SseMessage.actionRequired(action).toJson()));
                    sendAgentStep(emitter, "action", "等待工具审批", "后端已暂停诊断流程，等待前端确认卡批准或拒绝。", "automation_gate", action.getToolName(), "waiting");
                    action = automationGateService.waitForDecision(action, Duration.ofMinutes(5));
                    emitter.send(SseEmitter.event().name("message").data(SseMessage.actionStatus(action).toJson()));

                    if (!action.isApproved()) {
                        sendAgentStep(emitter, "final", "诊断已取消", "用户拒绝或审批超时，后端未执行工具链。", "automation_gate", action.getToolName(), "rejected");
                        emitter.send(SseEmitter.event().name("message")
                                .data(SseMessage.content("诊断已取消：工具执行未获得批准。\n").toJson()));
                        emitter.send(SseEmitter.event().name("message").data(SseMessage.done().toJson()));
                        emitter.complete();
                        return;
                    }
                    sendAgentStep(emitter, "action", "审批通过", "后端收到批准，开始执行多 Agent 工具链。", "automation_gate", action.getToolName(), "approved");
                }

                emitter.send(SseEmitter.event().name("message").data(SseMessage.content("正在读取告警并拆解任务...\n").toJson()));
                sendAgentStep(emitter, "reason", "读取告警", "正在启动 Planner / Executor 多 Agent 编排。", "ai_ops", "queryPrometheusAlerts", "running");
                
                CompletableFuture<Optional<OverAllState>> analysisFuture = CompletableFuture.supplyAsync(() -> {
                    try {
                        return aiOpsService.executeAiOpsAnalysis(chatModel, toolCallbacks);
                    } catch (Exception e) {
                        throw new CompletionException(e);
                    }
                }, executor);

                Optional<OverAllState> overAllStateOptional;
                try {
                    overAllStateOptional = analysisFuture.get(aiOpsAnalysisTimeoutSeconds, TimeUnit.SECONDS);
                } catch (TimeoutException e) {
                    analysisFuture.cancel(true);
                    logger.warn("AI Ops 编排超过 {} 秒仍未返回，生成超时报告", aiOpsAnalysisTimeoutSeconds);
                    sendAgentStep(emitter, "observation", "模型调用超时", "DashScope 或工具链未在限定时间内返回，后端已停止等待并生成真实失败报告。", "ai_ops", null, "timeout");
                    emitDiagnosisReport(
                            emitter,
                            buildAiOpsFailureReport("AI Ops 自动诊断超时", "DashScope 或工具链超过 " + aiOpsAnalysisTimeoutSeconds + " 秒仍未返回完整结果。"),
                            "超时报告已生成",
                            "后端已生成结构化超时报告，前端图表不再依赖文本默认值。",
                            "timeout"
                    );
                    emitter.send(SseEmitter.event().name("message").data(SseMessage.done().toJson()));
                    emitter.complete();
                    return;
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause() == null ? e : e.getCause();
                    String failureReason = extractClientErrorMessage(cause);
                    logger.warn("AI Ops 编排失败，生成失败报告: {}", failureReason, cause);
                    sendAgentStep(emitter, "observation", "工具链执行失败", "模型或工具链返回异常，后端已生成真实失败报告。", "ai_ops", null, "failed");
                    emitDiagnosisReport(
                            emitter,
                            buildAiOpsFailureReport("AI Ops 自动诊断失败", failureReason),
                            "失败报告已生成",
                            "后端已生成结构化失败报告，便于前端展示和交接。",
                            "failed"
                    );
                    emitter.send(SseEmitter.event().name("message").data(SseMessage.done().toJson()));
                    emitter.complete();
                    return;
                }

                if (overAllStateOptional.isEmpty()) {
                    emitDiagnosisReport(
                            emitter,
                            buildAiOpsFailureReport("AI Ops 自动诊断无有效结果", "多 Agent 编排完成，但未返回可提取的状态数据。"),
                            "空结果报告已生成",
                            "后端已生成结构化空结果报告，提示需要补充真实观测数据。",
                            "empty"
                    );
                    emitter.send(SseEmitter.event().name("message").data(SseMessage.done().toJson()));
                    emitter.complete();
                    return;
                }

                OverAllState state = overAllStateOptional.get();
                logger.info("AI Ops 编排完成，开始提取最终报告...");
                sendAgentStep(emitter, "observation", "多 Agent 编排完成", "Planner / Executor 已返回最终状态，开始提取报告。", "ai_ops", null, "finished");

                Optional<String> finalReportOptional = aiOpsService.extractFinalReport(state);

                if (finalReportOptional.isPresent()) {
                    String finalReportText = finalReportOptional.get();
                    logger.info("提取到 Planner 最终报告，长度: {}", finalReportText.length());
                    emitDiagnosisReport(
                            emitter,
                            finalReportText,
                            "结构化报告已生成",
                            "后端已输出报告结构化数据，前端图表将基于该数据渲染。",
                            "finished"
                    );
                } else {
                    logger.warn("未能提取到 Planner 最终报告");
                    emitDiagnosisReport(
                            emitter,
                            buildAiOpsFailureReport("AI Ops 未生成最终报告", "多 Agent 流程已完成，但 Planner 未输出最终 Markdown 报告。"),
                            "缺失报告已生成",
                            "后端已生成结构化缺失报告，提示需要检查 Planner 输出。",
                            "missing"
                    );
                }

                emitter.send(SseEmitter.event().name("message").data(SseMessage.done().toJson()));
                emitter.complete();
                logger.info("AI Ops 多 Agent 编排完成");

            } catch (Exception e) {
                logger.error("AI Ops 多 Agent 协作失败", e);
                try {
                    emitter.send(SseEmitter.event().name("message")
                            .data(SseMessage.error("AI Ops 流程失败: " + e.getMessage()).toJson()));
                } catch (IOException ex) {
                    logger.error("发送错误消息失败", ex);
                }
                emitter.complete();
            }
        });

        return emitter;
    }


    @PostMapping("/actions/{actionId}/decision")
    public ResponseEntity<ApiResponse<AutomationGateService.PendingAction>> decideAction(
            @PathVariable("actionId") String actionId,
            @RequestBody(required = false) ActionDecisionRequest request) {
        boolean approved = request != null && request.isApproved();
        String operator = request == null || request.getOperator() == null ? "frontend" : request.getOperator();

        return automationGateService.decide(actionId, approved, operator)
                .map(action -> ResponseEntity.ok(ApiResponse.success(action)))
                .orElseGet(() -> ResponseEntity.ok(ApiResponse.error("待审批动作不存在或已结束")));
    }


    /**
     * Returns basic metadata for a chat session.
     */
    @GetMapping("/chat/session/{sessionId}")
    public ResponseEntity<ApiResponse<SessionInfoResponse>> getSessionInfo(@PathVariable("sessionId") String sessionId) {
        try {
            logger.info("收到获取会话信息请求 - SessionId: {}", sessionId);

            SessionInfo session = sessions.get(sessionId);
            if (session != null) {
                SessionInfoResponse response = new SessionInfoResponse();
                response.setSessionId(sessionId);
                response.setMessagePairCount(session.getMessagePairCount());
                response.setCreateTime(session.createTime);
                return ResponseEntity.ok(ApiResponse.success(response));
            } else {
                return ResponseEntity.ok(ApiResponse.error("会话不存在"));
            }

        } catch (Exception e) {
            logger.error("获取会话信息失败", e);
            return ResponseEntity.ok(ApiResponse.error(e.getMessage()));
        }
    }

    /**
     * Deletes one chat session from the in-memory backend window.
     */
    @DeleteMapping("/chat/session/{sessionId}")
    public ResponseEntity<ApiResponse<String>> deleteSession(@PathVariable("sessionId") String sessionId) {
        try {
            logger.info("收到删除会话请求 - SessionId: {}", sessionId);
            SessionInfo removed = sessions.remove(sessionId);
            if (removed == null) {
                return ResponseEntity.ok(ApiResponse.success("会话不存在或已删除"));
            }
            return ResponseEntity.ok(ApiResponse.success("会话已删除"));
        } catch (Exception e) {
            logger.error("删除会话失败", e);
            return ResponseEntity.ok(ApiResponse.error(e.getMessage()));
        }
    }

    private SessionInfo getOrCreateSession(String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) {
            sessionId = UUID.randomUUID().toString();
        }
        return sessions.computeIfAbsent(sessionId, SessionInfo::new);
    }

    private void sendAgentStep(SseEmitter emitter, String phase, String label, String detail,
                               Object node, String toolName, String status) throws IOException {
        AgentStep step = new AgentStep();
        step.setPhase(phase);
        step.setLabel(label);
        step.setDetail(detail);
        step.setNode(node == null ? "" : String.valueOf(node));
        step.setToolName(toolName == null ? "" : toolName);
        step.setStatus(status);
        step.setTimestamp(System.currentTimeMillis());
        emitter.send(SseEmitter.event().name("message").data(SseMessage.agentStep(step).toJson()));
    }

    private String extractToolName(Object node) {
        String value = node == null ? "" : String.valueOf(node);
        if (value.contains("queryPrometheusAlerts")) return "queryPrometheusAlerts";
        if (value.contains("queryInternalDocs")) return "queryInternalDocs";
        if (value.toLowerCase().contains("mcp") || value.toLowerCase().contains("cls")) return "tencent-cls-mcp";
        if (value.contains("getCurrentDateTime")) return "getCurrentDateTime";
        return value.length() > 48 ? value.substring(0, 48) : value;
    }

    private String normalizeAutomationMode(String mode) {
        if ("manual".equalsIgnoreCase(mode) || "auto".equalsIgnoreCase(mode)) {
            return mode.toLowerCase();
        }
        return "confirm";
    }

    private String extractClientErrorMessage(Throwable error) {
        if (error instanceof WebClientResponseException webClientError) {
            String body = webClientError.getResponseBodyAsString();
            if (body != null && !body.isBlank()) {
                return webClientError.getStatusCode() + " " + body;
            }
        }
        if (error instanceof HttpStatusCodeException httpError) {
            String body = httpError.getResponseBodyAsString();
            if (body != null && !body.isBlank()) {
                return httpError.getStatusCode() + " " + body;
            }
        }
        return error == null || error.getMessage() == null ? "未知错误" : error.getMessage();
    }

    private void emitDiagnosisReport(
            SseEmitter emitter,
            String finalReportText,
            String finalStepLabel,
            String finalStepDetail,
            String status
    ) throws IOException {
        emitter.send(SseEmitter.event().name("message")
                .data(SseMessage.content("\n\n" + "=".repeat(60) + "\n").toJson()));

        emitter.send(SseEmitter.event().name("message")
                .data(SseMessage.content("**告警分析报告**\n\n").toJson()));

        int chunkSize = 50;
        for (int i = 0; i < finalReportText.length(); i += chunkSize) {
            int end = Math.min(i + chunkSize, finalReportText.length());
            String chunk = finalReportText.substring(i, end);
            emitter.send(SseEmitter.event().name("message")
                    .data(SseMessage.content(chunk).toJson()));
        }

        emitter.send(SseEmitter.event().name("message")
                .data(SseMessage.content("\n" + "=".repeat(60) + "\n\n").toJson()));

        ReportData reportData = buildReportData(finalReportText);
        emitter.send(SseEmitter.event().name("message")
                .data(SseMessage.reportData(reportData).toJson()));
        sendAgentStep(emitter, "final", finalStepLabel, finalStepDetail, "ai_ops", null, status);
    }

    private String buildAiOpsFailureReport(String title, String reason) {
        String safeReason = reason == null || reason.isBlank() ? "外部模型或工具链未返回明确错误信息。" : reason;
        return """
                # 告警分析报告

                ---

                ## 活跃告警清单

                当前未获得可验证的真实告警明细，后端不会补造告警数据。

                ---

                ## 告警根因分析 - 自动诊断未完成

                ### 告警详情
                - **诊断状态**: %s
                - **影响范围**: AI Ops 自动诊断链路
                - **失败原因**: %s

                ### 症状描述
                后端已完成审批放行，但多 Agent 编排没有在限定时间内返回完整诊断结果。

                ### 日志证据
                - 后端保留了真实失败原因：%s
                - 未拿到可验证的腾讯云 CLS / Prometheus / 知识库组合证据时，系统不会生成虚假的根因结论。

                ### 根因结论
                当前只能确认自动诊断链路未完成，不能确认业务系统根因。需要检查 DashScope 响应耗时、MCP Server 可达性、工具返回数据以及网络状态。

                ---

                ## 处理方案执行 - 自动诊断链路

                ### 已执行的排查步骤
                1. 后端已接收 AIOps 请求。
                2. 后端已完成自动化档位审批。
                3. 后端已启动 Planner / Executor 多 Agent 编排。
                4. 编排未在限定时间内返回完整报告，系统生成失败报告并结束流式响应。

                ### 处理建议
                检查 DashScope Key、模型网络连通性、腾讯云 MCP SSE 地址、MCP 工具查询参数和 Prometheus 数据源状态。

                ### 预期效果
                外部模型或工具链恢复后，再次运行自动诊断应返回完整 Markdown 报告与结构化 report_data。

                ---

                ## 结论

                ### 整体评估
                %s

                ### 关键发现
                - 自动化审批链路已执行。
                - 多 Agent 诊断未产出可验证业务根因。
                - 系统已避免使用默认假统计或编造报告数据。

                ### 后续建议
                1. 先用确认模式演示审批流。
                2. 再检查 DashScope 与 MCP Server 的实时响应。
                3. 自动诊断完成前，不要把该报告解释为业务根因结论。

                ### 风险评估
                当前风险集中在外部 AI / 工具链响应稳定性，不是前端渲染链路。
                """.formatted(title, safeReason, safeReason, title);
    }

    private ReportData buildReportData(String markdownText) {
        ReportData data = new ReportData();
        data.setAlerts(parseAlertRows(markdownText));
        data.setRootCause(extractFirstMatchingSection(markdownText, "根因"));
        data.setLogEvidence(extractLogEvidence(markdownText));
        data.setSteps(extractSteps(markdownText));
        data.setTypeDistribution(buildTypeDistribution(data.getAlerts()));
        data.setSeverityDistribution(buildSeverityDistribution(data.getAlerts()));
        data.setGeneratedAt(System.currentTimeMillis());
        return data;
    }

    private List<AlertRow> parseAlertRows(String markdownText) {
        List<AlertRow> alerts = new ArrayList<>();
        boolean inAlertSection = false;

        for (String rawLine : markdownText.split("\\R")) {
            String line = rawLine.trim();
            if (line.contains("活跃告警清单")) {
                inAlertSection = true;
                continue;
            }
            if (inAlertSection && line.startsWith("##") && !line.contains("活跃告警清单")) {
                break;
            }
            if (!inAlertSection || !line.startsWith("|") || line.contains("---") || line.contains("告警名称")) {
                continue;
            }

            String[] columns = line.substring(1, line.length() - 1).split("\\|");
            if (columns.length < 3) {
                continue;
            }

            AlertRow row = new AlertRow();
            row.setName(cleanCell(columns[0]));
            row.setSeverity(columns.length > 1 ? normalizeSeverity(cleanCell(columns[1])) : "info");
            row.setService(columns.length > 2 ? cleanCell(columns[2]) : "");
            row.setFirstSeen(columns.length > 3 ? cleanCell(columns[3]) : "");
            row.setLastSeen(columns.length > 4 ? cleanCell(columns[4]) : "");
            row.setStatus(columns.length > 5 ? cleanCell(columns[5]) : "");

            if (!row.getName().isBlank() && !row.getName().startsWith("[")) {
                alerts.add(row);
            }
        }

        return alerts;
    }

    private String cleanCell(String value) {
        return value == null ? "" : value.replace("**", "").trim();
    }

    private String normalizeSeverity(String value) {
        String text = value == null ? "" : value.toLowerCase(Locale.ROOT);
        if (text.contains("critical") || text.contains("严重")) return "critical";
        if (text.contains("warning") || text.contains("警告")) return "warning";
        return "info";
    }

    private String extractFirstMatchingSection(String markdownText, String keyword) {
        String[] lines = markdownText.split("\\R");
        StringBuilder section = new StringBuilder();
        boolean collecting = false;

        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.startsWith("##") && trimmed.contains(keyword)) {
                collecting = true;
                continue;
            }
            if (collecting && trimmed.startsWith("##")) {
                break;
            }
            if (collecting) {
                section.append(line).append('\n');
            }
        }

        return section.toString().trim();
    }

    private List<String> extractLogEvidence(String markdownText) {
        List<String> evidence = new ArrayList<>();
        String section = extractFirstMatchingSection(markdownText, "日志证据");
        if (section.isBlank()) {
            section = extractFirstMatchingSection(markdownText, "日志");
        }

        boolean inCode = false;
        for (String line : section.split("\\R")) {
            String trimmed = line.trim();
            if (trimmed.startsWith("```")) {
                inCode = !inCode;
                continue;
            }
            if ((inCode || trimmed.startsWith("-") || trimmed.matches("^\\d+\\.\\s+.*")) && !trimmed.isBlank()) {
                evidence.add(trimmed.replaceFirst("^[-*]\\s*", "").replaceFirst("^\\d+\\.\\s*", ""));
            }
            if (evidence.size() >= 20) {
                break;
            }
        }

        return evidence;
    }

    private List<String> extractSteps(String markdownText) {
        List<String> steps = new ArrayList<>();
        boolean inStepSection = false;

        for (String line : markdownText.split("\\R")) {
            String trimmed = line.trim();
            if (trimmed.contains("处理方案") || trimmed.contains("处理建议") || trimmed.contains("排查步骤")) {
                inStepSection = true;
                continue;
            }
            if (inStepSection && trimmed.startsWith("##") && steps.size() > 0) {
                break;
            }
            if (inStepSection && (trimmed.matches("^\\d+\\.\\s+.*") || trimmed.startsWith("- "))) {
                steps.add(trimmed.replaceFirst("^\\d+\\.\\s*", "").replaceFirst("^-\\s*", ""));
            }
            if (steps.size() >= 20) {
                break;
            }
        }

        return steps;
    }

    private Map<String, Integer> buildSeverityDistribution(List<AlertRow> alerts) {
        Map<String, Integer> stats = new LinkedHashMap<>();
        for (AlertRow alert : alerts) {
            String key = normalizeSeverity(alert.getSeverity());
            stats.put(key, stats.getOrDefault(key, 0) + 1);
        }
        return stats;
    }

    private Map<String, Integer> buildTypeDistribution(List<AlertRow> alerts) {
        Map<String, Integer> stats = new LinkedHashMap<>();
        for (AlertRow alert : alerts) {
            String type = classifyAlertType(alert.getName() + " " + alert.getService());
            stats.put(type, stats.getOrDefault(type, 0) + 1);
        }
        return stats;
    }

    private String classifyAlertType(String text) {
        String value = text == null ? "" : text.toLowerCase(Locale.ROOT);
        if (value.contains("cpu")) return "CPU";
        if (value.contains("memory") || value.contains("内存") || value.contains("oom")) return "Memory";
        if (value.contains("network") || value.contains("网络")) return "Network";
        if (value.contains("database") || value.contains("db") || value.contains("数据库")) return "Database";
        if (value.contains("certificate") || value.contains("证书")) return "Certificate";
        if (value.contains("queue") || value.contains("消息")) return "Queue";
        if (value.contains("pod") || value.contains("crashloop")) return "Pod";
        if (value.contains("service") || value.contains("unavailable")) return "Service";
        return "Other";
    }

    /**
     * Thread-safe message window for a single chat session.
     */
    private static class SessionInfo {
        private final String sessionId;
        private final List<Map<String, String>> messageHistory;
        private final long createTime;
        private final ReentrantLock lock;

        public SessionInfo(String sessionId) {
            this.sessionId = sessionId;
            this.messageHistory = new ArrayList<>();
            this.createTime = System.currentTimeMillis();
            this.lock = new ReentrantLock();
        }

        /**
         * Appends one user/assistant exchange and trims old messages.
         */
        public void addMessage(String userQuestion, String aiAnswer) {
            lock.lock();
            try {
                Map<String, String> userMsg = new HashMap<>();
                userMsg.put("role", "user");
                userMsg.put("content", userQuestion);
                messageHistory.add(userMsg);

                Map<String, String> assistantMsg = new HashMap<>();
                assistantMsg.put("role", "assistant");
                assistantMsg.put("content", aiAnswer);
                messageHistory.add(assistantMsg);

                int maxMessages = MAX_WINDOW_SIZE * 2;
                while (messageHistory.size() > maxMessages) {
                    messageHistory.remove(0);
                    if (!messageHistory.isEmpty()) {
                        messageHistory.remove(0);
                    }
                }

                logger.debug("会话 {} 更新历史消息，当前消息对数: {}", 
                    sessionId, messageHistory.size() / 2);

            } finally {
                lock.unlock();
            }
        }

        /**
         * Returns a snapshot to avoid concurrent modification by callers.
         */
        public List<Map<String, String>> getHistory() {
            lock.lock();
            try {
                return new ArrayList<>(messageHistory);
            } finally {
                lock.unlock();
            }
        }

        /**
         * Clears all retained messages.
         */
        public void clearHistory() {
            lock.lock();
            try {
                messageHistory.clear();
                logger.info("会话 {} 历史消息已清空", sessionId);
            } finally {
                lock.unlock();
            }
        }

        /**
         * Returns the number of retained message pairs.
         */
        public int getMessagePairCount() {
            lock.lock();
            try {
                return messageHistory.size() / 2;
            } finally {
                lock.unlock();
            }
        }
    }

    /**
     * Chat request payload.
     */
    @Setter
    @Getter
    public static class ChatRequest {
        @com.fasterxml.jackson.annotation.JsonProperty(value = "Id")
        @com.fasterxml.jackson.annotation.JsonAlias({"id", "ID"})
        private String Id;
        
        @com.fasterxml.jackson.annotation.JsonProperty(value = "Question")
        @com.fasterxml.jackson.annotation.JsonAlias({"question", "QUESTION"})
        private String Question;

    }

    /**
     * Session clear request payload.
     */
    @Setter
    @Getter
    public static class ClearRequest {
        @com.fasterxml.jackson.annotation.JsonProperty(value = "Id")
        @com.fasterxml.jackson.annotation.JsonAlias({"id", "ID"})
        private String Id;
    }

    @Setter
    @Getter
    public static class AiOpsRequest {
        private String automationMode;
        private String sessionId;
    }

    @Setter
    @Getter
    public static class ActionDecisionRequest {
        private boolean approved;
        private String operator;
    }

    /**
     * Session metadata response.
     */
    @Setter
    @Getter
    public static class SessionInfoResponse {
        private String sessionId;
        private int messagePairCount;
        private long createTime;
    }

    /**
     * Standard response for non-streaming chat endpoints.
     */
    @Setter
    @Getter
    public static class ChatResponse {
        private boolean success;
        private String answer;
        private String errorMessage;

        public static ChatResponse success(String answer) {
            ChatResponse response = new ChatResponse();
            response.setSuccess(true);
            response.setAnswer(answer);
            return response;
        }

        public static ChatResponse error(String errorMessage) {
            ChatResponse response = new ChatResponse();
            response.setSuccess(false);
            response.setErrorMessage(errorMessage);
            return response;
        }
    }

    @Setter
    @Getter
    public static class AgentStep {
        private String phase;
        private String label;
        private String detail;
        private String node;
        private String toolName;
        private String status;
        private long timestamp;
    }

    @Setter
    @Getter
    public static class AlertRow {
        private String name;
        private String severity;
        private String service;
        private String firstSeen;
        private String lastSeen;
        private String status;
    }

    @Setter
    @Getter
    public static class ReportData {
        private List<AlertRow> alerts = new ArrayList<>();
        private String rootCause = "";
        private List<String> logEvidence = new ArrayList<>();
        private List<String> steps = new ArrayList<>();
        private Map<String, Integer> typeDistribution = new LinkedHashMap<>();
        private Map<String, Integer> severityDistribution = new LinkedHashMap<>();
        private long generatedAt;
    }

    /**
     * Message envelope used by SSE endpoints.
     */
    @Setter
    @Getter
    public static class SseMessage {
        private String type;
        private Object data;

        public static SseMessage content(String data) {
            SseMessage message = new SseMessage();
            message.setType("content");
            message.setData(data);
            return message;
        }

        public static SseMessage error(String errorMessage) {
            SseMessage message = new SseMessage();
            message.setType("error");
            message.setData(errorMessage);
            return message;
        }

        public static SseMessage done() {
            SseMessage message = new SseMessage();
            message.setType("done");
            message.setData(null);
            return message;
        }

        public static SseMessage agentStep(AgentStep step) {
            SseMessage message = new SseMessage();
            message.setType("agent_step");
            message.setData(step);
            return message;
        }

        public static SseMessage actionRequired(AutomationGateService.PendingAction action) {
            SseMessage message = new SseMessage();
            message.setType("action_required");
            message.setData(action);
            return message;
        }

        public static SseMessage actionStatus(AutomationGateService.PendingAction action) {
            SseMessage message = new SseMessage();
            message.setType("action_status");
            message.setData(action);
            return message;
        }

        public static SseMessage reportData(ReportData reportData) {
            SseMessage message = new SseMessage();
            message.setType("report_data");
            message.setData(reportData);
            return message;
        }

        public String toJson() {
            try {
                return SSE_OBJECT_MAPPER.writeValueAsString(this);
            } catch (JsonProcessingException e) {
                throw new IllegalStateException("Failed to serialize SSE message", e);
            }
        }
    }


    @Getter
    @Setter
    public static class ApiResponse<T> {
        private int code;
        private String message;
        private T data;

        public static <T> ApiResponse<T> success(T data) {
            ApiResponse<T> response = new ApiResponse<>();
            response.setCode(200);
            response.setMessage("success");
            response.setData(data);
            return response;
        }

        public static <T> ApiResponse<T> error(String message) {
            ApiResponse<T> response = new ApiResponse<>();
            response.setCode(500);
            response.setMessage(message);
            return response;
        }

    }
}
