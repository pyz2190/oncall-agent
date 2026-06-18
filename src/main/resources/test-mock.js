// test-mock.js
// 模拟后端 SSE 响应，劫持 fetch 请求 /api/ai_ops
// 同时提供手动触发 Action 的辅助函数（挂载到 window）

(function() {
    // 标准模拟报告（符合约定格式）
    const STANDARD_REPORT = `# Alert Summary
- **告警名称**：ServiceUnavailable
- **触发时间**：2025-06-12 10:23:45
- **严重度**：critical

## 根因分析
数据库连接池耗尽，活跃连接数达到上限（100/100），且存在连接泄漏。应用日志显示大量 "Timeout waiting for connection" 错误。

## 日志证据
\`\`\`log
2025-06-12 10:22:30 ERROR [HikariPool] - Connection is not available, request timed out after 30000ms.
2025-06-12 10:22:35 WARN  - Retry attempt 2 failed
2025-06-12 10:22:40 ERROR - ServiceUnavailableException thrown from /api/order
\`\`\`

## 处理步骤
1. 临时扩容数据库连接池最大连接数至 200。
2. 使用 \`SHOW PROCESSLIST\` 排查长时间未提交的事务。
3. 重启应用服务以释放泄漏连接。
4. 长期：修复代码中的连接未关闭问题。`;

    const EMPTY_REPORT = `# Alert Summary
- **告警名称**：无异常
- **触发时间**：-
- **严重度**：info

## 根因分析
未检测到明显故障。

## 日志证据
\`\`\`log
No anomalies found.
\`\`\`

## 处理步骤
1. 系统运行正常，无需处理。`;

    // 模拟 SSE 流式发送
    async function* generateSSEChunks(markdown, chunkSize = 5, delayMs = 20) {
        const chars = markdown.split('');
        for (let i = 0; i < chars.length; i += chunkSize) {
            const chunk = chars.slice(i, i + chunkSize).join('');
            yield `data: ${JSON.stringify({ type: "content", data: chunk })}\n\n`;
            await new Promise(r => setTimeout(r, delayMs));
        }
        yield `data: ${JSON.stringify({ type: "done", data: null })}\n\n`;
    }

    // 创建模拟 Response 对象
    function createMockResponse(markdown) {
        const encoder = new TextEncoder();
        let iterator = generateSSEChunks(markdown);
        const stream = new ReadableStream({
            async start(controller) {
                for await (const chunk of iterator) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            }
        });
        return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
        });
    }

    // 保存原始 fetch
    const originalFetch = window.fetch;

    // 劫持 fetch
    window.fetch = function(url, options) {
        // 仅拦截 /api/ai_ops
        if (typeof url === 'string' && url.includes('/api/ai_ops')) {
            console.log('[Mock] 拦截 /api/ai_ops 请求，返回模拟报告');
            // 可以选择返回标准报告或空报告（通过全局标志切换）
            const useEmpty = window.__mockUseEmptyReport || false;
            const markdown = useEmpty ? EMPTY_REPORT : STANDARD_REPORT;
            return Promise.resolve(createMockResponse(markdown));
        }
        // 其他请求（如 /api/chat/clear, /api/upload）交给原始 fetch
        return originalFetch.apply(this, arguments);
    };

    // 辅助函数：模拟添加一个待确认 Action（用于测试确认卡）
    window.simulateAgentAction = function() {
        if (window.store && window.store.addAction) {
            const action = {
                id: Date.now() + '_' + Math.random(),
                toolName: 'queryPrometheusAlerts',
                riskLevel: 'Low',
                description: 'Agent 想要查询当前活跃告警列表（测试模拟）'
            };
            window.store.addAction(action);
            console.log('[Test] 已模拟添加 Action', action);
        } else {
            console.warn('[Test] store 未就绪，请确保主应用已加载');
        }
    };

    // 辅助函数：切换是否返回空报告
    window.setMockEmptyReport = function(empty) {
        window.__mockUseEmptyReport = empty;
        console.log(`[Test] 模拟报告将返回 ${empty ? '空报告' : '标准报告'}`);
    };

    console.log('[TestMock] 已劫持 fetch，/api/ai_ops 将返回模拟 SSE 流');
})();