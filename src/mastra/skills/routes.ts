import { registerApiRoute } from '@mastra/core/server';
import type { Context } from 'hono';
import { trustedAuth } from '../auth/auth-context';
import { isAgentSkillsEnabled } from './config';
import { SkillPackageError, SkillRepositoryError, SkillStorageError, SkillSyncError } from './errors';
import { SkillShortcutError, validateShortcut } from './shortcuts';
import { SkillPolicyError } from './policy';
import type { SkillService } from './service';
import type { SkillGrantInput, SkillVisibility } from './types';
import { SKILL_LIMITS } from './validation';
import { getSkillRuntime } from './factory';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class SkillRouteError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SkillRouteError';
  }
}

function jsonError(c: Context, status: number, code: string, message: string) {
  return c.json({ error: { code, message } }, status as 400);
}

function respond(c: Context, error: unknown) {
  if (error instanceof SkillRouteError) {
    return jsonError(c, error.status, error.code, error.message);
  }
  if (error instanceof SkillPolicyError) {
    return jsonError(c, error.status, error.code, error.message);
  }
  if (error instanceof SkillRepositoryError) {
    return jsonError(c, error.status, error.code, error.message);
  }
  if (error instanceof SkillStorageError) {
    const status = error.code === 'BLOB_TOO_LARGE' ? 413 : error.status;
    return jsonError(c, status, error.code, error.message);
  }
  if (error instanceof SkillPackageError) {
    return jsonError(c, error.status, error.code, error.message);
  }
  if (error instanceof SkillSyncError) {
    return jsonError(c, error.status, error.code, error.message);
  }
  if (error instanceof SkillShortcutError) {
    return jsonError(c, error.status, error.code, error.message);
  }
  if (error instanceof Error && /Authentication is required/i.test(error.message)) {
    return jsonError(c, 401, 'UNAUTHENTICATED', error.message);
  }
  console.error('skill route failed', error instanceof Error ? error.name : 'unknown');
  return jsonError(c, 500, 'INTERNAL', '服务器内部错误');
}

function requireSkillsEnabled(): void {
  if (!isAgentSkillsEnabled()) {
    throw new SkillRouteError(503, 'SKILLS_DISABLED', 'Agent skills are disabled');
  }
}

function parseUuidParam(raw: string | undefined, name: string): string {
  const value = (raw ?? '').trim();
  if (!UUID_RE.test(value)) {
    throw new SkillRouteError(400, 'INVALID_INPUT', `${name} must be a UUID`);
  }
  return value;
}

function parsePage(c: Context): { page: number; pageSize: number; q?: string; groupId?: string } {
  const page = Number(c.req.query('page') ?? '1');
  const pageSize = Number(c.req.query('pageSize') ?? String(SKILL_LIMITS.PAGE_DEFAULT));
  if (!Number.isInteger(page) || page < 1) {
    throw new SkillRouteError(400, 'INVALID_INPUT', 'page 无效');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SKILL_LIMITS.PAGE_MAX) {
    throw new SkillRouteError(400, 'INVALID_INPUT', 'pageSize 无效');
  }
  const qRaw = c.req.query('q')?.trim();
  if (qRaw != null && qRaw.length > SKILL_LIMITS.SEARCH_QUERY_MAX) {
    throw new SkillRouteError(400, 'INVALID_INPUT', 'q 过长');
  }
  const groupIdRaw = c.req.query('groupId')?.trim();
  if (groupIdRaw && !UUID_RE.test(groupIdRaw)) {
    throw new SkillRouteError(400, 'INVALID_INPUT', 'groupId must be a UUID');
  }
  return {
    page,
    pageSize,
    ...(qRaw ? { q: qRaw } : {}),
    ...(groupIdRaw ? { groupId: groupIdRaw } : {}),
  };
}

