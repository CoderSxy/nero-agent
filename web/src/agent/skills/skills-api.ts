import { apiFetch } from '../client';
import type {
  SkillApiErrorBody,
  SkillAudienceRecord,
  SkillFileRecord,
  SkillGrantInput,
  SkillGroupRecord,
  SkillImportReport,
  SkillSyncDiff,
  SkillListPage,
  SkillManageDetail,
  SkillManageListItem,
  SkillPublishResult,
  SkillRecord,
  SkillSummary,
  SkillShortcutAvailable,
  SkillShortcutRecord,
  SkillUserPickerItem,
  ShortcutField,
  ShortcutPrompt,
  SkillVersionRecord,
  SkillVersionSummary,
  SkillVisibility,
} from './types';

export class SkillApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SkillApiError';
  }
}

function parseError(status: number, body: SkillApiErrorBody): SkillApiError {
  const err = body.error;
  if (typeof err === 'string') return new SkillApiError(status, 'ERROR', err);
  return new SkillApiError(
    status,
    err?.code || 'ERROR',
    err?.message || `请求失败 (${status})`,
  );
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as SkillApiErrorBody;
  if (!response.ok) throw parseError(response.status, body);
  return body as T;
}

function withRevisionHeaders(expectedRevision: string, headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  next.set('If-Match', `"${expectedRevision}"`);
  return next;
}

export async function listAvailableSkills(query: {
  page: number;
  pageSize: number;
  q?: string;
}, signal?: AbortSignal): Promise<SkillListPage<SkillSummary>> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.q) params.set('q', query.q);
  return readJson(await apiFetch(`/agent-skills/available?${params}`, { signal }));
}

export async function listManageableSkills(query: {
  page: number;
  pageSize: number;
  q?: string;
  groupId?: string;
}, signal?: AbortSignal): Promise<SkillListPage<SkillManageListItem>> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.q) params.set('q', query.q);
  if (query.groupId) params.set('groupId', query.groupId);
  return readJson(await apiFetch(`/agent-skills?${params}`, { signal }));
}

export async function createSkill(input: { name: string; description: string }) {
  return readJson<{ skill: SkillRecord; version: SkillVersionRecord }>(
    await apiFetch('/agent-skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function getSkillDetail(id: string): Promise<SkillManageDetail> {
  return readJson(await apiFetch(`/agent-skills/${encodeURIComponent(id)}`));
}

export async function saveDraft(id: string, input: {
  expectedRevision: string;
  skillMd: string;
  description?: string;
}) {
  return readJson<{ skill: SkillRecord; version: SkillVersionRecord }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/draft`, {
      method: 'PUT',
      headers: withRevisionHeaders(input.expectedRevision, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        expectedRevision: input.expectedRevision,
        skillMd: input.skillMd,
        ...(input.description !== undefined ? { description: input.description } : {}),
      }),
    }),
  );
}

export async function createWorkingDraft(id: string, input: {
  expectedRevision: string;
  fromVersion?: number;
}) {
  return readJson<{ skill: SkillRecord; version: SkillVersionRecord }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/drafts`, {
      method: 'POST',
      headers: withRevisionHeaders(input.expectedRevision, { 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    }),
  );
}

export async function listSkillFiles(id: string, version: number) {
  const params = new URLSearchParams({ version: String(version) });
  return readJson<{ files: SkillFileRecord[] }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/files?${params}`),
  );
}

export async function readSkillFileText(id: string, version: number, path: string) {
  const params = new URLSearchParams({ version: String(version), path });
  return readJson<{ path: string; text: string; mimeType: string | null }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/files/content?${params}`),
  );
}

export async function uploadDraftFile(id: string, input: {
  expectedRevision: string;
  path: string;
  bytes: ArrayBuffer | Blob;
  contentType?: string;
}) {
  return readJson<{ skill: SkillRecord; version: SkillVersionRecord }>(
    await apiFetch(
      `/agent-skills/${encodeURIComponent(id)}/draft/files?path=${encodeURIComponent(input.path)}`,
      {
        method: 'PUT',
        headers: withRevisionHeaders(input.expectedRevision, {
          ...(input.contentType ? { 'content-type': input.contentType } : {}),
        }),
        body: input.bytes,
      },
    ),
  );
}

export async function deleteDraftFile(id: string, input: {
  expectedRevision: string;
  path: string;
}) {
  return readJson<{ skill: SkillRecord; version: SkillVersionRecord }>(
    await apiFetch(
      `/agent-skills/${encodeURIComponent(id)}/draft/files?path=${encodeURIComponent(input.path)}`,
      {
        method: 'DELETE',
        headers: withRevisionHeaders(input.expectedRevision),
      },
    ),
  );
}

export function skillFileDownloadUrl(id: string, version: number, path: string): string {
  const params = new URLSearchParams({ version: String(version), path });
  return `/agent-skills/${encodeURIComponent(id)}/files/download?${params}`;
}

export async function downloadSkillFile(id: string, version: number, path: string): Promise<Blob> {
  const response = await apiFetch(skillFileDownloadUrl(id, version, path));
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as SkillApiErrorBody;
    throw parseError(response.status, body);
  }
  return response.blob();
}

