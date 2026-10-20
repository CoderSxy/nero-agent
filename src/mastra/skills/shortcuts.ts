/**
 * Skill shortcut config, literal {{field}} prompts, and shortcut storage.
 * This module must not import Node-only packages: the web form shares these validators.
 * Templates are concatenated as text. Do not eval, compile, or interpolate ${}.
 */

export const SHORTCUT_FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'boolean'] as const;
export type ShortcutFieldType = (typeof SHORTCUT_FIELD_TYPES)[number];

export const SHORTCUT_LIMITS = {
  MAX_FIELDS: 10,
  MAX_PROMPTS: 20,
  LABEL_MAX: 80,
  KEY_MAX: 32,
  TEMPLATE_MAX: 4000,
  TEXT_VALUE_MAX: 4000,
  MAX_SELECT_OPTIONS: 50,
  OPTION_MAX: 80,
  SORT_MIN: -1_000_000,
  SORT_MAX: 1_000_000,
} as const;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const PLACEHOLDER_RE = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

export class SkillShortcutError extends Error {
  readonly code: 'INVALID_INPUT' | 'REVISION_CONFLICT';
  readonly status: 400 | 409;

  constructor(code: 'INVALID_INPUT' | 'REVISION_CONFLICT', message: string, status?: 400 | 409) {
    super(message);
    this.name = 'SkillShortcutError';
    this.code = code;
    this.status = status ?? (code === 'REVISION_CONFLICT' ? 409 : 400);
  }
}

export type ShortcutField = {
  key: string;
  label: string;
  type: ShortcutFieldType;
  required: boolean;
  min?: number;
  max?: number;
  options?: string[];
};

export type ShortcutPrompt = {
  label: string;
  template: string;
};

export type ShortcutConfig = {
  label: string;
  enabled: boolean;
  sort: number;
  fields: ShortcutField[];
  prompts: ShortcutPrompt[];
};

export type SkillShortcutRecord = ShortcutConfig & {
  id: string;
  skillId: string;
  revision: string;
};

export type SkillShortcutAvailable = SkillShortcutRecord & {
  skillName: string;
};

export type ShortcutDb = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(run: (db: ShortcutDb) => Promise<T>): Promise<T>;
};

type ShortcutRow = {
  id: string;
  skill_id: string;
  label: string;
  sort: number;
  enabled: boolean;
  fields: unknown;
  prompts: unknown;
  revision: string | number;
  canonical_name?: string;
};