function parseExpectedRevision(c: Context, body?: Record<string, unknown>): string {
  const fromBody = body?.expectedRevision;
  const ifMatch = c.req.header('if-match')?.trim();
  const candidates = [
    typeof fromBody === 'string' ? fromBody.trim() : '',
    ifMatch?.replace(/^W\//, '').replace(/^"|"$/g, '') ?? '',
  ].filter(Boolean);
  if (candidates.length === 0) {
    throw new SkillRouteError(400, 'INVALID_INPUT', 'expectedRevision or If-Match required');
  }
  if (candidates.length === 2 && candidates[0] !== candidates[1]) {
    throw new SkillRouteError(400, 'INVALID_INPUT', 'If-Match and expectedRevision mismatch');
  }
  const revision = candidates[0]!;
  if (!/^\d+$/.test(revision)) {
    throw new SkillRouteError(400, 'INVALID_INPUT', 'revision must be a decimal string');
  }
  return revision;
}

async function readLimitedBytes(c: Context, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = c.req.header('content-length');
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new SkillRouteError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
    }
  }
  const stream = c.req.raw.body;
  if (!stream) throw new SkillRouteError(400, 'INVALID_INPUT', '缺少请求体');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SkillRouteError(413, 'PAYLOAD_TOO_LARGE', '请求体过大');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function readJsonObject(c: Context): Promise<Record<string, unknown>> {
  const bytes = await readLimitedBytes(c, SKILL_LIMITS.JSON_MAX_BYTES);
  if (bytes.byteLength === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new SkillRouteError(400, 'INVALID_INPUT', '请求格式无效');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillRouteError(400, 'INVALID_INPUT', '请求格式无效');
  }
  return parsed as Record<string, unknown>;
}

function contentDisposition(filename: string): string {
  const base = filename.replace(/[/\\]/g, '').replace(/[\r\n"]/g, '') || 'download';
  const ascii = base.replace(/[^\x20-\x7E]/g, '_').slice(0, 180) || 'download';
  const encoded = encodeURIComponent(base);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function downloadResponse(bytes: Uint8Array, filename: string, contentType?: string | null) {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      'content-type': contentType || 'application/octet-stream',
      'content-disposition': contentDisposition(filename),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}

function parseGrants(raw: unknown): SkillGrantInput[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new SkillRouteError(400, 'INVALID_INPUT', 'grants must be an array');
  }
  return raw.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new SkillRouteError(400, 'INVALID_INPUT', 'grant invalid');
    }
    const row = item as { userId?: unknown; permission?: unknown };
    if (typeof row.userId !== 'string' || !UUID_RE.test(row.userId)) {
      throw new SkillRouteError(400, 'INVALID_INPUT', 'grant.userId must be a UUID');
    }
    if (row.permission !== 'use' && row.permission !== 'edit' && row.permission !== 'publish') {
      throw new SkillRouteError(400, 'INVALID_INPUT', 'grant.permission invalid');
    }
    return { userId: row.userId, permission: row.permission };
  });
}

function parseAudienceIds(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new SkillRouteError(400, 'INVALID_INPUT', 'audienceIds must be an array');
  }
  return raw.map((id) => {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new SkillRouteError(400, 'INVALID_INPUT', 'audienceId must be a UUID');
    }
    return id;
  });
}

function guarded(
  resolveService: (c: Context) => SkillService,
  run: (c: Context, service: SkillService) => Promise<Response>,
) {
  return async (c: Context) => {
    try {
      requireSkillsEnabled();
      trustedAuth(c.get('requestContext'));
      return await run(c, resolveService(c));
    } catch (error) {
      return respond(c, error);
    }
  };
}

