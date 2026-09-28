export type ToolCard = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  approval: 'none' | 'pending' | 'approved' | 'declined';
};

export type AssistantTurn = {
  text: string;
  reasoning: string;
  tools: ToolCard[];
  error?: string;
  runId?: string;
};

type Chunk = { type: string; runId?: string; payload?: Record<string, unknown> };

export function emptyTurn(): AssistantTurn {
  return { text: '', reasoning: '', tools: [] };
}

function upsertTool(tools: ToolCard[], toolCallId: string, toolName: string, patch: Partial<ToolCard>): ToolCard[] {
  const index = tools.findIndex((tool) => tool.toolCallId === toolCallId);
  if (index === -1) {
    return [...tools, { toolCallId, toolName, approval: 'none', ...patch }];
  }
  const next = [...tools];
  next[index] = { ...next[index], ...patch, toolName: toolName || next[index].toolName };
  return next;
}

export function reduceChunk(turn: AssistantTurn, chunk: Chunk): AssistantTurn {
  const payload = chunk.payload ?? {};
  const next: AssistantTurn = { ...turn, runId: chunk.runId ?? turn.runId, tools: turn.tools };
  if (chunk.type === 'text-delta' && typeof payload.text === 'string') next.text += payload.text;
  if (chunk.type === 'reasoning-delta' && typeof payload.text === 'string') next.reasoning += payload.text;
  if (chunk.type === 'tool-call' || chunk.type === 'tool-call-approval') {
    const toolCallId = String(payload.toolCallId ?? '');
    const toolName = String(payload.toolName ?? '');
    next.tools = upsertTool(next.tools, toolCallId, toolName, {
      args: payload.args,
      approval: chunk.type === 'tool-call-approval' ? 'pending' : next.tools.find((tool) => tool.toolCallId === toolCallId)?.approval ?? 'none',
    });
  }
  if (chunk.type === 'tool-result') {
    const toolCallId = String(payload.toolCallId ?? '');
    const current = next.tools.find((tool) => tool.toolCallId === toolCallId);
    next.tools = upsertTool(next.tools, toolCallId, String(payload.toolName ?? ''), {
      result: payload.result,
      error: typeof payload.error === 'string' ? payload.error : undefined,
      approval: current?.approval === 'pending' ? 'approved' : current?.approval ?? 'none',
    });
  }
  if (chunk.type === 'error') {
    next.error = typeof payload.message === 'string' ? payload.message : '回复中断';
  }
  return next;
}

export function markApproval(turn: AssistantTurn, toolCallId: string, approval: 'approved' | 'declined'): AssistantTurn {
  return {
    ...turn,
    tools: turn.tools.map((tool) => (tool.toolCallId === toolCallId ? { ...tool, approval } : tool)),
  };
}
