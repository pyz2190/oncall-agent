export async function parseSSEStream(response, {
  onContent,
  onDone,
  onError,
  onAgentStep,
  onActionRequired,
  onActionStatus,
  onReportData
} = {}) {
  if (!response.body) {
    onError?.('接口没有返回可读取的流');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      onDone?.();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('id:') || trimmed.startsWith('event:')) continue;
      if (!trimmed.startsWith('data:')) continue;

      const raw = trimmed.slice(5).trim();
      if (raw === '[DONE]') {
        onDone?.();
        return;
      }

      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'content') {
          onContent?.(msg.data || '');
        } else if (msg.type === 'done') {
          onDone?.();
          return;
        } else if (msg.type === 'error') {
          onError?.(msg.data || '未知错误');
          return;
        } else if (msg.type === 'agent_step') {
          onAgentStep?.(msg.data || {});
        } else if (msg.type === 'action_required') {
          onActionRequired?.(msg.data || {});
        } else if (msg.type === 'action_status') {
          onActionStatus?.(msg.data || {});
        } else if (msg.type === 'report_data') {
          onReportData?.(msg.data || {});
        }
      } catch {
        onContent?.(raw);
      }
    }
  }
}
