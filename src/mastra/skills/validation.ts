import { validateSkillContent } from '@mastra/core/skills';
import { parseDocument, visit } from 'yaml';
import { SkillPackageError } from './errors';
import type { SkillMdValidationResult } from './types';

/** Spec §4 limits — single source for package/HTTP/CLI validators. */
export const SKILL_LIMITS = {
  SKILL_MD_MAX_BYTES: 128 * 1024,
  TEXT_READ_MAX_BYTES: 64 * 1024,
  TEXT_READ_MAX_LINES: 400,
  TEXT_READ_DEFAULT_LINES: 200,
  FILE_MAX_BYTES: 100 * 1024 * 1024,
  VERSION_TOTAL_MAX_BYTES: 200 * 1024 * 1024,
  MAX_FILES: 1000,
  ZIP_MAX_BYTES: 100 * 1024 * 1024,
  JSON_MAX_BYTES: 256 * 1024,
  PATH_MAX_CHARS: 512,
  YAML_MAX_ALIAS_EXPANSIONS: 20,
  PAGE_DEFAULT: 20,
  PAGE_MAX: 50,
  CANONICAL_NAME_MAX: 64,
  DESCRIPTION_MAX: 1024,
  ALIAS_MAX: 64,
  /** Published remark max length (matches DB CHECK). */
  PUBLISH_REMARK_MAX: 500,
  SEARCH_QUERY_MIN: 1,
  SEARCH_QUERY_MAX: 512,
  SEARCH_TOPK_DEFAULT: 5,
  SEARCH_TOPK_MAX: 20,
  SEARCH_SNIPPET_MAX_CHARS: 2000,
  SEARCH_TOTAL_SNIPPET_MAX_BYTES: 16 * 1024,
  LOAD_RESOURCE_SUMMARY_MAX: 50,
  /** Catalog injection: max skills and UTF-8 budget (spec §7). */
  CATALOG_MAX_ITEMS: 100,
  CATALOG_MAX_BYTES: 32 * 1024,
  /** Explicit selection + reinjected instruction bodies total budget. */
  INSTRUCTIONS_CONTEXT_MAX_BYTES: 128 * 1024,
  SELECTED_SKILL_IDS_MAX: 5,
  /** Active run pins retained for resume/diagnostics. */
  RUN_PIN_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  /** GET /users?q= picker query (admin/owner). */
  USER_QUERY_MAX: 64,
  USER_QUERY_MIN: 1,
  USER_PICKER_LIMIT: 20,
} as const;

export const SELECTED_SKILL_IDS_CONTEXT_KEY = 'nero-agent.selected-skill-ids';
export const SERVER_EXECUTION_ID_CONTEXT_KEY = 'nero-agent.server-execution-id';
export const SKILL_THREAD_ID_CONTEXT_KEY = 'nero-agent.skill-thread-id';
export const NERO_AVAILABLE_SKILLS_TAG = 'nero_available_skills';
export const NERO_LOADED_SKILLS_TAG = 'nero_loaded_skills';
export const SKILL_ACTIVATION_CHUNK_TYPE = 'data-nero-skill-activation' as const;

/** Lowercase hex SHA-256. */
export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_RE.test(value);
}

const CANONICAL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_FORMAT_ERROR_RE = /name:\s*Skill name/i;

export function isCanonicalSkillName(name: string): boolean {
  return (
    name.length >= 1
    && name.length <= SKILL_LIMITS.CANONICAL_NAME_MAX
    && CANONICAL_NAME_RE.test(name)
  );
}

/** Suggest a canonical name; does not claim acceptance or uniqueness. */
export function suggestCanonicalName(sourceName: string): string {
  const lowered = sourceName.trim().toLowerCase();
  const replaced = lowered.replace(/[_.]+/g, '-').replace(/[^a-z0-9-]+/g, '-');
  const collapsed = replaced.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!collapsed) return '';
  return collapsed.slice(0, SKILL_LIMITS.CANONICAL_NAME_MAX).replace(/-+$/g, '');
}

export function isValidAlias(alias: string): boolean {
  if (alias.length < 1 || alias.length > SKILL_LIMITS.ALIAS_MAX) return false;
  if (alias === '.' || alias === '..') return false;
  return /^[A-Za-z0-9._-]+$/.test(alias);
}

