/**
 * Task 4: parameterized skill permission matrix (pure unit — no DB).
 * SkillActor = AuthContext; never trust client-forged roles from request bodies.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthContext } from '../src/mastra/auth/auth-context.ts';
import {
  evaluateSkillPermissions,
  type SkillPermissionSnapshot,
} from '../src/mastra/skills/policy.ts';
import type { SkillActor, SkillGrantPermission, SkillVisibility } from '../src/mastra/skills/types.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

function actor(userId: string, roles: AuthContext['roles'] = ['user']): SkillActor {
  return { userId, roles };
}

function snap(overrides: {
  ownerUserId?: string;
  visibility?: SkillVisibility;
  enabled?: boolean;
  publishedVersion?: number | null;
  deletedAt?: string | null;
  grants?: SkillGrantPermission[];
  audienceUse?: boolean;
  actorActive?: boolean;
} = {}): SkillPermissionSnapshot {
  return {
    skill: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ownerUserId: overrides.ownerUserId ?? OWNER,
      visibility: overrides.visibility ?? 'private',
      enabled: overrides.enabled ?? true,
      publishedVersion: overrides.publishedVersion === undefined ? 1 : overrides.publishedVersion,
      deletedAt: overrides.deletedAt ?? null,
    },
    grants: overrides.grants ?? [],
    audienceUse: overrides.audienceUse ?? false,
    actorActive: overrides.actorActive ?? true,
  };
}

type Expect = {
  canUse: boolean;
  canViewDraft: boolean;
  canEdit: boolean;
  canPublish: boolean;
  canManage: boolean;
  canSetGlobal: boolean;
};

const cases: Array<{
  name: string;
  actor: SkillActor;
  snap: SkillPermissionSnapshot;
  expect: Expect;
}> = [
  {
    name: 'owner of private enabled published skill',
    actor: actor(OWNER),
    snap: snap(),
    expect: {
      canUse: true,
      canViewDraft: true,
      canEdit: true,
      canPublish: true,
      canManage: true,
      canSetGlobal: false,
    },
  },
  {
    name: 'admin can manage private skill but NOT auto use',
    actor: actor(ADMIN, ['admin']),
    snap: snap({ visibility: 'private' }),
    expect: {
      canUse: false,
      canViewDraft: true,
      canEdit: true,
      canPublish: true,
      canManage: true,
      canSetGlobal: true,
    },
  },
  {
    name: 'admin with explicit use grant can use',
    actor: actor(ADMIN, ['admin']),
    snap: snap({ grants: ['use'] }),
    expect: {
      canUse: true,
      canViewDraft: true,
      canEdit: true,
      canPublish: true,
      canManage: true,
      canSetGlobal: true,
    },
  },
  {
    name: 'use-only grant: runtime yes, draft/edit/publish/manage no',
    actor: actor(OTHER),
    snap: snap({ grants: ['use'] }),
    expect: {
      canUse: true,
      canViewDraft: false,
      canEdit: false,
      canPublish: false,
      canManage: false,
      canSetGlobal: false,
    },
  },
  {
    name: 'edit grant: edit+draft yes, publish NO, use NO unless also use',
    actor: actor(OTHER),
    snap: snap({ grants: ['edit'] }),
    expect: {
      canUse: false,
      canViewDraft: true,
      canEdit: true,
      canPublish: false,
      canManage: false,
      canSetGlobal: false,
    },
  },
  {
    name: 'publish grant: publish+draft yes, edit NO, use NO',
    actor: actor(OTHER),
    snap: snap({ grants: ['publish'] }),
    expect: {
      canUse: false,
      canViewDraft: true,
      canEdit: false,
      canPublish: true,
      canManage: false,
      canSetGlobal: false,
    },
  },
  {
    name: 'edit+use: can edit and use but still cannot publish',
    actor: actor(OTHER),
    snap: snap({ grants: ['edit', 'use'] }),
    expect: {
      canUse: true,
      canViewDraft: true,
      canEdit: true,
      canPublish: false,
      canManage: false,
      canSetGlobal: false,
    },
  },
  {
    name: 'global visibility: any active user can use when enabled+published',
    actor: actor(OTHER),
    snap: snap({ visibility: 'global' }),
    expect: {
      canUse: true,
      canViewDraft: false,
      canEdit: false,
      canPublish: false,
      canManage: false,
      canSetGlobal: false,
    },
  },
  {
    name: 'audience member gets use only',
    actor: actor(OTHER),
    snap: snap({ audienceUse: true }),
    expect: {
      canUse: true,
      canViewDraft: false,
      canEdit: false,
      canPublish: false,
      canManage: false,
      canSetGlobal: false,
    },
  },
  {
    name: 'unauthorized stranger: nothing',
    actor: actor(OTHER),
    snap: snap(),
    expect: {
      canUse: false,
      canViewDraft: false,
      canEdit: false,
      canPublish: false,
      canManage: false,
      canSetGlobal: false,
    },
  },
  {
    name: 'disabled user: all false even if owner',
    actor: actor(OWNER),
    snap: snap({ actorActive: false }),
    expect: {
      canUse: false,
      canViewDraft: false,
      canEdit: false,
      canPublish: false,
      canManage: false,
      canSetGlobal: false,
    },
  },
  {
    name: 'disabled skill: manage yes for owner, use no',
    actor: actor(OWNER),
    snap: snap({ enabled: false }),
    expect: {
      canUse: false,
      canViewDraft: true,
      canEdit: true,
      canPublish: true,
      canManage: true,
      canSetGlobal: false,
    },
  },
  {
    name: 'unpublished skill: use no even for owner',
    actor: actor(OWNER),
    snap: snap({ publishedVersion: null, enabled: false }),
    expect: {
      canUse: false,
      canViewDraft: true,
      canEdit: true,
      canPublish: true,
      canManage: true,
      canSetGlobal: false,
    },
  },
  {
    name: 'soft-deleted: no capabilities',
    actor: actor(OWNER),
    snap: snap({ deletedAt: '2026-10-19T00:00:00.000Z' }),
    expect: {
      canUse: false,
      canViewDraft: false,
      canEdit: false,
      canPublish: false,
      canManage: false,
      canSetGlobal: false,
    },
  },
  {
    name: 'client-forged admin role on SkillActor is what server AuthContext carries — evaluated as admin',
    actor: actor(OTHER, ['admin']),
    snap: snap(),
    expect: {
      canUse: false,
      canViewDraft: true,
      canEdit: true,
      canPublish: true,
      canManage: true,
      canSetGlobal: true,
    },
  },
];

for (const c of cases) {
  test(`policy matrix: ${c.name}`, () => {
    const caps = evaluateSkillPermissions(c.actor, c.snap);
    assert.deepEqual(caps, c.expect, c.name);
  });
}

test('SkillActor type is AuthContext-shaped (userId + roles; optional tenantId)', () => {
  const a: SkillActor = { userId: OWNER, roles: ['user'], tenantId: 't1' };
  const caps = evaluateSkillPermissions(a, snap({ ownerUserId: OWNER }));
  assert.equal(caps.canUse, true);
  assert.equal(caps.canManage, true);
});