function fail(message: string): never {
  throw new SkillShortcutError('INVALID_INPUT', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label}包含未知字段 ${key}`);
  }
}

function parseLabel(value: unknown, name: string): string {
  if (typeof value !== 'string') fail(`${name}必须是字符串`);
  const label = value.trim();
  if (label.length < 1 || label.length > SHORTCUT_LIMITS.LABEL_MAX) {
    fail(`${name}长度须为 1–${SHORTCUT_LIMITS.LABEL_MAX}`);
  }
  return label;
}

function parseKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > SHORTCUT_LIMITS.KEY_MAX || !KEY_RE.test(value)) {
    fail('字段 key 必须是不超过 32 字符的安全标识符');
  }
  return value;
}

export function validateShortcut(input: unknown): ShortcutConfig {
  if (!isPlainObject(input)) fail('快捷配置无效');
  assertExactKeys(input, ['label', 'enabled', 'sort', 'fields', 'prompts'], '快捷配置');
  const label = parseLabel(input.label, '名称');
  if (typeof input.enabled !== 'boolean') fail('enabled 必须是布尔值');
  if (
    typeof input.sort !== 'number'
    || !Number.isInteger(input.sort)
    || input.sort < SHORTCUT_LIMITS.SORT_MIN
    || input.sort > SHORTCUT_LIMITS.SORT_MAX
  ) {
    fail('sort 必须是整数');
  }
  if (!Array.isArray(input.fields)) fail('fields 必须是数组');
  if (input.fields.length > SHORTCUT_LIMITS.MAX_FIELDS) fail('字段不能超过 10 个');
  if (!Array.isArray(input.prompts)) fail('prompts 必须是数组');
  if (input.prompts.length > SHORTCUT_LIMITS.MAX_PROMPTS) fail('提示选项不能超过 20 个');

  const fields: ShortcutField[] = [];
  const keys = new Set<string>();
  for (const raw of input.fields) {
    if (!isPlainObject(raw)) fail('字段无效');
    const type = raw.type;
    if (type !== 'text' && type !== 'textarea' && type !== 'select' && type !== 'number' && type !== 'boolean') {
      fail('字段类型无效');
    }
    const allowed = ['key', 'label', 'type', 'required'];
    if (type === 'number') allowed.push('min', 'max');
    if (type === 'select') allowed.push('options');
    assertExactKeys(raw, allowed, '字段');
    const key = parseKey(raw.key);
    if (keys.has(key)) fail(`字段 key 重复: ${key}`);
    keys.add(key);
    if (raw.required !== undefined && typeof raw.required !== 'boolean') fail('required 必须是布尔值');
    const field: ShortcutField = {
      key,
      label: parseLabel(raw.label, '字段名称'),
      type,
      required: raw.required === true,
    };
    if (type === 'number') {
      if (raw.min !== undefined) {
        if (typeof raw.min !== 'number' || !Number.isFinite(raw.min)) fail('min 必须是有限数值');
        field.min = raw.min;
      }
      if (raw.max !== undefined) {
        if (typeof raw.max !== 'number' || !Number.isFinite(raw.max)) fail('max 必须是有限数值');
        field.max = raw.max;
      }
      if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
        fail('数值下限不能大于上限');
      }
    }
    if (type === 'select') {
      if (!Array.isArray(raw.options) || raw.options.length < 1
        || raw.options.length > SHORTCUT_LIMITS.MAX_SELECT_OPTIONS) {
        fail('select 选项无效');
      }
      const options: string[] = [];
      for (const option of raw.options) {
        if (typeof option !== 'string') fail('select 选项必须是字符串');
        const text = option.trim();
        if (text.length < 1 || text.length > SHORTCUT_LIMITS.OPTION_MAX) fail('select 选项长度无效');
        if (options.includes(text)) fail('select 选项重复');
        options.push(text);
      }
      field.options = options;
    }
    fields.push(field);
  }

  const prompts: ShortcutPrompt[] = [];
  for (const raw of input.prompts) {
    if (!isPlainObject(raw)) fail('提示选项无效');
    assertExactKeys(raw, ['label', 'template'], '提示选项');
    const promptLabel = parseLabel(raw.label, '提示选项名称');
    if (typeof raw.template !== 'string' || raw.template.length < 1
      || raw.template.length > SHORTCUT_LIMITS.TEMPLATE_MAX) {
      fail('提示模板长度无效');
    }
    for (const match of raw.template.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const token = match[1] ?? '';
      if (!KEY_RE.test(token) || token.length > SHORTCUT_LIMITS.KEY_MAX || !keys.has(token)) {
        fail(`提示模板引用了未知字段 ${token}`);
      }
    }
    prompts.push({ label: promptLabel, template: raw.template });
  }

  return { label, enabled: input.enabled, sort: input.sort, fields, prompts };
}

/** Insert string values for {{field}}. Leave ${...}, HTML, and unknown placeholders as text. */
export function renderShortcutPrompt(template: string, values: Record<string, string>): string {
  if (typeof template !== 'string') fail('模板必须是字符串');
  const bag = Object.create(null) as Record<string, string>;
  if (values && typeof values === 'object') {
    for (const key of Object.keys(values)) {
      const value = values[key];
      if (typeof value === 'string') bag[key] = value;
    }
  }
  let out = '';
  let last = 0;
  const re = new RegExp(PLACEHOLDER_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    out += template.slice(last, match.index);
    const key = match[1] ?? '';
    out += Object.prototype.hasOwnProperty.call(bag, key) ? bag[key]! : match[0];
    last = match.index + match[0].length;
  }
  return out + template.slice(last);
}

export function validateShortcutValues(
  fields: readonly ShortcutField[],
  raw: unknown,
): Record<string, string> {
  if (!isPlainObject(raw)) fail('参数无效');
  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) fail(`未知字段 ${key}`);
  }
  const values = Object.create(null) as Record<string, string>;
  for (const field of fields) {
    const present = Object.prototype.hasOwnProperty.call(raw, field.key);
    const value = present ? raw[field.key] : undefined;
    if (field.type === 'boolean') {
      if (!present || value === undefined || value === null) {
        if (field.required) fail(`${field.label}为必填`);
        values[field.key] = 'false';
        continue;
      }
      if (typeof value !== 'boolean') fail(`${field.label}必须是布尔值`);
      values[field.key] = value ? 'true' : 'false';
      continue;
    }
    if (field.type === 'number') {
      if (!present || value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        if (field.required) fail(`${field.label}为必填`);
        values[field.key] = '';
        continue;
      }
      if (typeof value !== 'number' && typeof value !== 'string') fail(`${field.label}必须是数值`);
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) fail(`${field.label}必须是数值`);
      if (field.min !== undefined && numeric < field.min) fail(`${field.label}低于下限`);
      if (field.max !== undefined && numeric > field.max) fail(`${field.label}超过上限`);
      values[field.key] = typeof value === 'string' ? value.trim() : String(value);
      continue;
    }
    if (field.type === 'select') {
      if (!present || value === undefined || value === null || value === '') {
        if (field.required) fail(`${field.label}为必填`);
        values[field.key] = '';
        continue;
      }
      if (typeof value !== 'string' || !field.options?.includes(value)) fail(`${field.label}不在可选项中`);
      values[field.key] = value;
      continue;
    }
    if (!present || value === undefined || value === null) {
      if (field.required) fail(`${field.label}为必填`);
      values[field.key] = '';
      continue;
    }
    if (typeof value !== 'string') fail(`${field.label}必须是字符串`);
    if (value.length > SHORTCUT_LIMITS.TEXT_VALUE_MAX) fail(`${field.label}过长`);
    if (field.required && value.trim() === '') fail(`${field.label}为必填`);
    values[field.key] = value;
  }
  return values;
}

export function renderShortcutMessage(
  fields: readonly ShortcutField[],
  template: string,
  raw: unknown,
): string {
  return renderShortcutPrompt(template, validateShortcutValues(fields, raw));
}

function rowConfig(row: ShortcutRow): ShortcutConfig {
  return validateShortcut({
    label: row.label,
    enabled: row.enabled,
    sort: Number(row.sort),
    fields: row.fields,
    prompts: row.prompts,
  });
}

function toRecord(row: ShortcutRow): SkillShortcutRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    revision: String(row.revision),
    ...rowConfig(row),
  };
}

const USE_SQL = `
  s.deleted_at IS NULL
  AND s.enabled = true
  AND s.published_version IS NOT NULL
  AND sc.enabled = true
  AND (
    s.owner_user_id = $1
    OR s.visibility = 'global'
    OR EXISTS (
      SELECT 1 FROM app_skill_grants g
      WHERE g.skill_id = s.id AND g.user_id = $1 AND g.permission = 'use'
    )
    OR EXISTS (
      SELECT 1
      FROM app_skill_audience_grants ag
      INNER JOIN app_skill_audience_members am ON am.audience_id = ag.audience_id
      WHERE ag.skill_id = s.id AND am.user_id = $1
    )
  )
`;

export function createSkillShortcutStore(db: ShortcutDb) {
  return {
    async listAvailable(userId: string): Promise<SkillShortcutAvailable[]> {
      const result = await db.query<ShortcutRow>(
        `SELECT sc.id, sc.skill_id, sc.label, sc.sort, sc.enabled, sc.fields, sc.prompts,
                sc.revision::text AS revision, s.canonical_name
         FROM app_skill_shortcuts sc
         INNER JOIN app_skills s ON s.id = sc.skill_id
         WHERE ${USE_SQL}
         ORDER BY sc.sort ASC, sc.label ASC, sc.id ASC`,
        [userId],
      );
      const items: SkillShortcutAvailable[] = [];
      for (const row of result.rows) {
        try {
          items.push({ ...toRecord(row), skillName: row.canonical_name ?? '' });
        } catch {
          // Corrupt rows stay hidden.
        }
      }
      return items;
    },

    async getBySkillId(skillId: string): Promise<SkillShortcutRecord | null> {
      const result = await db.query<ShortcutRow>(
        `SELECT id, skill_id, label, sort, enabled, fields, prompts, revision::text AS revision
         FROM app_skill_shortcuts
         WHERE skill_id = $1
         ORDER BY id ASC
         LIMIT 1`,
        [skillId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return toRecord(row);
    },

    async save(
      skillId: string,
      expectedRevision: string,
      config: ShortcutConfig,
    ): Promise<SkillShortcutRecord> {
      const saved = validateShortcut(config);
      return db.transaction(async (tx) => {
        const existing = await tx.query<{ id: string; revision: string }>(
          `SELECT id, revision::text AS revision
           FROM app_skill_shortcuts
           WHERE skill_id = $1
           ORDER BY id ASC
           LIMIT 1
           FOR UPDATE`,
          [skillId],
        );
        const current = existing.rows[0];
        if (!current) {
          if (expectedRevision !== '0') {
            throw new SkillShortcutError('REVISION_CONFLICT', '快捷配置版本冲突');
          }
          const inserted = await tx.query<ShortcutRow>(
            `INSERT INTO app_skill_shortcuts (skill_id, label, sort, enabled, fields, prompts, revision)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 1)
             RETURNING id, skill_id, label, sort, enabled, fields, prompts, revision::text AS revision`,
            [
              skillId,
              saved.label,
              saved.sort,
              saved.enabled,
              JSON.stringify(saved.fields),
              JSON.stringify(saved.prompts),
            ],
          );
          return toRecord(inserted.rows[0]!);
        }
        if (String(current.revision) !== expectedRevision) {
          throw new SkillShortcutError('REVISION_CONFLICT', '快捷配置版本冲突');
        }
        const updated = await tx.query<ShortcutRow>(
          `UPDATE app_skill_shortcuts
           SET label = $2, sort = $3, enabled = $4, fields = $5::jsonb, prompts = $6::jsonb,
               revision = revision + 1, updated_at = now()
           WHERE id = $1
           RETURNING id, skill_id, label, sort, enabled, fields, prompts, revision::text AS revision`,
          [
            current.id,
            saved.label,
            saved.sort,
            saved.enabled,
            JSON.stringify(saved.fields),
            JSON.stringify(saved.prompts),
          ],
        );
        return toRecord(updated.rows[0]!);
      });
    },
  };
}
