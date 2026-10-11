import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { messageParts, streamError } from './message-parts';
import { isUserMessage } from './pending-user-message';
import type { Thread } from './thread-scope';

export const RECENT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_SEARCH_RESULTS = 100;

const SNIPPET_MAX = 180;

export type HistorySearchDocument = {
  threadId: string;
  threadTitle: string;
  threadUpdatedAt: string;
  userMessageId: string;
  questionText: string;
  answerText: string;
};

export type HistorySearchResult = HistorySearchDocument & {
  matchSource: 'question' | 'answer';
  matchedSnippet: string;
};

function normalizeSearchText(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase();
}

function visibleTextFromMessage(message: MastraDBMessage): string {
  const chunks: string[] = [];
  for (const part of messageParts(message)) {
    if (part.kind !== 'text') continue;
    const text = part.text;
    if (!text.trim()) continue;
    if (streamError(text)) continue;
    chunks.push(text);
  }
  return chunks.join('');
}

type HistorySearchThreadInput = Pick<Thread, 'id' | 'title'> & { updatedAt: string | Date };

function flushTurn(
  thread: HistorySearchThreadInput,
  turn: { userMessageId: string; questionText: string },
  answerChunks: string[],
): HistorySearchDocument {
  return {
    threadId: thread.id,
    threadTitle: thread.title ?? '',
    threadUpdatedAt: new Date(thread.updatedAt).toISOString(),
    userMessageId: turn.userMessageId,
    questionText: turn.questionText,
    answerText: answerChunks.join('\n'),
  };
}

export function buildHistorySearchDocuments(
  thread: HistorySearchThreadInput,
  messages: MastraDBMessage[],
): HistorySearchDocument[] {
  const documents: HistorySearchDocument[] = [];
  let current: { userMessageId: string; questionText: string } | null = null;
  let answerChunks: string[] = [];

  const pushCurrent = () => {
    if (!current || !current.questionText.trim()) return;
    documents.push(flushTurn(thread, current, answerChunks));
  };

  for (const message of messages) {
    if (isUserMessage(message)) {
      pushCurrent();
      const questionText = visibleTextFromMessage(message);
      if (questionText.trim()) {
        current = { userMessageId: message.id, questionText };
        answerChunks = [];
      } else {
        current = null;
        answerChunks = [];
      }
      continue;
    }
    if (!current) continue;
    const answerText = visibleTextFromMessage(message);
    if (answerText) answerChunks.push(answerText);
  }

  pushCurrent();
  return documents;
}

type NormalizedMap = { normalized: string; indexToOriginal: number[] };

function buildNormalizedMap(original: string): NormalizedMap {
  const normalized = original.normalize('NFKC').toLocaleLowerCase();
  const indexToOriginal: number[] = [];
  let normCursor = 0;
  for (let i = 0; i < original.length && normCursor < normalized.length; i++) {
    const after = original.slice(0, i + 1).normalize('NFKC').toLocaleLowerCase();
    while (normCursor < after.length && normCursor < normalized.length) {
      indexToOriginal[normCursor] = i;
      normCursor++;
    }
  }
  while (normCursor < normalized.length) {
    indexToOriginal[normCursor] = Math.max(0, original.length - 1);
    normCursor++;
  }
  return { normalized, indexToOriginal };
}

function findNormalizedIndex(haystack: string, needle: string): number {
  const map = buildNormalizedMap(haystack);
  const normalizedNeedle = normalizeSearchText(needle);
  if (!normalizedNeedle) return -1;
  return map.normalized.indexOf(normalizedNeedle);
}

function sliceOriginalByNormalizedRange(
  original: string,
  startNorm: number,
  endNorm: number,
  map: NormalizedMap,
): string | null {
  if (startNorm < 0 || endNorm <= startNorm) return null;
  const startOriginal = map.indexToOriginal[startNorm];
  const endOriginal = map.indexToOriginal[endNorm - 1];
  if (startOriginal === undefined || endOriginal === undefined) return null;
  return original.slice(startOriginal, endOriginal + 1);
}

function buildMatchedSnippet(original: string, query: string): string {
  const trimmed = original.trim();
  if (!trimmed) return '';
  const map = buildNormalizedMap(trimmed);
  const needle = normalizeSearchText(query);
  if (!needle) return trimmed.slice(0, SNIPPET_MAX);
  const matchIndex = findNormalizedIndex(trimmed, query);
  if (matchIndex < 0) {
    const lower = trimmed.toLocaleLowerCase();
    const literal = lower.indexOf(needle);
    if (literal >= 0) {
      const start = Math.max(0, literal - 40);
      const end = Math.min(trimmed.length, literal + needle.length + 140);
      return trimmed.slice(start, end).slice(0, SNIPPET_MAX);
    }
    return trimmed.slice(0, SNIPPET_MAX);
  }

  const contextBefore = 60;
  const contextAfter = SNIPPET_MAX;
  const windowStart = Math.max(0, matchIndex - contextBefore);
  const windowEnd = Math.min(map.normalized.length, matchIndex + needle.length + contextAfter);

  const mapped = sliceOriginalByNormalizedRange(trimmed, windowStart, windowEnd, map);
  if (mapped && mapped.length > 0) {
    return mapped.length > SNIPPET_MAX ? mapped.slice(0, SNIPPET_MAX) : mapped;
  }

  const startOriginal = map.indexToOriginal[windowStart] ?? 0;
  const endOriginal = (map.indexToOriginal[windowEnd - 1] ?? trimmed.length - 1) + 1;
  const fallback = trimmed.slice(startOriginal, endOriginal);
  return fallback.length > SNIPPET_MAX ? fallback.slice(0, SNIPPET_MAX) : fallback;
}

function fieldMatches(field: string, query: string): boolean {
  if (!field) return false;
  return findNormalizedIndex(field, query) >= 0;
}

export function searchHistoryDocuments(
  documents: HistorySearchDocument[],
  query: string,
): { results: HistorySearchResult[]; total: number } {
  const needle = normalizeSearchText(query);
  if (!needle) return { results: [], total: 0 };

  const hits: HistorySearchResult[] = [];
  for (const document of documents) {
    const questionHit = fieldMatches(document.questionText, query);
    const answerHit = fieldMatches(document.answerText, query);
    if (!questionHit && !answerHit) continue;

    const matchSource = questionHit ? 'question' : 'answer';
    const sourceText = matchSource === 'question' ? document.questionText : document.answerText;
    hits.push({
      ...document,
      matchSource,
      matchedSnippet: buildMatchedSnippet(sourceText, query),
    });
  }

  hits.sort((left, right) => {
    if (left.matchSource !== right.matchSource) {
      return left.matchSource === 'question' ? -1 : 1;
    }
    return right.threadUpdatedAt.localeCompare(left.threadUpdatedAt);
  });

  return {
    results: hits.slice(0, MAX_HISTORY_SEARCH_RESULTS),
    total: hits.length,
  };
}
