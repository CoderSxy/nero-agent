export type ArtifactRunState =
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type ArtifactCollectionStatus = 'complete' | 'partial';

export type FileFingerprint = {
  etag: string;
  size: number;
  dev: string;
  ino: string;
  mtimeNs: string;
  ctimeNs: string;
};

export type WorkspaceSnapshot = {
  files: Map<string, FileFingerprint>;
  confirmedMissing: ReadonlySet<string>;
  status: ArtifactCollectionStatus;
};

export type ArtifactMutation = {
  path: string;
  before: FileFingerprint | null;
  after: FileFingerprint | null;
};

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

export type ArtifactRunIdentity = {
  userId: string;
  threadId: string;
  runId: string;
};
