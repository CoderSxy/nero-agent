/**
 * Skill storage GC. Default is dry-run.
 * `--apply` deletes only unreferenced content past the 7-day grace,
 * run pins 7 days after they end, and runtime audit events older than 90 days.
 * Active pins and the current published release are never deleted.
 *
 * Usage:
 *   node --env-file-if-exists=.env --import tsx scripts/skills-gc.ts [--apply]
 */
import { applyProductionGc } from '../src/mastra/skills/reconcile.ts';

export type GcArgs = { apply: boolean };

export function parseGcArgs(argv: string[]): GcArgs {
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: skills-gc [--apply]\nDefault is dry-run. --apply deletes grace-elapsed unreferenced content.');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { apply };
}

async function main(): Promise<void> {
  const args = parseGcArgs(process.argv.slice(2));
  const report = await applyProductionGc({ apply: args.apply });
  console.log(JSON.stringify({
    apply: args.apply,
    applied: report.applied,
    eligible: report.eligibleIds,
  }, null, 2));
  if (!args.apply) {
    console.log('dry-run: no files or rows deleted. Pass --apply to delete grace-elapsed unreferenced content.');
  }
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('skills-gc.ts') || entry.endsWith('skills-gc.js')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'skills-gc failed');
    process.exit(1);
  });
}
