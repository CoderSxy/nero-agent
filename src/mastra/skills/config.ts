import { resolve } from 'node:path';

const DEFAULT_IMPORT_TTL_MS = 30 * 60 * 1000;

export function getSkillsImportTempRoot(): string {
  const configured = process.env.SKILLS_IMPORT_TEMP_ROOT?.trim();
  if (!configured) {
    throw new Error('SKILLS_IMPORT_TEMP_ROOT is required for skill import preview temp storage');
  }
  if (configured.includes('\0')) {
    throw new Error('SKILLS_IMPORT_TEMP_ROOT is invalid');
  }
  return resolve(configured);
}

/**
 * Immutable skill blob/release root. Must be explicit admin config — never a user workspace.
 * Layout: `<root>/blobs/<sha256>`, `<root>/releases/<skillId>/<version>/<manifestHash>/`.
 */
export function getSkillsStorageRoot(): string {
  const configured = process.env.SKILLS_STORAGE_ROOT?.trim();
  if (!configured) {
    throw new Error('SKILLS_STORAGE_ROOT is required for skill content-addressed storage');
  }
  if (configured.includes('\0')) {
    throw new Error('SKILLS_STORAGE_ROOT is invalid');
  }
  return resolve(configured);
}

export function getSkillsImportTtlMs(): number {
  const raw = process.env.SKILLS_IMPORT_TTL_MS?.trim();
  if (!raw) return DEFAULT_IMPORT_TTL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IMPORT_TTL_MS;
  return value;
}

export function isAgentSkillsEnabled(): boolean {
  return process.env.AGENT_SKILLS_ENABLED === 'true';
}

/**
 * Script execution requires the skills master switch, the script switch, and the
 * same sandbox gates as `sandboxTools()` (commands + docker provider + quota + file write).
 */
export function isSkillScriptExecutionEnabled(): boolean {
  return (
    isAgentSkillsEnabled()
    && process.env.SKILL_SCRIPT_EXECUTION_ENABLED === 'true'
    && process.env.SANDBOX_COMMANDS_ENABLED === 'true'
    && process.env.SANDBOX_PROVIDER === 'docker'
    && process.env.WORKSPACE_HOST_QUOTA_VERIFIED === 'true'
    && process.env.SANDBOX_FILE_WRITE_ENABLED === 'true'
  );
}

export function skillScriptImageDigest(): string {
  const image = process.env.SANDBOX_IMAGE?.trim();
  if (!image || !/^.+@sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new Error('SANDBOX_IMAGE must be pinned to a sha256 digest for skill scripts');
  }
  return image;
}
