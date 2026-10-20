/**
 * Task 0 / Task 5 reusable probe: provider-HTTP-mock boundary for Mastra
 * execution state, runId, and suspend/resume identity.
 *
 * Does NOT enable production skills or register business skill tools.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { MockStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

type ProbeObservation = {
  stepNumber: number;
  nonce: string;
  stateRef: Record<string, unknown>;
};

type ToolContextObservation = {
  agentId?: string;
  toolCallId?: string;
  threadId?: string;
  resourceId?: string;
  agentKeys: string[];
  hasAgentSuspend: boolean;
  workflowRunId?: string;
  resumeData?: unknown;
};

export type ExecutionProbeResult = {
  sharedAcrossThreeModelSteps: boolean;
  sharedAcrossSecondUserTurn: boolean;
  firstRunId: string;
  secondRunId: string;
  resumePreservesRunId: boolean;
  suspendedRunId: string;
  toolAgentContextFields: string[];
};

function createMockChatModel(handler: (callIndex: number) => Response) {
  let callIndex = 0;
  return createOpenAICompatible({
    name: 'skills-execution-probe',
    baseURL: 'https://example.test/v1',
    apiKey: 'test',
    fetch: async () => handler(++callIndex),
  }).chatModel('test');
}

function toolCallResponse(toolName: string, toolCallId: string, args: Record<string, unknown>) {
  return Response.json({
    id: 'test',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function textResponse(content: string) {
  return Response.json({
    id: 'test',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** Reusable probe for Task 5 regression — three steps share execution; next user turn does not. */
export async function runSkillsExecutionProbe(): Promise<ExecutionProbeResult> {
  const observations: ProbeObservation[] = [];
  const probeProcessor = {
    id: 'skills-execution-probe',
    processLLMRequest({ state, stepNumber }: {
      state: Record<string, unknown>;
      stepNumber: number;
    }) {
      if (typeof state.nonce !== 'string') {
        state.nonce = `nonce-${crypto.randomUUID()}`;
      }
      observations.push({
        stepNumber,
        nonce: state.nonce as string,
        stateRef: state,
      });
    },
  };

  const noop = createTool({
    id: 'noop',
    description: 'no-op step tool',
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  });

  let callIndex = 0;
  const multiStepModel = createMockChatModel(() => {
    callIndex += 1;
    // Two tool rounds + final text => three processLLMRequest invocations.
    if (callIndex <= 2) return toolCallResponse('noop', `noop-${callIndex}`, {});
    return textResponse('turn-complete');
  });

  const multiStepAgent = new Agent({
    id: 'skills-execution-probe-multi',
    name: 'skills-execution-probe-multi',
    model: multiStepModel,
    tools: { noop },
    inputProcessors: [probeProcessor],
    defaultOptions: { maxSteps: 5 },
  });

  const requestContext = new RequestContext();
  const first = await multiStepAgent.generate('first user turn', { requestContext });
  const firstSlice = observations.slice();
  assert.equal(firstSlice.length, 3, 'expected three model steps in first user turn');
  const sharedAcrossThreeModelSteps = firstSlice.every(
    (obs) => obs.nonce === firstSlice[0]!.nonce && obs.stateRef === firstSlice[0]!.stateRef,
  );

  callIndex = 0;
  const beforeSecond = observations.length;
  const second = await multiStepAgent.generate('second user turn', { requestContext });
  const secondSlice = observations.slice(beforeSecond);
  assert.equal(secondSlice.length, 3, 'expected three model steps in second user turn');
  const sharedAcrossSecondUserTurn = secondSlice.some(
    (obs) => firstSlice.some((prior) => prior.stateRef === obs.stateRef || prior.nonce === obs.nonce),
  );

  const toolContexts: ToolContextObservation[] = [];
  const gate = createTool({
    id: 'gate',
    description: 'suspends once for resume probe',
    inputSchema: z.object({ x: z.string() }),
    suspendSchema: z.object({ reason: z.string() }),
    resumeSchema: z.object({ answer: z.string() }),
    execute: async (input, ctx) => {
      toolContexts.push({
        agentId: ctx.agent?.agentId,
        toolCallId: ctx.agent?.toolCallId,
        threadId: ctx.agent?.threadId,
        resourceId: ctx.agent?.resourceId,
        agentKeys: ctx.agent ? Object.keys(ctx.agent) : [],
        hasAgentSuspend: typeof ctx.agent?.suspend === 'function',
        workflowRunId: ctx.workflow?.runId,
        resumeData: ctx.agent?.resumeData ?? ctx.resumeData,
      });
      if (!(ctx.agent?.resumeData ?? ctx.resumeData)) {
        await ctx.agent!.suspend({ reason: 'need-user' });
        return { ok: false };
      }
      return { ok: true, x: input.x, answer: (ctx.agent?.resumeData ?? ctx.resumeData) as { answer: string } };
    },
  });

  let resumePhase = 0;
  const suspendModel = createMockChatModel(() => {
    resumePhase += 1;
    if (resumePhase === 1) return toolCallResponse('gate', 'gate-1', { x: 'hi' });
    return textResponse('resumed-done');
  });

  const suspendAgent = new Agent({
    id: 'skills-execution-probe-suspend',
    name: 'skills-execution-probe-suspend',
    model: suspendModel,
    tools: { gate },
    defaultOptions: { maxSteps: 5 },
  });
  // Snapshot persistence for resume requires Mastra storage registration.
  new Mastra({
    agents: { 'skills-execution-probe-suspend': suspendAgent },
    storage: new MockStore(),
  });

  const suspended = await suspendAgent.generate('please gate');
  assert.equal(suspended.finishReason, 'suspended');
  assert.ok(typeof suspended.runId === 'string' && suspended.runId.length > 0);
  assert.ok(suspended.suspendPayload);

  const resumed = await suspendAgent.resumeGenerate(
    { answer: 'yes' },
    { runId: suspended.runId },
  );
  const resumePreservesRunId = resumed.runId === suspended.runId;
  assert.equal(resumed.text, 'resumed-done');
  assert.equal(toolContexts.length, 2);
  assert.equal(toolContexts[0]!.hasAgentSuspend, true);
  assert.equal(toolContexts[0]!.workflowRunId, undefined);
  assert.ok(toolContexts[0]!.agentKeys.includes('toolCallId'));
  assert.ok(toolContexts[0]!.agentKeys.includes('threadId'));
  assert.ok(toolContexts[0]!.agentKeys.includes('resourceId'));
  assert.ok(!toolContexts[0]!.agentKeys.includes('runId'));

  return {
    sharedAcrossThreeModelSteps,
    sharedAcrossSecondUserTurn,
    firstRunId: first.runId,
    secondRunId: second.runId,
    resumePreservesRunId,
    suspendedRunId: suspended.runId,
    toolAgentContextFields: toolContexts[0]!.agentKeys.slice().sort(),
  };
}

test('provider mock probe: three model steps share processor state; second user turn does not', async () => {
  const result = await runSkillsExecutionProbe();
  assert.equal(result.sharedAcrossThreeModelSteps, true);
  assert.equal(result.sharedAcrossSecondUserTurn, false);
  assert.notEqual(result.firstRunId, result.secondRunId);
  assert.equal(result.resumePreservesRunId, true);
  assert.match(result.suspendedRunId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(result.toolAgentContextFields, [
    'agentId',
    'flushMessages',
    'messages',
    'outputWriter',
    'resourceId',
    'resumeData',
    'suspend',
    'suspendPayload',
    'suspendedToolRunId',
    'threadId',
    'toolCallId',
  ].sort());
});
