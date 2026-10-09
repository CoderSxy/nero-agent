import type { Processor } from '@mastra/core/processors';
import {
  sanitizeAttachedFileForPersistence,
  type AttachedFileToolResult,
} from './tools';

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

/**
 * Keep multimodal image-data available for the current model turn via toModelOutput,
 * but strip raw imageBase64 / image-data from persisted message list before memory
 * and observational storage.
 */
export const attachmentPersistenceProcessor: Processor = {
  id: 'attachment-persistence-sanitizer',

  async processToolResult({ toolName, toolCallId, args, result, messageList }) {
    if (toolName !== 'read_attached_file') return;
    if (!result || typeof result !== 'object') return;
    const typed = result as AttachedFileToolResult;
    if (!typed.imageBase64) return;
    // Redact raw execute payload for streams/transcript; leave modelOutput alone so
    // the current turn's next LLM step can still see image-data from toModelOutput.
    messageList.updateToolInvocation({
      type: 'tool-invocation',
      toolInvocation: {
        state: 'result',
        toolCallId,
        toolName,
        args,
        result: sanitizeAttachedFileForPersistence(typed).result,
      },
    });
  },

  async processOutputResult({ messageList }) {
    stripStoredImageBytes(messageList);
  },

  async processInputStep({ messageList }) {
    stripStoredImageBytes(messageList);
  },
};

function stripStoredImageBytes(messageList: {
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
      const serialized = JSON.stringify({ result: invocation.result, modelOutput });
      if (!serialized.includes('imageBase64') && !serialized.includes('"image-data"')
        && !serialized.includes('data:image')) {
        continue;
      }
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
