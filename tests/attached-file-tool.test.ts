import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestContext } from '@mastra/core/request-context';
import { authContextFromUser } from '../src/mastra/auth/auth-context';
import type { AuthUser } from '../src/mastra/auth/service';
import { AttachmentService } from '../src/mastra/files/attachments';
import {
  attachmentPersistenceProcessor,
  rehydratePromptImages,
  stripStoredImageBytes,
} from '../src/mastra/files/attachment-persistence-processor';
import {
  attachedFileModelOutputForTurn,
  createReadAttachedFileTool,
  sanitizeAttachedFileForPersistence,
  userFileTools,
  type AttachedFileToolResult,
} from '../src/mastra/files/tools';
import { ThreadGuardError } from '../src/mastra/auth/thread-guard';

const TOOLS_SRC = join(dirname(fileURLToPath(import.meta.url)), '../src/mastra/files/tools.ts');

const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const THREAD_A = 'thread-attach-tool-a';
const THREAD_B = 'thread-attach-tool-b';
const TEXT_LIMIT = 64 * 1024;

function user(id: string, roles: AuthUser['roles'] = ['user']): AuthUser {
  return { id, email: `${id}@example.test`, displayName: 'u', roles };
}

function lookup() {
  return {
    getThreadById: async ({ threadId }: { threadId: string }) => {
      if (threadId === THREAD_B) return { id: threadId, resourceId: OTHER_ID };
      if (threadId === THREAD_A) return { id: threadId, resourceId: USER_ID };
      return null;
    },
  };
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withMemoryWorkspace<T>(run: (root: string) => Promise<T>): Promise<T> {
  const env = snapshotEnv(['DATABASE_URL', 'WORKSPACE_ROOT']);
  delete process.env.DATABASE_URL;
  const root = await mkdtemp(join(tmpdir(), 'attach-tool-'));
  process.env.WORKSPACE_ROOT = root;
  try {
    return await run(root);
  } finally {
    restoreEnv(env);
  }
}

function toolContext(opts: {
  threadId?: string;
  userId?: string;
  supportsVision?: boolean;
  attachments?: AttachmentService;
}) {
  const requestContext = new RequestContext();
  requestContext.set('mastra__user', user(opts.userId ?? USER_ID));
  if (typeof opts.supportsVision === 'boolean') {
    requestContext.set('nero-agent.model-supports-vision', opts.supportsVision);
  }
  const attachments = opts.attachments ?? new AttachmentService(lookup());
  return {
    requestContext,
    mastra: {
      getAgent: () => ({
        getMemory: async () => lookup(),
        getWorkspace: async () => undefined,
      }),
    },
    agent: opts.threadId ? { threadId: opts.threadId } : undefined,
    __attachments: attachments,
  } as never;
}

async function prepareTextAttachment(content: string | Buffer, name: string) {
  const attachments = new AttachmentService(lookup());
  const auth = authContextFromUser(user(USER_ID));
  const uploads = join(process.env.WORKSPACE_ROOT!, 'users', USER_ID, 'workspace', 'uploads', 't1');
  await mkdir(uploads, { recursive: true });
  const path = `uploads/t1/${name}`;
  await writeFile(join(process.env.WORKSPACE_ROOT!, 'users', USER_ID, 'workspace', path), content);
  const [ref] = await attachments.prepare(auth, THREAD_A, `msg-${name}`, [
    { source: 'personal', path },
  ]);
  return { attachments, ref };
}

function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}

test('userFileTools exposes read_attached_file', () => {
  assert.ok(userFileTools.read_attached_file);
  assert.equal(userFileTools.read_attached_file.id, 'read_attached_file');
});

test('read_attached_file rejects cross-thread attachment ids', async () => {
  await withMemoryWorkspace(async () => {
    const { attachments, ref } = await prepareTextAttachment('hello', 'note.txt');
    const tool = createReadAttachedFileTool({
      attachmentsFrom: async () => attachments,
      modelSupportsVision: async () => false,
    });
    await assert.rejects(
      () => tool.execute!({ attachmentId: ref.attachmentId } as never, toolContext({
        threadId: THREAD_B,
        userId: OTHER_ID,
        attachments,
      })),
      (error: unknown) => error instanceof ThreadGuardError || (error instanceof Error && /denied|无权|thread/i.test(error.message)),
    );
  });
});

test('read_attached_file returns truncated UTF-8 text with truncated flag', async () => {
  await withMemoryWorkspace(async () => {
    const body = '字'.repeat(TEXT_LIMIT + 32);
    const { attachments, ref } = await prepareTextAttachment(body, 'big.txt');
    const tool = createReadAttachedFileTool({
      attachmentsFrom: async () => attachments,
      modelSupportsVision: async () => false,
    });
    const result = await tool.execute!({ attachmentId: ref.attachmentId } as never, toolContext({
      threadId: THREAD_A,
      attachments,
    }));
    assert.equal(result.kind, 'text');
    assert.equal(result.truncated, true);
    assert.ok(typeof result.content === 'string');
    assert.ok(Buffer.byteLength(result.content!, 'utf8') <= TEXT_LIMIT);
    assert.equal(result.attachmentId, ref.attachmentId);
    assert.equal(result.name, 'big.txt');
  });
});

