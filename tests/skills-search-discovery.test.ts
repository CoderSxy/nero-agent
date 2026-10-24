import assert from 'node:assert/strict';
import test from 'node:test';
import { createSkillService, type SkillServiceDeps } from '../src/mastra/skills/service.ts';
import type { SkillExecutionContext, SkillRecord, SkillVersionRecord } from '../src/mastra/skills/types.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';

function fixture({ allowed = true, active = true } = {}) {
  const skill = { id, canonicalName: 'ppt', ownerUserId: owner,
    enabled: true, publishedVersion: 1, visibility: 'private', deletedAt: null } as SkillRecord;
  const version = { skillId: id, version: 1, state: 'published', manifestHash: 'a'.repeat(64),
    skillMd: '---\nname: ppt\ndescription: 生成或编辑PPT\n---\n\n# Presentation workflow\n\nCreate SVG pages.\n\nExport to PPTX with scripts/svg_to_pptx.py.',
  } as SkillVersionRecord;
  let pins = 0;
  const service = createSkillService({
    isActorActive: async () => active,
    repository: {
      listAvailable: async () => ({ items: [skill], total: 1, page: 1, pageSize: 100 }),
      resolveByName: async (name: string) => name === 'ppt' ? { skill } : null,
      getAccessSnapshot: async () => ({ skill: { ...skill, ownerUserId: allowed ? owner : 'other' }, grants: [], audienceUse: false }),
      getVersion: async () => version,
      listFiles: async () => [],
      upsertRunPin: async (input: { userId: string; threadId: string; pin: object }) => {
        pins++;
        return { ...input.pin, userId: input.userId, threadId: input.threadId };
      },
    } as unknown as SkillServiceDeps['repository'],
    blobStore: {} as SkillServiceDeps['blobStore'],
    releaseStore: {} as SkillServiceDeps['releaseStore'],
    versionService: {} as SkillServiceDeps['versionService'],
  });
  const ctx: SkillExecutionContext = { auth: { userId: owner, roles: ['user'] },
    serverExecutionId: 'search-run', threadId: 'search-thread', pins: new Map() };
  return { service, ctx, pinCount: () => pins };
}

test('skill discovery accepts the production multi-keyword query and returns the canonical name', async () => {
  const { service, ctx } = fixture();
  const result = await service.search(ctx, { query: 'ppt pptx 演示文稿 presentation 幻灯片' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.hits[0]?.pin.name, 'ppt');
  assert.match(result.data.hits[0]?.snippet ?? '', /ppt/i);
});

test('multi-keyword snippets start at a matching line instead of the beginning of the document', async () => {
  const { service, ctx } = fixture();
  const result = await service.search(ctx, { query: 'missing PPTX' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.data.hits[0]?.snippet ?? '', /Export to PPTX/);
  assert.equal(result.data.hits[0]?.lineRange.start, 10);
});

test('case insensitive single-keyword search and no-match behavior remain supported', async () => {
  const { service, ctx } = fixture();
  const found = await service.search(ctx, { query: 'PRESENTATION' });
  assert.equal(found.ok && found.data.hits[0]?.pin.name, 'ppt');
  const missing = await service.search(ctx, { query: 'unmatchedword' });
  assert.equal(missing.ok && missing.data.hits.length, 0);
});

test('multi-keyword discovery does not expose or pin inaccessible skills or inactive accounts', async () => {
  for (const options of [{ allowed: false }, { active: false }]) {
    const fx = fixture(options);
    const result = await fx.service.search(fx.ctx, { query: 'ppt pptx' });
    assert.equal(result.ok && result.data.hits.length, 0);
    assert.equal(fx.pinCount(), 0);
  }
});
