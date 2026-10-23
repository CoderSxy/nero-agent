/**
 * Admin offline skill import CLI (Task 5 / A gate).
 *
 * Host-permissioned ops command — NOT an HTTP endpoint. Actor must be a valid admin.
 * Default: draft only. Explicit --publish --enable required for release + enable.
 *
 * Usage:
 *   node --env-file-if-exists=.env --import tsx scripts/skills-import.ts \
 *     --actor-user-id <uuid> --file <zip> [--publish] [--enable] [--global] [--name <canonical>] [--alias <alias>]
 */
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getPool } from '../src/mastra/auth/db.ts';
import { withSkillStorageReadLock } from '../src/mastra/skills/storage-lock';
import { getActiveUserById } from '../src/mastra/auth/service.ts';
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { getSkillsStorageRoot } from '../src/mastra/skills/config.ts';
import { previewSkillZip } from '../src/mastra/skills/package.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';
import { createSkillRepository } from '../src/mastra/skills/repository.ts';
import { createSkillService } from '../src/mastra/skills/service.ts';
import type { SkillActor, SkillFileInput } from '../src/mastra/skills/types.ts';
import { isCanonicalSkillName, SKILL_LIMITS } from '../src/mastra/skills/validation.ts';
import { createSkillVersionService, publishSkill } from '../src/mastra/skills/versions.ts';

type Args = {
  actorUserId: string;
  file: string;
  publish: boolean;
  enable: boolean;
  name?: string;
  alias?: string;
  global: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { publish: false, enable: false, global: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--actor-user-id') out.actorUserId = argv[++i];
    else if (arg === '--file') out.file = argv[++i];
    else if (arg === '--publish') out.publish = true;
    else if (arg === '--enable') out.enable = true;
    else if (arg === '--global') out.global = true;
    else if (arg === '--name') out.name = argv[++i];
    else if (arg === '--alias') out.alias = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: skills-import --actor-user-id <uuid> --file <zip> [--publish] [--enable] [--global] [--name] [--alias]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!out.actorUserId || !out.file) {
    throw new Error('Required: --actor-user-id <uuid> --file <zip>');
  }
  if (out.enable && !out.publish) {
    throw new Error('--enable requires --publish');
  }
  return out as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getPool();

  try {
    await withSkillStorageReadLock(pool, async () => {
    const actorUser = await getActiveUserById(args.actorUserId);
    if (!actorUser || !actorUser.roles.includes('admin')) {
      throw new Error('Actor must be an active admin user');
    }
    const actor: SkillActor = { userId: actorUser.id, roles: actorUser.roles };

    const zipBytes = await readFile(args.file);
    if (zipBytes.byteLength > SKILL_LIMITS.ZIP_MAX_BYTES) {
      throw new Error('ZIP exceeds size limit');
    }

    const stream = Readable.toWeb(Readable.from([zipBytes])) as ReadableStream<Uint8Array>;
    const preview = await previewSkillZip(stream);
    const parsed = preview.package;

    const canonicalName = args.name?.trim() || parsed.canonicalName || parsed.suggestedCanonicalName;
    if (!canonicalName || !isCanonicalSkillName(canonicalName)) {
      throw new Error(
        `Canonical name required (pass --name). suggested=${parsed.suggestedCanonicalName} source=${parsed.sourceName}`,
      );
    }
    if (parsed.requiresNameAcceptance && !args.name) {
      throw new Error(
        `Non-canonical source name requires explicit --name acceptance (suggested: ${parsed.suggestedCanonicalName})`,
      );
    }

    const storageRoot = getSkillsStorageRoot();
    const repository = createSkillRepository(pool);
    const blobStore = createBlobStore({ root: storageRoot });
    const releaseStore = createReleaseStore({ root: storageRoot, blobStore });
    const versionService = createSkillVersionService({
      repository,
      blobStore,
      releaseStore,
      pool,
    });
    const service = createSkillService({
      repository,
      blobStore,
      releaseStore,
      versionService,
      pool,
    });

    const files: SkillFileInput[] = [];
    for (const resource of parsed.resources) {
      const put = await blobStore.put(
        Readable.from([Buffer.from(resource.bytes)]),
        SKILL_LIMITS.FILE_MAX_BYTES,
      );
      files.push({
        path: resource.path,
        blobHash: put.hash,
        size: put.size,
        isText: resource.isText,
      });
    }

    const created = await repository.createDraft({
      ownerUserId: actor.userId,
      actorUserId: actor.userId,
      canonicalName,
      description: parsed.description || `Imported ${canonicalName}`,
      skillMd: parsed.skillMd,
      alias: args.alias ?? null,
      runtimeManifest: parsed.runtimeManifest,
      files,
    });

    console.log(JSON.stringify({
      phase: 'draft',
      skillId: created.skill.id,
      name: created.skill.canonicalName,
      version: created.version.version,
      revision: created.skill.revision,
      enabled: created.skill.enabled,
      publishedVersion: created.skill.publishedVersion,
    }));

    let currentSkill = created.skill;
    if (args.global) {
      currentSkill = await service.setMetadata(actor, {
        skillId: currentSkill.id,
        expectedRevision: currentSkill.revision,
        visibility: 'global',
      });
      console.log(JSON.stringify({ phase: 'visibility', skillId: currentSkill.id, visibility: currentSkill.visibility }));
    }

    if (!args.publish) {
      console.log('Draft only (pass --publish [--enable] to release).');
      return;
    }

    const published = await publishSkill(versionService, actor, {
      skillId: created.skill.id,
      version: created.version.version,
      expectedRevision: currentSkill.revision,
      remark: 'skills-import CLI',
    });
    console.log(JSON.stringify({
      phase: 'publish',
      skillId: published.skill.id,
      version: published.version.version,
      manifestHash: published.manifestHash,
      enabled: published.skill.enabled,
      revision: published.skill.revision,
    }));

    if (args.enable) {
      const enabled = await service.setEnabled(actor, {
        skillId: published.skill.id,
        expectedRevision: published.skill.revision,
        enabled: true,
      });
      console.log(JSON.stringify({
        phase: 'enable',
        skillId: enabled.id,
        enabled: enabled.enabled,
        revision: enabled.revision,
      }));
    }
    });
  } finally {
    await pool.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