export function createSkillRoutes(resolveService: (c: Context) => SkillService) {
  const base = '/agent-skills';
  const g = (run: (c: Context, service: SkillService) => Promise<Response>) =>
    guarded(resolveService, run);

  return [
    // Static paths before /:id
    registerApiRoute(`${base}/available`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        return c.json(await service.listAvailable(actor, parsePage(c)));
      }),
    }),
    registerApiRoute(`${base}/shortcuts/available`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        return c.json(await service.listAvailableShortcuts(actor));
      }),
    }),
    registerApiRoute(`${base}/groups`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        return c.json({ items: await service.listGroups(actor) });
      }),
    }),
    registerApiRoute(`${base}/groups`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const body = await readJsonObject(c);
        const name = typeof body.name === 'string' ? body.name : '';
        const sort = typeof body.sort === 'number' ? body.sort : undefined;
        return c.json({ group: await service.createGroup(actor, { name, sort }) }, 201);
      }),
    }),
    registerApiRoute(`${base}/groups/:id`, {
      method: 'PATCH',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const id = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        return c.json({
          group: await service.updateGroup(actor, {
            id,
            name: typeof body.name === 'string' ? body.name : undefined,
            sort: typeof body.sort === 'number' ? body.sort : undefined,
          }),
        });
      }),
    }),
    registerApiRoute(`${base}/groups/:id`, {
      method: 'DELETE',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        await service.deleteGroup(actor, parseUuidParam(c.req.param('id'), 'id'));
        return c.json({ ok: true });
      }),
    }),
    registerApiRoute(`${base}/audiences`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        return c.json({ items: await service.listAudiences(actor) });
      }),
    }),
    registerApiRoute(`${base}/audiences`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const body = await readJsonObject(c);
        const name = typeof body.name === 'string' ? body.name : '';
        const memberIds = parseAudienceIds(body.memberIds) ?? [];
        return c.json({ audience: await service.createAudience(actor, { name, memberIds }) }, 201);
      }),
    }),
    registerApiRoute(`${base}/audiences/:id`, {
      method: 'PATCH',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const id = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        return c.json({
          audience: await service.updateAudience(actor, {
            id,
            name: typeof body.name === 'string' ? body.name : undefined,
            memberIds: parseAudienceIds(body.memberIds),
          }),
        });
      }),
    }),
    registerApiRoute(`${base}/audiences/:id`, {
      method: 'DELETE',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        await service.deleteAudience(actor, parseUuidParam(c.req.param('id'), 'id'));
        return c.json({ ok: true });
      }),
    }),
    registerApiRoute(`${base}/imports/preview`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const upload = await readZipUpload(c);
        const result = await service.previewImport(actor, upload.stream);
        return c.json(result);
      }),
    }),
    registerApiRoute(`${base}/imports/:importId/commit`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const importId = parseUuidParam(c.req.param('importId'), 'importId');
        const body = await readJsonObject(c);
        const acceptedName = typeof body.acceptedName === 'string' ? body.acceptedName : '';
        const alias = body.alias == null ? undefined : typeof body.alias === 'string' ? body.alias : '';
        if (body.alias != null && typeof body.alias !== 'string') {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'alias invalid');
        }
        const targetSkillId = body.targetSkillId == null
          ? undefined
          : parseUuidParam(String(body.targetSkillId), 'targetSkillId');
        const expectedRevision = body.expectedRevision == null
          ? undefined
          : parseExpectedRevision(c, body);
        const result = await service.commitImport(actor, {
          importId,
          acceptedName,
          alias,
          targetSkillId,
          expectedRevision,
        });
        return c.json(result, 201);
      }),
    }),
    registerApiRoute(`${base}/users`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const q = c.req.query('q') ?? '';
        return c.json({ items: await service.searchUsers(actor, q) });
      }),
    }),

    registerApiRoute(base, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        return c.json(await service.listManageable(actor, parsePage(c)));
      }),
    }),
    registerApiRoute(base, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const body = await readJsonObject(c);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const description = typeof body.description === 'string' ? body.description.trim() : '';
        if (!name || !description) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'name and description required');
        }
        const created = await service.createDraft(actor, { name, description });
        return c.json({ skill: created.skill, version: created.version }, 201);
      }),
    }),

    registerApiRoute(`${base}/:id/draft`, {
      method: 'PUT',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        const expectedRevision = parseExpectedRevision(c, body);
        const skillMd = typeof body.skillMd === 'string' ? body.skillMd : undefined;
        if (skillMd == null) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'skillMd required');
        }
        const result = await service.saveDraft(actor, { skillId, expectedRevision, skillMd });
        return c.json({ skill: result.skill, version: result.version });
      }),
    }),
    registerApiRoute(`${base}/:id/drafts`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        const expectedRevision = parseExpectedRevision(c, body);
        const fromVersion = typeof body.fromVersion === 'number' ? body.fromVersion : undefined;
        const result = await service.createWorkingDraft(actor, {
          skillId,
          expectedRevision,
          fromVersion,
        });
        return c.json({ skill: result.skill, version: result.version }, 201);
      }),
    }),
    registerApiRoute(`${base}/:id/draft/files`, {
      method: 'PUT',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const path = c.req.query('path')?.trim() ?? '';
        if (!path) throw new SkillRouteError(400, 'INVALID_INPUT', 'path required');
        const expectedRevision = parseExpectedRevision(c);
        const bytes = await readLimitedBytes(c, SKILL_LIMITS.FILE_MAX_BYTES);
        const result = await service.saveFile(actor, {
          skillId,
          expectedRevision,
          path,
          bytes,
          mimeType: c.req.header('content-type') ?? null,
        });
        return c.json({ skill: result.skill, version: result.version });
      }),
    }),
    registerApiRoute(`${base}/:id/draft/files`, {
      method: 'DELETE',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const path = c.req.query('path')?.trim() ?? '';
        if (!path) throw new SkillRouteError(400, 'INVALID_INPUT', 'path required');
        const expectedRevision = parseExpectedRevision(c);
        const result = await service.deleteDraftFile(actor, { skillId, expectedRevision, path });
        return c.json({ skill: result.skill, version: result.version });
      }),
    }),
    registerApiRoute(`${base}/:id/files`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const version = Number(c.req.query('version'));
        if (!Number.isInteger(version) || version < 1) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'version required');
        }
        return c.json({ files: await service.listFiles(actor, skillId, version) });
      }),
    }),
    registerApiRoute(`${base}/:id/files/content`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const version = Number(c.req.query('version'));
        const path = c.req.query('path')?.trim() ?? '';
        if (!Number.isInteger(version) || version < 1 || !path) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'version and path required');
        }
        const file = await service.readFileContent(actor, skillId, version, path);
        if (!file.isText) {
          throw new SkillRouteError(422, 'RESOURCE_BINARY', 'Use download endpoint for binary files');
        }
        return c.json({
          path: file.path,
          text: new TextDecoder('utf-8', { fatal: false }).decode(file.bytes),
          mimeType: file.mimeType,
        });
      }),
    }),
    registerApiRoute(`${base}/:id/files/download`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const version = Number(c.req.query('version'));
        const path = c.req.query('path')?.trim() ?? '';
        if (!Number.isInteger(version) || version < 1 || !path) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'version and path required');
        }
        const file = await service.downloadFile(actor, skillId, version, path);
        const name = path.split('/').pop() || 'download';
        return downloadResponse(file.bytes, name, file.mimeType);
      }),
    }),
    registerApiRoute(`${base}/:id/health`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const raw = c.req.query('version');
        const version = raw == null || raw === '' ? undefined : Number(raw);
        if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'version invalid');
        }
        return c.json(await service.getSkillHealth(actor, skillId, version));
      }),
    }),
    registerApiRoute(`${base}/:id/health/recheck`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        if (typeof body.repair !== 'boolean') {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'repair required');
        }
        const version = body.version == null ? undefined : Number(body.version);
        if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'version invalid');
        }
        const result = await service.recheckSkillHealth(actor, { skillId, version, repair: body.repair });
        return c.json(result, result.status === 'checking' ? 202 : 200);
      }),
    }),
    registerApiRoute(`${base}/:id/versions`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        return c.json({ items: await service.listVersions(actor, skillId) });
      }),
    }),
    registerApiRoute(`${base}/:id/versions/:version`, {
      method: 'DELETE',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const version = Number(c.req.param('version'));
        if (!Number.isInteger(version) || version < 1) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'version invalid');
        }
        const expectedRevision = parseExpectedRevision(c);
        const skill = await service.deleteVersion(actor, { skillId, version, expectedRevision });
        return c.json({ skill });
      }),
    }),
    registerApiRoute(`${base}/:id/runtime-check`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        const version = body.version;
        if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new SkillRouteError(400, 'INVALID_INPUT', 'version invalid');
        return c.json({ report: await service.checkRuntime(actor, skillId, version, body.force === true) });
      }),
    }),
    registerApiRoute(`${base}/:id/publish`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        const expectedRevision = parseExpectedRevision(c, body);
        const version = Number(body.version);
        if (!Number.isInteger(version) || version < 1) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'version required');
        }
        const remark = typeof body.remark === 'string' ? body.remark : undefined;
        return c.json(await service.publish(actor, { skillId, version, expectedRevision, remark }));
      }),
    }),
    registerApiRoute(`${base}/:id/rollback`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        const expectedRevision = parseExpectedRevision(c, body);
        const targetVersion = Number(body.targetVersion);
        if (!Number.isInteger(targetVersion) || targetVersion < 1) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'targetVersion required');
        }
        return c.json(await service.rollback(actor, { skillId, targetVersion, expectedRevision }));
      }),
    }),
    registerApiRoute(`${base}/:id/enable`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        const expectedRevision = parseExpectedRevision(c, body);
        const skill = await service.setEnabled(actor, { skillId, expectedRevision, enabled: true });
        return c.json({ skill });
      }),
    }),
    registerApiRoute(`${base}/:id/disable`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        const expectedRevision = parseExpectedRevision(c, body);
        const skill = await service.setEnabled(actor, { skillId, expectedRevision, enabled: false });
        return c.json({ skill });
      }),
    }),
    registerApiRoute(`${base}/:id/events`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        return c.json(await service.listEvents(actor, { skillId, ...parsePage(c) }));
      }),
    }),
    registerApiRoute(`${base}/:id/sync/preview`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const upload = await readZipUpload(c);
        const expectedRevision = upload.fields.expectedRevision
          ? parseExpectedRevision(c, { expectedRevision: upload.fields.expectedRevision })
          : parseExpectedRevision(c);
        const result = await service.previewSync(actor, {
          skillId,
          expectedRevision,
          stream: upload.stream,
        });
        return c.json(result);
      }),
    }),
    registerApiRoute(`${base}/:id/sync/:syncId/commit`, {
      method: 'POST',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const syncId = parseUuidParam(c.req.param('syncId'), 'syncId');
        const body = await readJsonObject(c);
        const expectedRevision = parseExpectedRevision(c, body);
        if (!Array.isArray(body.selectedPaths) || body.selectedPaths.some((path) => typeof path !== 'string')) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'selectedPaths must be a string array');
        }
        if (typeof body.includeDeletes !== 'boolean') {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'includeDeletes must be boolean');
        }
        const result = await service.commitSync(actor, {
          skillId,
          syncId,
          expectedRevision,
          selectedPaths: body.selectedPaths as string[],
          includeDeletes: body.includeDeletes,
        });
        return c.json(result);
      }),
    }),
    registerApiRoute(`${base}/:id/shortcut`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        return c.json(await service.getShortcut(actor, skillId));
      }),
    }),
    registerApiRoute(`${base}/:id/shortcut`, {
      method: 'PUT',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        const allowed = new Set(['expectedRevision', 'label', 'enabled', 'sort', 'fields', 'prompts']);
        for (const key of Object.keys(body)) {
          if (!allowed.has(key)) {
            throw new SkillRouteError(400, 'INVALID_INPUT', `快捷配置包含未知字段 ${key}`);
          }
        }
        const expectedRevision = parseExpectedRevision(c, body);
        const config = validateShortcut({
          label: body.label,
          enabled: body.enabled,
          sort: body.sort,
          fields: body.fields,
          prompts: body.prompts,
        });
        return c.json(await service.putShortcut(actor, { skillId, expectedRevision, config }));
      }),
    }),
    registerApiRoute(`${base}/:id/export`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const version = Number(c.req.query('version'));
        if (!Number.isInteger(version) || version < 1) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'version required');
        }
        const exported = await service.exportZip(actor, skillId, version);
        return downloadResponse(exported.bytes, exported.filename, 'application/zip');
      }),
    }),
    registerApiRoute(`${base}/:id`, {
      method: 'GET',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const id = parseUuidParam(c.req.param('id'), 'id');
        return c.json(await service.getManageDetail(actor, id));
      }),
    }),
    registerApiRoute(`${base}/:id`, {
      method: 'PATCH',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const body = await readJsonObject(c);
        const expectedRevision = parseExpectedRevision(c, body);
        const visibility = body.visibility as SkillVisibility | undefined;
        if (
          visibility !== undefined
          && visibility !== 'private'
          && visibility !== 'global'
          && visibility !== 'restricted'
        ) {
          throw new SkillRouteError(400, 'INVALID_INPUT', 'visibility invalid');
        }
        let groupId: string | null | undefined;
        if (body.groupId === null) groupId = null;
        else if (typeof body.groupId === 'string') {
          groupId = parseUuidParam(body.groupId, 'groupId');
        }
        const skill = await service.setMetadata(actor, {
          skillId,
          expectedRevision,
          visibility,
          groupId,
          grants: parseGrants(body.grants),
          audienceIds: parseAudienceIds(body.audienceIds),
        });
        return c.json({ skill });
      }),
    }),
    registerApiRoute(`${base}/:id`, {
      method: 'DELETE',
      handler: g(async (c, service) => {
        const actor = trustedAuth(c.get('requestContext'));
        const skillId = parseUuidParam(c.req.param('id'), 'id');
        const expectedRevision = parseExpectedRevision(c);
        const skill = await service.deleteSkill(actor, { skillId, expectedRevision });
        return c.json({ skill });
      }),
    }),
  ];
}

async function readZipUpload(c: Context): Promise<{
  stream: ReadableStream<Uint8Array>;
  fields: Record<string, string>;
}> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const fields: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') fields[key] = value;
    }
    const file = form.get('file') ?? form.get('zip');
    if (!(file instanceof File)) {
      throw new SkillRouteError(400, 'INVALID_INPUT', 'ZIP file is required');
    }
    if (file.size > SKILL_LIMITS.ZIP_MAX_BYTES) {
      throw new SkillRouteError(413, 'PAYLOAD_TOO_LARGE', 'ZIP exceeds limit');
    }
    return { stream: file.stream(), fields };
  }
  const lengthHeader = c.req.header('content-length');
  if (lengthHeader && Number(lengthHeader) > SKILL_LIMITS.ZIP_MAX_BYTES) {
    throw new SkillRouteError(413, 'PAYLOAD_TOO_LARGE', 'ZIP exceeds limit');
  }
  const stream = c.req.raw.body;
  if (!stream) throw new SkillRouteError(400, 'INVALID_INPUT', '缺少请求体');
  return { stream, fields: {} };
}

function serviceFromContext(_c: Context): SkillService {
  return getSkillRuntime().service;
}

export const skillRoutes = createSkillRoutes(serviceFromContext);
