import type { MastraDBMessage } from '@mastra/core/agent/message-list';

function isArtifactPathLike(path: string): boolean {
  if (!path || path.includes('\0') || path.includes('\\') || path.startsWith('/')) return false;
  const segments = path.split('/');
  return segments.length > 0 && segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

export type ArtifactRunState =
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type ArtifactCollectionStatus = 'complete' | 'partial';

export type WorkspaceArtifact = {
  path: string;
  source: 'personal';
  name: string;
  change: 'created' | 'updated';
  size: number;
  etag: string;
};

export type TurnArtifacts = {
  version: 1;
  runId: string;
  threadId: string;
  revision: number;
  state: ArtifactRunState;
  collectionStatus: ArtifactCollectionStatus;
  anchorMessageId: string | null;
  artifacts: WorkspaceArtifact[];
};

export type WorkspaceRevealRequest = {
  id: number;
  path: string;
  source: 'personal' | 'agent';
  threadId: string;
};

const TERMINAL = new Set<ArtifactRunState>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

export function isTerminalArtifactState(state: ArtifactRunState): boolean {
  return TERMINAL.has(state);
}

export function parseTurnArtifacts(value: unknown): TurnArtifacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return null;
  if (typeof raw.runId !== 'string' || !raw.runId) return null;
  if (typeof raw.threadId !== 'string' || !raw.threadId) return null;
  if (typeof raw.revision !== 'number' || !Number.isFinite(raw.revision) || raw.revision < 1) return null;
  if (!isState(raw.state)) return null;
  if (raw.collectionStatus !== 'complete' && raw.collectionStatus !== 'partial') return null;
  if (!(raw.anchorMessageId === null || typeof raw.anchorMessageId === 'string')) return null;
  if (!Array.isArray(raw.artifacts)) return null;
  const artifacts: WorkspaceArtifact[] = [];
  for (const item of raw.artifacts) {
    const file = parseArtifact(item);
    if (!file) return null;
    artifacts.push(file);
  }
  return {
    version: 1,
    runId: raw.runId,
    threadId: raw.threadId,
    revision: raw.revision,
    state: raw.state,
    collectionStatus: raw.collectionStatus,
    anchorMessageId: raw.anchorMessageId,
    artifacts,
  };
}

function isState(value: unknown): value is ArtifactRunState {
  return value === 'running'
    || value === 'suspended'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'interrupted';
}

function parseArtifact(value: unknown): WorkspaceArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.path !== 'string' || !isArtifactPathLike(raw.path)) return null;
  if (raw.source !== 'personal') return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  if (raw.change !== 'created' && raw.change !== 'updated') return null;
  if (typeof raw.size !== 'number' || !Number.isFinite(raw.size) || raw.size < 0) return null;
  if (typeof raw.etag !== 'string' || !/^"[a-f0-9]{64}"$/.test(raw.etag)) return null;
  return {
    path: raw.path,
    source: 'personal',
    name: raw.name,
    change: raw.change,
    size: raw.size,
    etag: raw.etag,
  };
}

export function mergeTurnArtifacts(
  current: TurnArtifacts | undefined,
  next: TurnArtifacts,
): TurnArtifacts {
  if (!current) return next;
  if (current.runId !== next.runId) return next;
  if (next.revision < current.revision) return current;
  if (next.revision === current.revision) return current;
  if (isTerminalArtifactState(current.state) && !isTerminalArtifactState(next.state)) return current;
  return next;
}

export function readArtifactRunRef(
  message: MastraDBMessage,
): { runId: string; threadId: string } | null {
  const content = message.content;
  if (typeof content === 'string') return null;
  const meta = content.metadata?.neroArtifactRun as { version?: unknown; runId?: unknown; threadId?: unknown } | undefined;
  if (!meta || meta.version !== 1) return null;
  if (typeof meta.runId !== 'string' || !meta.runId) return null;
  if (typeof meta.threadId !== 'string' || !meta.threadId) return null;
  return { runId: meta.runId, threadId: meta.threadId };
}

export function readArtifactsFromMessageParts(message: MastraDBMessage): TurnArtifacts | null {
  const content = message.content;
  if (typeof content === 'string') return null;
  const parts = content.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] as { type?: string; data?: unknown };
    if (part?.type === 'data-nero-artifacts') {
      return parseTurnArtifacts(part.data);
    }
  }
  return null;
}


/** Run association from server metadata or the actual transport, never assistant prose. */
export function readArtifactRunId(message: MastraDBMessage): string | null {
  if (message.role !== 'assistant') return null;
  const ref = readArtifactRunRef(message);
  if (ref) return ref.runId;
  const fromPart = readArtifactsFromMessageParts(message);
  if (fromPart) return fromPart.runId;
  const metadata = typeof message.content === 'string' ? undefined : message.content.metadata;
  return metadata?.mode === 'stream' && typeof metadata.runId === 'string' && metadata.runId.trim()
    ? metadata.runId : null;
}