test('read_attached_file rejects non-image binary as text', async () => {
  await withMemoryWorkspace(async () => {
    const { attachments, ref } = await prepareTextAttachment(Buffer.from([0, 1, 2, 3, 4, 255]), 'blob.bin');
    const tool = createReadAttachedFileTool({
      attachmentsFrom: async () => attachments,
      modelSupportsVision: async () => true,
    });
    await assert.rejects(
      () => tool.execute!({ attachmentId: ref.attachmentId } as never, toolContext({
        threadId: THREAD_A,
        supportsVision: true,
        attachments,
      })),
      /二进制|binary|不支持/i,
    );
  });
});

test('toModelOutput persists workspace refs only; turn media stays out of durable shapes', async () => {
  await withMemoryWorkspace(async () => {
    const png = tinyPng();
    const { attachments, ref } = await prepareTextAttachment(png, 'dot.png');
    const tool = createReadAttachedFileTool({
      attachmentsFrom: async () => attachments,
      modelSupportsVision: async () => true,
    });
    const result = await tool.execute!({ attachmentId: ref.attachmentId } as never, toolContext({
      threadId: THREAD_A,
      supportsVision: true,
      attachments,
    }));
    assert.equal(result.kind, 'image');
    assert.ok(result.imageBase64);
    assert.equal(result.imageBase64, png.toString('base64'));

    assert.ok(typeof tool.toModelOutput === 'function');
    const modelOut = tool.toModelOutput!(result) as {
      type: string;
      value: Array<{ type: string; data?: string; mediaType?: string; text?: string }>;
    };
    assert.equal(modelOut.type, 'content');
    assert.equal(modelOut.value.some(part => part.type === 'image-data' || part.type === 'media'), false);
    assert.match(JSON.stringify(modelOut), /workspace-attachment:/);
    assert.doesNotMatch(JSON.stringify(modelOut), /iVBORw0KGgo/);

    const turnOut = attachedFileModelOutputForTurn(result) as {
      type: string;
      value: Array<{ type: string; data?: string; mediaType?: string }>;
    };
    assert.ok(turnOut);
    const mediaPart = turnOut.value.find(part => part.type === 'media');
    assert.ok(mediaPart);
    assert.equal(mediaPart!.data, png.toString('base64'));
    assert.equal(mediaPart!.mediaType, 'image/png');

    const display = tool.transform?.display?.output?.({
      target: 'display',
      phase: 'output-available',
      output: result,
    } as never);
    const transcript = tool.transform?.transcript?.output?.({
      target: 'transcript',
      phase: 'output-available',
      output: result,
    } as never);
    for (const payload of [display, transcript]) {
      const text = JSON.stringify(payload);
      assert.ok(payload && typeof payload === 'object');
      assert.equal((payload as { attachmentId: string }).attachmentId, ref.attachmentId);
      assert.equal((payload as { name: string }).name, 'dot.png');
      assert.ok('status' in (payload as object));
      assert.doesNotMatch(text, /data:/);
      assert.doesNotMatch(text, /iVBORw0KGgo/);
      assert.equal('imageBase64' in (payload as object), false);
      assert.equal('content' in (payload as object), false);
    }

    const sanitized = sanitizeAttachedFileForPersistence(result, turnOut);
    const sanitizedText = JSON.stringify(sanitized);
    assert.doesNotMatch(sanitizedText, /iVBORw0KGgo/);
    assert.doesNotMatch(sanitizedText, /data:/);
    assert.doesNotMatch(sanitizedText, /"type":"media"/);
    assert.equal((sanitized.result as { attachmentId: string }).attachmentId, ref.attachmentId);
  });
});

test('client requestContext vision flag cannot force image output when catalog denies', async () => {
  await withMemoryWorkspace(async () => {
    const src = await readFile(TOOLS_SRC, 'utf8');
    assert.equal(src.includes('nero-agent.model-supports-vision'), false);
    assert.equal(src.includes('VISION_OVERRIDE'), false);

    const { attachments, ref } = await prepareTextAttachment(tinyPng(), 'dot.png');
    // Production default ignores client flags; tests inject catalog result via deps only.
    const tool = createReadAttachedFileTool({
      attachmentsFrom: async () => attachments,
      modelSupportsVision: async () => false,
    });
    await assert.rejects(
      () => tool.execute!({ attachmentId: ref.attachmentId } as never, toolContext({
        threadId: THREAD_A,
        supportsVision: true,
        attachments,
      })),
      /不支持图片|vision|视觉/i,
    );
  });
});

