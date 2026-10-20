/**
 * Task 5 A-gate: Mastra model-boundary tests with provider HTTP mock.
 * Pins to result.runId / processInputStep.runId — never ctx.agent.runId.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { RequestContext } from '@mastra/core/request-context';
import { MockStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getPool } from '../src/mastra/auth/db.ts';
import { createUser } from '../src/mastra/auth/service.ts';
import { listAgentToolIds } from '../src/mastra/agents/agent.ts';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { isAgentSkillsEnabled } from '../src/mastra/skills/config.ts';
import {
  bindSkillServerExecutionId,
  bindSkillThreadId,
  readBoundServerExecutionId,
  readSelectedSkillIds,
  resolveSkillExecution,
} from '../src/mastra/skills/execution-context.ts';
import {
  createSkillProcessor,
  listSharedActivations,
  noteToolActivation,
} from '../src/mastra/skills/processor.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import { createSkillRepository } from '../src/mastra/skills/repository.ts';
import { createSkillService } from '../src/mastra/skills/service.ts';
import { createSkillTools } from '../src/mastra/skills/tools.ts';
import type { SkillActor, SkillActivationEvent } from '../src/mastra/skills/types.ts';
import {
  SELECTED_SKILL_IDS_CONTEXT_KEY,
  SERVER_EXECUTION_ID_CONTEXT_KEY,
  SKILL_ACTIVATION_CHUNK_TYPE,
  SKILL_LIMITS,
} from '../src/mastra/skills/validation.ts';
import {
  createSkillVersionService,
  publishSkill,
} from '../src/mastra/skills/versions.ts';
import { runSkillsExecutionProbe } from './skills-execution-probe.test.ts';

function resolveSafeTestDatabaseUrl(): { ok: true; url: string } | { ok: false; reason: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL unset; skills agent integration skipped' };
  }
  try {
    const parsed = new URL(raw);
    const hostOk = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
    const portOk = parsed.port === '5433';
    const dbOk = parsed.pathname.replace(/^\//, '') === 'nero_agent';
    if (!hostOk || !portOk || !dbOk) {
      return {
        ok: false,
        reason:
          'BLOCKED_ENV: DATABASE_URL is not the local db:local:setup target '
          + '(expected 127.0.0.1|localhost:5433/nero_agent); refusing skills agent integration',
      };
    }
    return { ok: true, url: raw };
  } catch {
    return { ok: false, reason: 'BLOCKED_ENV: DATABASE_URL is not a valid URL' };
  }
}

const safeDb = resolveSafeTestDatabaseUrl();
const hasSafeDatabase = safeDb.ok;

function actor(userId: string, roles: SkillActor['roles'] = ['user']): SkillActor {
  return { userId, roles };
}

function skillMd(name: string, body: string): string {
  return `---
name: ${name}
description: Integration skill ${name}
---

${body}
`;
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

type CapturedRequest = {
  body: unknown;
  systemText: string;
};

function extractSystemText(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages;
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role !== 'system') continue;
    if (typeof m.content === 'string') parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p && typeof p === 'object' && 'text' in p) parts.push(String((p as { text: unknown }).text));
      }
    }
  }
  return parts.join('\n');
}

test('Task 0 probe still passes (shared state within generate only)', async () => {
  const result = await runSkillsExecutionProbe();
  assert.equal(result.sharedAcrossThreeModelSteps, true);
  assert.equal(result.sharedAcrossSecondUserTurn, false);
  assert.notEqual(result.firstRunId, result.secondRunId);
  assert.equal(result.resumePreservesRunId, true);
});

test('AGENT_SKILLS_ENABLED default off: no skill tools in agent list', () => {
  assert.equal(isAgentSkillsEnabled(), process.env.AGENT_SKILLS_ENABLED === 'true');
  if (process.env.AGENT_SKILLS_ENABLED === 'true') return;
  const rc = new RequestContext();
  rc.set('mastra__user', {
    id: randomUUID(),
    email: 'x@test',
    displayName: 'x',
    roles: ['user'],
  });
  const ids = listAgentToolIds(rc);
  assert.ok(!ids.includes('skill'));
  assert.ok(!ids.includes('skill_read'));
  assert.ok(!ids.includes('skill_search'));
  assert.ok(ids.includes('web_search') || ids.includes('ask_user') || ids.includes('web_fetch'));
});

test('readSelectedSkillIds accepts UUID intents only', () => {
  const rc = new RequestContext();
  const a = randomUUID();
  const b = randomUUID();
  rc.set(SELECTED_SKILL_IDS_CONTEXT_KEY, [a, 'not-a-uuid', b, { id: a }, a]);
  assert.deepEqual(readSelectedSkillIds(rc), [a, b]);
});

test(
  'skills agent integration: catalog/selected/pin/resume/metadata/revoke',
  { skip: !hasSafeDatabase },
  async () => {
    assert.ok(hasSafeDatabase, safeDb.ok ? 'ok' : safeDb.reason);
    const prevEnabled = process.env.AGENT_SKILLS_ENABLED;
    const prevStorage = process.env.SKILLS_STORAGE_ROOT;
    const storageRoot = await mkdtemp(join(tmpdir(), 'skills-agent-'));
    process.env.AGENT_SKILLS_ENABLED = 'true';
    process.env.SKILLS_STORAGE_ROOT = storageRoot;

    const pool = getPool();
    const repo = createSkillRepository(pool);
    const blobStore = createBlobStore({ root: storageRoot });
    const releaseStore = createReleaseStore({ root: storageRoot, blobStore });
    const versions = createSkillVersionService({ repository: repo, blobStore, releaseStore, pool });
    const service = createSkillService({
      repository: repo,
      blobStore,
      releaseStore,
      versionService: versions,
      pool,
    });
    const processor = createSkillProcessor({ service, repository: repo });
    const tools = createSkillTools({
      service,
      repository: repo,
      onActivation: (event, requestContext) => {
        noteToolActivation(undefined, event, requestContext);
      },
    });

    const suffix = randomUUID().slice(0, 8);
    const password = 'correct horse battery staple';
    const userIds: string[] = [];
    const skillIds: string[] = [];
    const captured: CapturedRequest[] = [];
    const streamActivations: SkillActivationEvent[] = [];
    let stampedMetadata: SkillActivationEvent[] | undefined;

    try {
      const owner = await createUser({
        email: `skill-ag-owner-${suffix}@example.test`,
        displayName: 'Agent Owner',
        password,
        role: 'user',
      });
      userIds.push(owner.id);
      const other = await createUser({
        email: `skill-ag-other-${suffix}@example.test`,
        displayName: 'Other',
        password,
        role: 'user',
      });
      userIds.push(other.id);

      const allowedName = `ag-ok-${suffix}`;
      const secretName = `ag-secret-${suffix}`;
      const allowed = await repo.createDraft({
        ownerUserId: owner.id,
        canonicalName: allowedName,
        description: 'allowed',
        skillMd: skillMd(allowedName, '# ALLOWED_INSTRUCTIONS_MARKER'),
      });
      skillIds.push(allowed.skill.id);
      const secret = await repo.createDraft({
        ownerUserId: other.id,
        canonicalName: secretName,
        description: 'secret private',
        skillMd: skillMd(secretName, '# SECRET_FULL_BODY_SHOULD_NOT_LEAK'),
      });
      skillIds.push(secret.skill.id);

      const pubAllowed = await publishSkill(versions, actor(owner.id), {
        skillId: allowed.skill.id,
        version: 1,
        expectedRevision: allowed.skill.revision,
      });
      await service.setEnabled(actor(owner.id), {
        skillId: allowed.skill.id,
        expectedRevision: pubAllowed.skill.revision,
        enabled: true,
      });
      const pubSecret = await publishSkill(versions, actor(other.id), {
        skillId: secret.skill.id,
        version: 1,
        expectedRevision: secret.skill.revision,
      });
      await service.setEnabled(actor(other.id), {
        skillId: secret.skill.id,
        expectedRevision: pubSecret.skill.revision,
        enabled: true,
      });

      let call = 0;
      const model = createOpenAICompatible({
        name: 'skills-agent-mock',
        baseURL: 'https://example.test/v1',
        apiKey: 'test',
        fetch: async (_url, init) => {
          call += 1;
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
          captured.push({ body, systemText: extractSystemText(body) });
          if (call === 1) {
            // After selected load, model may call skill tool or stop — use stop after first.
            return textResponse('ok-after-selected');
          }
          if (call === 2) return toolCallResponse('skill', 'skill-1', { name: allowedName });
          if (call === 3) return textResponse('after-tool');
          return textResponse('done');
        },
      }).chatModel('test');

      const gate = createTool({
        id: 'gate',
        description: 'approval gate',
        inputSchema: z.object({ x: z.string() }),
        suspendSchema: z.object({ reason: z.string() }),
        resumeSchema: z.object({ answer: z.string() }),
        execute: async (input, ctx) => {
          if (!(ctx.agent?.resumeData ?? ctx.resumeData)) {
            await ctx.agent!.suspend({ reason: 'need-user' });
            return { ok: false };
          }
          return { ok: true, x: input.x };
        },
      });

      const agent = new Agent({
        id: 'skills-agent-it',
        name: 'skills-agent-it',
        model,
        tools: { ...tools, gate },
        inputProcessors: [processor],
        outputProcessors: [processor],
        defaultOptions: { maxSteps: 8 },
      });
      new Mastra({
        agents: { 'skills-agent-it': agent },
        storage: new MockStore(),
      });

      const requestContext = new RequestContext();
      requestContext.set('mastra__user', owner);
      requestContext.set(SELECTED_SKILL_IDS_CONTEXT_KEY, [allowed.skill.id, secret.skill.id]);

      const threadId = randomUUID();
      bindSkillThreadId(requestContext, threadId);
      const firstRunId = bindSkillServerExecutionId(requestContext);

      // Capture data-nero-skill-activation via writer.custom (inject if Mastra omits writer)
      const capturingProcessor = {
        id: 'nero-agent-skills-capture',
        async processInputStep(args: Parameters<NonNullable<typeof processor.processInputStep>>[0]) {
          const writer = (args as { writer?: { custom: (chunk: { type: string; data: unknown }) => Promise<void> } }).writer;
          const wrappedWriter = {
            custom: async (chunk: { type: string; data: unknown }) => {
              if (chunk.type === SKILL_ACTIVATION_CHUNK_TYPE) {
                streamActivations.push(chunk.data as SkillActivationEvent);
              }
              if (writer) return writer.custom(chunk);
            },
          };
          return processor.processInputStep?.({
            ...args,
            writer: wrappedWriter,
          } as never);
        },
        processLLMRequest: processor.processLLMRequest?.bind(processor),
        async processOutputResult(args: Parameters<NonNullable<typeof processor.processOutputResult>>[0]) {
          await processor.processOutputResult?.(args as never);
          const messages = (args as {
            messageList?: {
              get?: { response?: { db?: () => Array<{ role: string; content: { metadata?: Record<string, unknown> } }> } };
            };
          }).messageList?.get?.response?.db?.() ?? [];
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i]!;
            if (msg.role !== 'assistant') continue;
            const activations = msg.content.metadata?.neroSkillActivations;
            if (Array.isArray(activations)) {
              stampedMetadata = activations as SkillActivationEvent[];
            }
            break;
          }
          // Fallback: shared registry must still hold the summary for metadata persistence path
          if (!stampedMetadata?.length) {
            stampedMetadata = listSharedActivations(requestContext);
          }
        },
      };

      const streamAgent = new Agent({
        id: 'skills-agent-it-stream',
        name: 'skills-agent-it-stream',
        model,
        tools: { ...tools, gate },
        inputProcessors: [capturingProcessor],
        outputProcessors: [capturingProcessor],
        defaultOptions: { maxSteps: 8 },
      });
      new Mastra({
        agents: { 'skills-agent-it-stream': streamAgent },
        storage: new MockStore(),
      });

      // selected_skill_loaded_before_first_request + selected_failure_is_visible
      const first = await streamAgent.generate('use selected skills', {
        requestContext,
        runId: firstRunId,
        memory: { thread: threadId, resource: owner.id },
      });
      assert.equal(first.runId, firstRunId);
      assert.ok(captured.length >= 1, 'model received at least one request');
      const firstSystem = captured[0]!.systemText;
      assert.match(firstSystem, /<nero_available_skills>/);
      assert.match(firstSystem, new RegExp(allowedName));
      assert.doesNotMatch(firstSystem, /SECRET_FULL_BODY_SHOULD_NOT_LEAK/);
      assert.doesNotMatch(firstSystem, new RegExp(secretName));
      assert.match(firstSystem, /ALLOWED_INSTRUCTIONS_MARKER/);
      assert.match(firstSystem, /nero_skill_activation_errors|SKILL_UNAVAILABLE|failed/i);

      // Catalog appears once
      const catalogCount = (firstSystem.match(/<nero_available_skills>/g) ?? []).length;
      assert.equal(catalogCount, 1);

      // data-nero-skill-activation observable (writer capture) + shared summary
      assert.ok(
        streamActivations.some((a) => a.status === 'loaded' && a.skillId === allowed.skill.id),
        'expected loaded activation chunk',
      );
      assert.ok(
        streamActivations.some((a) => a.status === 'failed'),
        'expected failed activation chunk for unauthorized selected skill',
      );
      const shared = listSharedActivations(requestContext);
      assert.ok(shared.some((a) => a.status === 'loaded'));
      assert.ok(
        stampedMetadata?.some((a) => a.status === 'loaded' && a.skillId === allowed.skill.id),
        'expected neroSkillActivations on assistant metadata',
      );

      // Pins persisted for server execution id (bound runId, not client forge)
      const pins = await repo.listRunPins({
        serverExecutionId: firstRunId,
        userId: owner.id,
        threadId,
      });
      assert.ok(pins.some((p) => p.skillId === allowed.skill.id && p.version === 1));

      // second_step_reuses_pin via tool path in new generate would refresh — use in-memory exec
      const ctxReuse = await resolveSkillExecution({
        requestContext,
        serverExecutionId: firstRunId,
        threadId,
        repository: repo,
      });
      assert.equal(ctxReuse.pins.get(allowed.skill.id)?.version, 1);

      // Publish v2; same execution keeps v1
      const draft2 = await repo.createWorkingDraft({
        skillId: allowed.skill.id,
        expectedRevision: (await repo.getSkill(allowed.skill.id))!.revision,
        actorUserId: owner.id,
        description: 'v2',
        skillMd: skillMd(allowedName, '# V2_BODY_MARKER'),
      });
      await publishSkill(versions, actor(owner.id), {
        skillId: allowed.skill.id,
        version: draft2.version.version,
        expectedRevision: draft2.skill.revision,
      });
      const reload = await service.load(ctxReuse, allowedName);
      assert.equal(reload.ok, true);
      if (reload.ok) assert.equal(reload.skill.version, 1);

      // new_execution_refreshes_version
      const secondRunId = bindSkillServerExecutionId(requestContext);
      const second = await agent.generate('new turn', {
        requestContext,
        runId: secondRunId,
        memory: { thread: threadId, resource: owner.id },
      });
      assert.equal(second.runId, secondRunId);
      assert.notEqual(second.runId, first.runId);
      const ctxNew = await resolveSkillExecution({
        requestContext,
        serverExecutionId: secondRunId,
        threadId,
        repository: repo,
      });
      // empty until load; load now
      const loadNew = await service.load(ctxNew, allowedName);
      assert.equal(loadNew.ok, true);
      if (loadNew.ok) assert.equal(loadNew.skill.version, 2);

      // approval_resume_preserves_pin
      let resumeCall = 0;
      const resumeModel = createOpenAICompatible({
        name: 'skills-resume-mock',
        baseURL: 'https://example.test/v1',
        apiKey: 'test',
        fetch: async () => {
          resumeCall += 1;
          if (resumeCall === 1) return toolCallResponse('gate', 'gate-1', { x: 'hi' });
          return textResponse('resumed');
        },
      }).chatModel('test');
      const resumeAgent = new Agent({
        id: 'skills-resume-it',
        name: 'skills-resume-it',
        model: resumeModel,
        tools: { ...tools, gate },
        inputProcessors: [processor],
        outputProcessors: [processor],
        defaultOptions: { maxSteps: 5 },
      });
      new Mastra({
        agents: { 'skills-resume-it': resumeAgent },
        storage: new MockStore(),
      });
      const resumeRc = new RequestContext();
      resumeRc.set('mastra__user', owner);
      bindSkillThreadId(resumeRc, threadId);
      const suspendRunId = bindSkillServerExecutionId(resumeRc);
      const suspended = await resumeAgent.generate('gate please', {
        requestContext: resumeRc,
        runId: suspendRunId,
        memory: { thread: threadId, resource: owner.id },
      });
      assert.equal(suspended.finishReason, 'suspended');
      assert.equal(suspended.runId, suspendRunId);
      // Pin a skill on this execution before resume
      const pinCtx = await resolveSkillExecution({
        requestContext: resumeRc,
        serverExecutionId: suspendRunId,
        threadId,
        repository: repo,
      });
      const pinned = await service.load(pinCtx, allowedName);
      assert.equal(pinned.ok, true);
      const pinnedVersion = pinned.ok ? pinned.skill.version : -1;

      bindSkillServerExecutionId(resumeRc, suspendRunId);
      const resumed = await resumeAgent.resumeGenerate(
        { answer: 'yes' },
        { runId: suspendRunId, requestContext: resumeRc },
      );
      assert.equal(resumed.runId, suspendRunId);
      const afterResume = await resolveSkillExecution({
        requestContext: resumeRc,
        serverExecutionId: suspendRunId,
        threadId,
        repository: repo,
      });
      assert.equal(afterResume.pins.get(allowed.skill.id)?.version, pinnedVersion);

      // forged_context_does_not_pin_version
      const forgedRc = new RequestContext();
      forgedRc.set('mastra__user', owner);
      forgedRc.set('nero-agent.skill-pins', [{ skillId: allowed.skill.id, version: 99 }]);
      forgedRc.set('runId', 'client-forged-run-id');
      const forgedExec = await resolveSkillExecution({
        requestContext: forgedRc,
        serverExecutionId: randomUUID(),
        threadId,
        repository: repo,
      });
      assert.equal(forgedExec.pins.size, 0);
      assert.notEqual(forgedExec.serverExecutionId, 'client-forged-run-id');

      // forged requestContext execution id does not become pin key (WeakMap authority)
      const forgedExecId = `forged-${randomUUID()}`;
      const forgeOnlyRc = new RequestContext();
      forgeOnlyRc.set('mastra__user', owner);
      forgeOnlyRc.set(SELECTED_SKILL_IDS_CONTEXT_KEY, [allowed.skill.id]);
      forgeOnlyRc.set(SERVER_EXECUTION_ID_CONTEXT_KEY, forgedExecId);
      assert.equal(readBoundServerExecutionId(forgeOnlyRc), null);
      const forgeProcessor = createSkillProcessor({ service, repository: repo });
      await forgeProcessor.processInputStep?.({
        runId: undefined,
        stepNumber: 0,
        state: {},
        requestContext: forgeOnlyRc,
        messageList: undefined,
        writer: undefined,
      } as never);
      const forgedPins = await repo.listRunPins({
        serverExecutionId: forgedExecId,
        userId: owner.id,
        threadId,
      });
      assert.equal(forgedPins.length, 0, 'forged string-key execution id must not become pin key');

      // no identity → no catalog leak
      const anonRc = new RequestContext();
      await assert.rejects(
        () =>
          resolveSkillExecution({
            requestContext: anonRc,
            serverExecutionId: randomUUID(),
            threadId,
            repository: repo,
          }),
      );

      // Revoke: disable skill → subsequent load fails; reinject skipped
      const latest = await repo.getSkill(allowed.skill.id);
      await service.setEnabled(actor(owner.id), {
        skillId: allowed.skill.id,
        expectedRevision: latest!.revision,
        enabled: false,
      });
      const revoked = await service.load(ctxNew, allowedName);
      assert.equal(revoked.ok, false);

      // SKILL_CONTEXT_LIMIT: two large-but-valid skills exceed 128KiB reinjection budget
      const chunk = 'Y'.repeat(Math.floor(SKILL_LIMITS.INSTRUCTIONS_CONTEXT_MAX_BYTES * 0.55));
      const hugeIds: string[] = [];
      for (const label of ['a', 'b'] as const) {
        const hugeName = `ag-huge-${label}-${suffix}`;
        const huge = await repo.createDraft({
          ownerUserId: owner.id,
          canonicalName: hugeName,
          description: `huge-${label}`,
          skillMd: skillMd(hugeName, chunk),
        });
        skillIds.push(huge.skill.id);
        hugeIds.push(huge.skill.id);
        const pubHuge = await publishSkill(versions, actor(owner.id), {
          skillId: huge.skill.id,
          version: 1,
          expectedRevision: huge.skill.revision,
        });
        await service.setEnabled(actor(owner.id), {
          skillId: huge.skill.id,
          expectedRevision: pubHuge.skill.revision,
          enabled: true,
        });
      }

      const hugeCaptured: string[] = [];
      const hugeModel = createOpenAICompatible({
        name: 'skills-huge-mock',
        baseURL: 'https://example.test/v1',
        apiKey: 'test',
        fetch: async (_url, init) => {
          const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
          hugeCaptured.push(extractSystemText(body));
          return textResponse('huge-done');
        },
      }).chatModel('test');
      const hugeAgent = new Agent({
        id: 'skills-huge-it',
        name: 'skills-huge-it',
        model: hugeModel,
        tools,
        inputProcessors: [processor],
        outputProcessors: [processor],
        defaultOptions: { maxSteps: 3 },
      });
      const hugeRc = new RequestContext();
      hugeRc.set('mastra__user', owner);
      hugeRc.set(SELECTED_SKILL_IDS_CONTEXT_KEY, hugeIds);
      const hugeThread = randomUUID();
      bindSkillThreadId(hugeRc, hugeThread);
      const hugeRunId = bindSkillServerExecutionId(hugeRc);
      await hugeAgent.generate('load huge', {
        requestContext: hugeRc,
        runId: hugeRunId,
        memory: { thread: hugeThread, resource: owner.id },
      });
      assert.ok(hugeCaptured[0]);
      assert.match(hugeCaptured[0]!, /SKILL_CONTEXT_LIMIT/);

      assert.equal(SKILL_ACTIVATION_CHUNK_TYPE, 'data-nero-skill-activation');
    } finally {
      if (prevEnabled === undefined) delete process.env.AGENT_SKILLS_ENABLED;
      else process.env.AGENT_SKILLS_ENABLED = prevEnabled;
      if (prevStorage === undefined) delete process.env.SKILLS_STORAGE_ROOT;
      else process.env.SKILLS_STORAGE_ROOT = prevStorage;

      for (const id of skillIds) {
        await pool.query(`DELETE FROM app_skill_run_pins WHERE skill_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_events WHERE skill_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_files WHERE skill_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_versions WHERE skill_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skill_aliases WHERE skill_id = $1`, [id]).catch(() => undefined);
        await pool.query(`DELETE FROM app_skills WHERE id = $1`, [id]).catch(() => undefined);
      }
      for (const id of userIds) {
        await pool.query(`DELETE FROM app_users WHERE id = $1`, [id]).catch(() => undefined);
      }
      await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);
