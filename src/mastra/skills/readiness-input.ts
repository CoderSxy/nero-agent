import type { BlobStore } from './blob-store';
import type { SkillFileRecord, SkillRuntimeManifest } from './types';
import { parseRuntimeManifest } from './package';
import { SKILL_LIMITS } from './validation';
export async function readRuntimeFromFiles(files: SkillFileRecord[], blobs: BlobStore): Promise<SkillRuntimeManifest | null> {
  const file = files.find(file => file.path === 'skill-runtime.json');
  if (!file) return null;
  if (file.size > SKILL_LIMITS.JSON_MAX_BYTES) throw new Error('运行声明过大');
  const chunks: Buffer[] = [];
  for await (const chunk of await blobs.openVerified(file.blobHash)) chunks.push(Buffer.from(chunk));
  return parseRuntimeManifest(Buffer.concat(chunks));
}