test('processToolResult + processLLMRequest keep bytes off durable messages across multistep', async () => {
  const pngB64 = tinyPng().toString('base64');
  const toolCallId = 'call-img-1';
  const rawResult: AttachedFileToolResult = {
    attachmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'dot.png',
    status: 'available',
    mimeType: 'image/png',
    kind: 'image',
    imageBase64: pngB64,
  };

  const invocations: unknown[] = [];
  const messageList = {
    get: {
      all: {
        db: () => [{
          content: {
            parts: invocations.map(inv => ({
              type: 'tool-invocation',
              toolInvocation: inv,
              providerMetadata: (inv as { providerMetadata?: unknown }).providerMetadata,
            })),
          },
        }],
      },
    },
    updateToolInvocation(part: {
      toolInvocation: Record<string, unknown>;
      providerMetadata?: { mastra?: { modelOutput?: unknown } };
    }) {
      const existingIdx = invocations.findIndex(
        inv => (inv as { toolCallId?: string }).toolCallId === part.toolInvocation.toolCallId,
      );
      const next = {
        ...part.toolInvocation,
        providerMetadata: part.providerMetadata,
      };
      if (existingIdx >= 0) invocations[existingIdx] = next;
      else invocations.push(next);
    },
  };

  const state: Record<string, unknown> = {};

  await attachmentPersistenceProcessor.processToolResult!({
    toolName: 'read_attached_file',
    toolCallId,
    args: { attachmentId: rawResult.attachmentId },
    result: rawResult,
    messageList: messageList as never,
    state,
    messages: [],
    systemMessages: [],
    steps: [],
    stepNumber: 0,
    abort: () => {
      throw new Error('abort');
    },
    retryCount: 0,
  } as never);

  // Simulate Mastra rewriting providerMetadata after processToolResult with a dirty media payload
  // (as would happen if toModelOutput still carried bytes, or a future normalize path).
  messageList.updateToolInvocation({
    toolInvocation: {
      state: 'result',
      toolCallId,
      toolName: 'read_attached_file',
      args: { attachmentId: rawResult.attachmentId },
      result: { attachmentId: rawResult.attachmentId, name: 'dot.png', status: 'available' },
    },
    providerMetadata: {
      mastra: {
        modelOutput: {
          type: 'content',
          value: [{ type: 'media', data: pngB64, mediaType: 'image/png' }],
        },
      },
    },
  });

  await attachmentPersistenceProcessor.processOutputStream!({
    part: { type: 'tool-result', payload: { toolCallId, toolName: 'read_attached_file' } } as never,
    messageList: messageList as never,
    streamParts: [],
    state,
    abort: () => {
      throw new Error('abort');
    },
    retryCount: 0,
  } as never);

  const durable = JSON.stringify(messageList.get.all.db());
  assert.doesNotMatch(durable, /iVBORw0KGgo/);
  assert.doesNotMatch(durable, /"type":"media"/);
  assert.doesNotMatch(durable, /imageBase64/);
  assert.match(durable, /workspace-attachment:/);

  // Next LLM step (step>0): OM would see messageList — still clean — while processLLMRequest
  // rehydrates media only into the non-persisted prompt.
  const prompt = [{
    role: 'tool' as const,
    content: [{
      type: 'tool-result' as const,
      toolCallId,
      toolName: 'read_attached_file',
      output: {
        type: 'content',
        value: [{ type: 'text', text: '[workspace-attachment:…]' }],
      },
    }],
  }];
  const llmResult = await attachmentPersistenceProcessor.processLLMRequest!({
    prompt: prompt as never,
    model: {} as never,
    state,
    stepNumber: 1,
    steps: [],
    abort: () => {
      throw new Error('abort');
    },
    retryCount: 0,
  } as never);
  assert.ok(llmResult && typeof llmResult === 'object' && 'prompt' in llmResult);
  const rehydrated = JSON.stringify((llmResult as { prompt: unknown }).prompt);
  assert.match(rehydrated, /iVBORw0KGgo/);
  assert.match(rehydrated, /"type":"media"/);

  // Message list remains clean after rehydrate (prompt-only mutation).
  assert.doesNotMatch(JSON.stringify(messageList.get.all.db()), /iVBORw0KGgo/);

  // Explicit helper coverage for the rehydrate mapping.
  const mapped = rehydratePromptImages(prompt, {
    [toolCallId]: attachedFileModelOutputForTurn(rawResult),
  });
  assert.match(JSON.stringify(mapped), /iVBORw0KGgo/);

  stripStoredImageBytes(messageList as never);
  assert.doesNotMatch(JSON.stringify(messageList.get.all.db()), /iVBORw0KGgo/);
});

test('non-vision model rejects image attachments with a clear error', async () => {
  await withMemoryWorkspace(async () => {
    const { attachments, ref } = await prepareTextAttachment(tinyPng(), 'dot.png');
    const tool = createReadAttachedFileTool({
      attachmentsFrom: async () => attachments,
      modelSupportsVision: async () => false,
    });
    await assert.rejects(
      () => tool.execute!({ attachmentId: ref.attachmentId } as never, toolContext({
        threadId: THREAD_A,
        supportsVision: false,
        attachments,
      })),
      /不支持图片|vision|视觉/i,
    );
  });
});
