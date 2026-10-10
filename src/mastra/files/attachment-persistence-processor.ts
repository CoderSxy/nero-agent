import type { Processor } from '@mastra/core/processors';
import {
  attachedFileModelOutputForTurn,
  sanitizeAttachedFileForPersistence,
  type AttachedFileToolResult,
} from './tools';

type PromptMessage = {
  role: string;
  content: unknown;
};

type ToolResultPart = {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  output: unknown;
  providerOptions?: unknown;
};

const PENDING_IMAGE_OUTPUTS_KEY = 'pendingAttachedImageOutputs';

type ToolInvocationPart = {
  type?: string;
  toolInvocation?: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    state: string;
    result?: AttachedFileToolResult;
    providerMetadata?: { mastra?: { modelOutput?: unknown } };
  };
  providerMetadata?: { mastra?: { modelOutput?: unknown } };
};

type PendingImageOutputs = Record<string, AttachedFileToolResult>;

function pendingMap(state: Record<string, unknown>): PendingImageOutputs {
  const existing = state[PENDING_IMAGE_OUTPUTS_KEY];
  if (existing && typeof existing === 'object') return existing as PendingImageOutputs;
  const created: PendingImageOutputs = {};
  state[PENDING_IMAGE_OUTPUTS_KEY] = created;
  return created;
}

function containsImagePayload(value: unknown): boolean {
  if (value == null) return false;
  const text = JSON.stringify(value);
  return (
    text.includes('imageBase64')
    || text.includes('"image-data"')
    || text.includes('"file-data"')
    || text.includes('"type":"media"')
    || /data:image\//i.test(text)
  );
}

/**
 * Durable storage never retains raw image bytes. The current-turn model still
 * receives a native user image part via processLLMRequest (request-scoped state only).
 *
 * Why processLLMRequest: Mastra writes providerMetadata.mastra.modelOutput after
 * processToolResult, and Observational Memory can observe/persist on step>0
 * before final processOutputResult. processLLMRequest mutations are not persisted.
 */
export const attachmentPersistenceProcessor: Processor = {
  id: 'attachment-persistence-sanitizer',

  async processToolResult({ toolName, toolCallId, args, result, messageList, state }) {
    if (toolName !== 'read_attached_file') return;
    if (!result || typeof result !== 'object') return;
    const typed = result as AttachedFileToolResult;
    if (!typed.imageBase64 && typed.kind !== 'image') return;

    const turnOutput = attachedFileModelOutputForTurn(typed);
    if (turnOutput != null) {
      pendingMap(state)[toolCallId] = typed;
    }

    const sanitized = sanitizeAttachedFileForPersistence(typed, turnOutput);
    messageList.updateToolInvocation({
      type: 'tool-invocation',
      toolInvocation: {
        state: 'result',
        toolCallId,
        toolName,
        args,
        result: sanitized.result,
      },
      providerMetadata: {
        mastra: { modelOutput: sanitized.modelOutput },
      },
    });
  },

  async processOutputStream({ part, messageList }) {
    // After processToolResult, Mastra may rewrite providerMetadata with toModelOutput.
    // Re-strip any image bytes that landed on the message list before OM/input-step.
    if (messageList && part?.type === 'tool-result') {
      stripStoredImageBytes(messageList);
    }
    return part;
  },

  async processLLMRequest({ prompt, state }) {
    const pending = state[PENDING_IMAGE_OUTPUTS_KEY] as PendingImageOutputs | undefined;
    if (!pending || Object.keys(pending).length === 0) return;

    const next = rehydratePromptImages(prompt as PromptMessage[], pending);
    return { prompt: next as typeof prompt };
  },

  async processOutputResult({ messageList }) {
    stripStoredImageBytes(messageList);
  },

  async processInputStep({ messageList }) {
    stripStoredImageBytes(messageList);
  },
};

export function rehydratePromptImages(
  prompt: PromptMessage[],
  pending: PendingImageOutputs,
): PromptMessage[] {
  const result: PromptMessage[] = [];
  const imageMessages: PromptMessage[] = [];
  const flushImages = () => {
    result.push(...imageMessages);
    imageMessages.length = 0;
  };
  for (const message of prompt) {
    if (message.role !== 'tool') flushImages();
    result.push(message);
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      const typed = part as ToolResultPart;
      if (typed.type !== 'tool-result') continue;
      const image = pending[typed.toolCallId];
      if (!image?.imageBase64 || !image.mimeType.startsWith('image/')) continue;
      // OpenAI-compatible chat serializes tool `content` as JSON text. A user
      // file part becomes the image_url payload that the vision model accepts.
      imageMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: `以下是工具刚读取的图片附件 ${image.name}，请结合用户请求处理。` },
          { type: 'file', data: image.imageBase64, mediaType: image.mimeType },
        ],
      });
    }
  }
  flushImages();
  return result;
}

export function stripStoredImageBytes(messageList: {
  get: { all: { db(): unknown[] } };
  updateToolInvocation(part: unknown): void;
}): void {
  for (const message of messageList.get.all.db()) {
    const parts = (message as { content?: { parts?: unknown[] } }).content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const typed = part as ToolInvocationPart;
      const invocation = typed.toolInvocation;
      if (!invocation || invocation.toolName !== 'read_attached_file') continue;
      if (invocation.state !== 'result' || !invocation.result) continue;
      const meta = invocation.providerMetadata ?? typed.providerMetadata;
      const modelOutput = meta?.mastra?.modelOutput;
      if (!containsImagePayload({ result: invocation.result, modelOutput })) continue;
      const sanitized = sanitizeAttachedFileForPersistence(invocation.result, modelOutput);
      messageList.updateToolInvocation({
        type: 'tool-invocation',
        toolInvocation: {
          state: 'result',
          toolCallId: invocation.toolCallId,
          toolName: invocation.toolName,
          args: invocation.args,
          result: sanitized.result,
        },
        providerMetadata: {
          mastra: { modelOutput: sanitized.modelOutput },
        },
      });
    }
  }
}
