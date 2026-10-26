import type { SkillRuntimeManifest } from './types';

export function pickInterpreter(
  scriptPath: string,
  runtime: SkillRuntimeManifest | null,
): string | null {
  const allowed = new Set(runtime?.runtimes ?? ['python3', 'node', 'bash']);
  const lower = scriptPath.toLowerCase();
  let choice: 'python3' | 'node' | 'bash' | null = null;
  if (lower.endsWith('.py')) choice = 'python3';
  else if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) choice = 'node';
  else if (lower.endsWith('.sh')) choice = 'bash';
  if (!choice || !allowed.has(choice)) return null;
  return choice;
}