export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SkillPackageError('SKILL_MD_BINARY', 'SKILL.md must be valid UTF-8 text');
  }
}

export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return true;
  // NUL in first 8KiB ⇒ binary
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8 * 1024));
  for (let i = 0; i < sample.byteLength; i++) {
    if (sample[i] === 0) return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a skill-relative POSIX path.
 * Applies Unicode NFC; rejects absolute/drive/NUL/backslash/empty/dot/parent segments.
 */
export function normalizeSkillPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || !rawPath) {
    throw new SkillPackageError('PATH_INVALID', 'Path is empty');
  }
  if (rawPath.includes('\0') || rawPath.includes('\\')) {
    throw new SkillPackageError('PATH_INVALID', 'Path contains NUL or backslash');
  }
  if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) {
    throw new SkillPackageError('PATH_INVALID', 'Absolute paths are not allowed');
  }
  const nfc = rawPath.normalize('NFC');
  if (nfc.length > SKILL_LIMITS.PATH_MAX_CHARS) {
    throw new SkillPackageError('PATH_INVALID', 'Path exceeds maximum length');
  }
  const segments = nfc.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new SkillPackageError('PATH_INVALID', 'Path contains empty or parent segments');
  }
  return segments.join('/');
}

export function pathCollisionKey(normalizedPath: string): string {
  return normalizedPath.normalize('NFC').toLocaleLowerCase('en-US');
}

type FrontmatterParse = {
  yamlText: string;
  body: string;
  metadata: Record<string, unknown>;
};

function splitFrontmatter(content: string): { yamlText: string; body: string } | null {
  if (!content.startsWith('---')) return null;
  const rest = content.slice(3);
  const nl = rest.startsWith('\r\n') ? '\r\n' : rest.startsWith('\n') ? '\n' : null;
  if (!nl) return null;
  const afterOpen = rest.slice(nl.length);
  const closePattern = nl === '\r\n' ? /\r\n---[ \t]*(?:\r\n|$)/ : /\n---[ \t]*(?:\n|$)/;
  const match = closePattern.exec(afterOpen);
  if (!match || match.index === undefined) return null;
  const yamlText = afterOpen.slice(0, match.index);
  const body = afterOpen.slice(match.index + match[0].length);
  return { yamlText, body };
}

function assertNoCustomYamlTags(doc: ReturnType<typeof parseDocument>): void {
  const errors: string[] = [];
  visit(doc, (_key, node) => {
    if (!node || typeof node !== 'object') return;
    if (!('tag' in node) || typeof node.tag !== 'string') return;
    const tag = node.tag;
    if (tag === '' || tag === '!' || tag === '?' || tag === ':') return;
    if (tag.startsWith('tag:yaml.org,2002:')) return;
    errors.push(`YAML custom tags are not allowed (${tag})`);
  });
  if (errors.length > 0) {
    throw new SkillPackageError('YAML_INVALID', errors[0]!);
  }
}