export async function listSkillVersions(id: string) {
  return readJson<{ items: SkillVersionSummary[] }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/versions`),
  );
}

export async function publishSkill(id: string, input: {
  expectedRevision: string;
  version: number;
  remark?: string;
}): Promise<SkillPublishResult> {
  return readJson(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      headers: withRevisionHeaders(input.expectedRevision, { 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    }),
  );
}

export async function rollbackSkill(id: string, input: {
  expectedRevision: string;
  targetVersion: number;
}): Promise<SkillPublishResult> {
  return readJson(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/rollback`, {
      method: 'POST',
      headers: withRevisionHeaders(input.expectedRevision, { 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    }),
  );
}

export async function enableSkill(id: string, expectedRevision: string) {
  return readJson<{ skill: SkillRecord }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/enable`, {
      method: 'POST',
      headers: withRevisionHeaders(expectedRevision, { 'content-type': 'application/json' }),
      body: JSON.stringify({ expectedRevision }),
    }),
  );
}

export async function disableSkill(id: string, expectedRevision: string) {
  return readJson<{ skill: SkillRecord }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
      headers: withRevisionHeaders(expectedRevision, { 'content-type': 'application/json' }),
      body: JSON.stringify({ expectedRevision }),
    }),
  );
}

export async function patchSkillMetadata(id: string, input: {
  expectedRevision: string;
  visibility?: SkillVisibility;
  groupId?: string | null;
  grants?: SkillGrantInput[];
  audienceIds?: string[];
}) {
  return readJson<{ skill: SkillRecord }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: withRevisionHeaders(input.expectedRevision, { 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    }),
  );
}

export async function deleteSkill(id: string, expectedRevision: string) {
  return readJson<{ skill: SkillRecord }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: withRevisionHeaders(expectedRevision),
    }),
  );
}

export async function listSkillGroups() {
  return readJson<{ items: SkillGroupRecord[] }>(await apiFetch('/agent-skills/groups'));
}

export async function listSkillAudiences() {
  return readJson<{ items: SkillAudienceRecord[] }>(await apiFetch('/agent-skills/audiences'));
}

export async function previewSkillImport(file: Blob) {
  const body = new FormData();
  body.set('file', file, 'skill.zip');
  return readJson<{ importId: string; report: SkillImportReport }>(
    await apiFetch('/agent-skills/imports/preview', { method: 'POST', body }),
  );
}

export async function commitSkillImport(importId: string, input: {
  acceptedName: string;
  alias?: string;
  targetSkillId?: string;
  expectedRevision?: string;
}) {
  return readJson<{ skill: SkillRecord; version: SkillVersionRecord }>(
    await apiFetch(`/agent-skills/imports/${encodeURIComponent(importId)}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function previewSkillSync(id: string, file: Blob, expectedRevision: string) {
  const body = new FormData();
  body.set('file', file, 'skill.zip');
  body.set('expectedRevision', expectedRevision);
  return readJson<{ syncId: string; diff: SkillSyncDiff }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/sync/preview`, { method: 'POST', body }),
  );
}

export async function commitSkillSync(id: string, syncId: string, input: {
  expectedRevision: string;
  selectedPaths: string[];
  includeDeletes: boolean;
}) {
  return readJson<{ skill: SkillRecord; version: SkillVersionRecord }>(
    await apiFetch(`/agent-skills/${encodeURIComponent(id)}/sync/${encodeURIComponent(syncId)}/commit`, {
      method: 'POST',
      headers: withRevisionHeaders(input.expectedRevision, { 'content-type': 'application/json' }),
      body: JSON.stringify(input),
    }),
  );
}

export async function exportSkillZip(id: string, version: number): Promise<{ blob: Blob; filename: string }> {
  const response = await apiFetch(
    `/agent-skills/${encodeURIComponent(id)}/export?version=${encodeURIComponent(String(version))}`,
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as SkillApiErrorBody;
    throw parseError(response.status, body);
  }
  const blob = await response.blob();
  const match = /filename=\"([^\"]+)\"/.exec(response.headers.get('content-disposition') ?? '');
  return { blob, filename: match?.[1] || `skill-v${version}.zip` };
}

export async function listAvailableShortcuts(signal?: AbortSignal): Promise<{ items: SkillShortcutAvailable[] }> {
  return readJson(await apiFetch('/agent-skills/shortcuts/available', { signal }));
}

export async function getSkillShortcut(id: string): Promise<{ shortcut: SkillShortcutRecord | null }> {
  return readJson(await apiFetch(`/agent-skills/${encodeURIComponent(id)}/shortcut`));
}

export async function putSkillShortcut(id: string, input: {
  expectedRevision: string;
  label: string;
  enabled: boolean;
  sort: number;
  fields: ShortcutField[];
  prompts: ShortcutPrompt[];
}): Promise<{ shortcut: SkillShortcutRecord }> {
  return readJson(await apiFetch(`/agent-skills/${encodeURIComponent(id)}/shortcut`, {
    method: 'PUT',
    headers: withRevisionHeaders(input.expectedRevision, { 'content-type': 'application/json' }),
    body: JSON.stringify(input),
  }));
}

export async function searchSkillUsers(q: string) {
  const params = new URLSearchParams({ q });
  return readJson<{ items: SkillUserPickerItem[] }>(
    await apiFetch(`/agent-skills/users?${params}`),
  );
}

export async function checkSkillRuntime(skillId: string, version: number, force = false, signal?: AbortSignal): Promise<{ report: import('./types').SkillReadinessReport }> {
  return readJson(await apiFetch(`/agent-skills/${encodeURIComponent(skillId)}/runtime-check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, force }), signal,
  }));
}
