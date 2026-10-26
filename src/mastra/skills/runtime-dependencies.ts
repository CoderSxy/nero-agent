import { SkillPackageError } from './errors';
import type { SkillDependency, SkillRuntimeDependencies, SkillRuntimeManifest } from './types';

// Deliberately small, portable grammar: exact/comparison numeric versions joined by commas.
const RANGE = /^(?:(?:>=|<=|==|>|<|=)?\s*\d+(?:\.\d+){0,3})(?:\s*,\s*(?:>=|<=|==|>|<|=)?\s*\d+(?:\.\d+){0,3})*$/;
function invalid(message: string): never { throw new SkillPackageError('JSON_INVALID', message); }
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('依赖声明必须是对象');
  return raw as Record<string, unknown>;
}
function range(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 100 || !RANGE.test(raw) || /(?:=>|=<|><|<>)/.test(raw)) invalid('版本范围须为数字版本比较，例如 >=1.0.0,<2.0.0');
  return raw;
}
export function parseDependencies(raw: unknown): SkillRuntimeDependencies {
  if (raw === undefined) return {};
  const obj = object(raw);
  if (Object.keys(obj).some(key => !['python', 'node', 'commands'].includes(key))) invalid('未知依赖类型');
  const result: SkillRuntimeDependencies = {};
  for (const kind of ['python', 'node', 'commands'] as const) {
    if (obj[kind] === undefined) continue;
    if (!Array.isArray(obj[kind]) || obj[kind].length > 50) invalid('每类依赖最多 50 项');
    result[kind] = obj[kind].map((value: unknown): SkillDependency => {
      const entry = object(value);
      if (Object.keys(entry).some(key => !['name', 'version', 'module'].includes(key))) invalid('未知依赖字段');
      const pattern = kind === 'node' ? /^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/i : /^[a-z0-9][a-z0-9_.-]*$/i;
      if (typeof entry.name !== 'string' || entry.name.length > 120 || !pattern.test(entry.name)) invalid('依赖名称格式无效');
      if (entry.module !== undefined && (kind !== 'python' || typeof entry.module !== 'string' || !/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*$/i.test(entry.module))) invalid('Python 模块名格式无效');
      return { name: entry.name, ...(entry.version === undefined ? {} : { version: range(entry.version) }), ...(entry.module === undefined ? {} : { module: entry.module as string }) };
    });
  }
  return result;
}
export function parseRuntimeVersions(raw: unknown): SkillRuntimeManifest['runtimeVersions'] {
  if (raw === undefined) return {};
  const obj = object(raw);
  const out: NonNullable<SkillRuntimeManifest['runtimeVersions']> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!['python3', 'node', 'bash'].includes(key)) invalid('未知解释器版本字段');
    out[key as keyof typeof out] = range(value);
  }
  return out;
}
export function satisfiesVersion(actual: string, required?: string): boolean {
  if (!required) return true;
  // Pre-release builds cannot satisfy a stable numeric range by stripping the suffix.
  const match = actual.match(/^(?:v)?(\d+(?:\.\d+){0,3})$/);
  if (!match) return false;
  const a = match[1]!.split('.').map(Number);
  return required.split(',').every(part => {
    const parsed = part.trim().match(/^((?:>=|<=|==|>|<|=)?)\s*(\d+(?:\.\d+){0,3})$/)!;
    const b = parsed[2]!.split('.').map(Number);
    let comparison = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) { comparison = (a[i] ?? 0) - (b[i] ?? 0); if (comparison) break; }
    switch (parsed[1]) {
      case '>': return comparison > 0;
      case '>=': return comparison >= 0;
      case '<': return comparison < 0;
      case '<=': return comparison <= 0;
      default: return comparison === 0;
    }
  });
}