export function parseSkillFrontmatterYaml(content: string): FrontmatterParse {
  const split = splitFrontmatter(content);
  if (!split) {
    throw new SkillPackageError('YAML_INVALID', 'SKILL.md must start with YAML frontmatter');
  }
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(split.yamlText, {
      prettyErrors: true,
      uniqueKeys: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'YAML parse failed';
    if (/alias/i.test(message)) {
      throw new SkillPackageError('YAML_INVALID', `YAML alias expansion exceeds limit of ${SKILL_LIMITS.YAML_MAX_ALIAS_EXPANSIONS}`);
    }
    throw new SkillPackageError('YAML_INVALID', message);
  }
  if (doc.errors.length > 0) {
    const message = doc.errors.map(e => e.message).join('; ');
    if (/alias/i.test(message)) {
      throw new SkillPackageError('YAML_INVALID', `YAML alias expansion exceeds limit of ${SKILL_LIMITS.YAML_MAX_ALIAS_EXPANSIONS}`);
    }
    throw new SkillPackageError('YAML_INVALID', message);
  }
  assertNoCustomYamlTags(doc);
  let metadata: unknown;
  try {
    metadata = doc.toJS({ maxAliasCount: SKILL_LIMITS.YAML_MAX_ALIAS_EXPANSIONS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'YAML parse failed';
    if (/alias/i.test(message)) {
      throw new SkillPackageError(
        'YAML_INVALID',
        `YAML alias expansion exceeds limit of ${SKILL_LIMITS.YAML_MAX_ALIAS_EXPANSIONS}`,
      );
    }
    throw new SkillPackageError('YAML_INVALID', message);
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new SkillPackageError('YAML_INVALID', 'SKILL.md frontmatter must be a mapping');
  }
  return {
    yamlText: split.yamlText,
    body: split.body,
    metadata: metadata as Record<string, unknown>,
  };
}

function isNameFormatError(message: string): boolean {
  return NAME_FORMAT_ERROR_RE.test(message)
    || /must contain only lowercase/i.test(message)
    || /must not contain consecutive hyphens/i.test(message)
    || /must not start or end with a hyphen/i.test(message)
    || /must match directory name/i.test(message);
}

/**
 * Validate SKILL.md text. Calls installed Mastra `validateSkillContent`.
 * Non-canonical names produce `requiresNameAcceptance` instead of silent rewrite.
 */
export function validateSkillMd(text: string, directoryName: string): SkillMdValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (typeof text !== 'string') {
    return { valid: false, errors: ['SKILL.md must be a string'], warnings };
  }
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > SKILL_LIMITS.SKILL_MD_MAX_BYTES) {
    return {
      valid: false,
      errors: [`SKILL.md exceeds ${SKILL_LIMITS.SKILL_MD_MAX_BYTES} bytes`],
      warnings,
    };
  }

  let sourceName = '';
  let suggestedCanonicalName = '';
  let requiresNameAcceptance = false;

  try {
    const parsed = parseSkillFrontmatterYaml(text);
    const rawName = parsed.metadata.name;
    sourceName = typeof rawName === 'string' ? rawName : '';
    suggestedCanonicalName = sourceName ? suggestCanonicalName(sourceName) : suggestCanonicalName(directoryName);
    if (sourceName && !isCanonicalSkillName(sourceName)) {
      requiresNameAcceptance = true;
      warnings.push(
        `Source name "${sourceName}" is not canonical; suggested "${suggestedCanonicalName || '(none)'}". Explicit acceptance required; name will not be silently rewritten.`,
      );
    }
  } catch (err) {
    if (err instanceof SkillPackageError) {
      return { valid: false, errors: [err.message], warnings, requiresNameAcceptance: false };
    }
    throw err;
  }

  const mastra = validateSkillContent({ content: text, directoryName });
  for (const warning of mastra.warnings) warnings.push(warning);

  for (const error of mastra.errors) {
    if (requiresNameAcceptance && isNameFormatError(error)) {
      warnings.push(error);
      continue;
    }
    errors.push(error);
  }

  if (!requiresNameAcceptance && directoryName && sourceName && directoryName !== sourceName) {
    if (!errors.some(e => /directory/i.test(e))) {
      errors.push(`name: Skill name must match directory name (${directoryName})`);
    }
  }

  const description = mastra.metadata?.description;
  const hasDescription = typeof description === 'string' && description.length > 0;
  const finalValid = errors.length === 0 && hasDescription;

  return {
    valid: finalValid,
    errors,
    warnings,
    metadata: mastra.metadata,
    instructions: mastra.instructions,
    sourceName,
    suggestedCanonicalName,
    requiresNameAcceptance,
  };
}

export function assertWithinFileLimit(size: number, path: string): void {
  if (size > SKILL_LIMITS.FILE_MAX_BYTES) {
    throw new SkillPackageError('FILE_TOO_LARGE', `File exceeds ${SKILL_LIMITS.FILE_MAX_BYTES} bytes: ${path}`);
  }
}

export function assertWithinVersionTotal(total: number): void {
  if (total > SKILL_LIMITS.VERSION_TOTAL_MAX_BYTES) {
    throw new SkillPackageError('VERSION_TOO_LARGE', `Version total exceeds ${SKILL_LIMITS.VERSION_TOTAL_MAX_BYTES} bytes`);
  }
}

export function assertWithinFileCount(count: number): void {
  if (count > SKILL_LIMITS.MAX_FILES) {
    throw new SkillPackageError('TOO_MANY_FILES', `Package exceeds ${SKILL_LIMITS.MAX_FILES} files`);
  }
}
