/**
 * Read-only skill storage doctor. Does not rebuild, import, or scan unknown packages.
 *
 * Usage:
 *   npm run skills:doctor -- --json
 */
import { createBlobStore } from '../src/mastra/skills/blob-store.ts';
import { getSkillsStorageRoot } from '../src/mastra/skills/config.ts';
import {
  inspectSkillStorage,
  redactHealthReport,
  skillDoctorExitCode,
  SkillHealthInfrastructureError,
} from '../src/mastra/skills/health.ts';
import { listPublishedSkillTargets } from '../src/mastra/skills/reconcile.ts';
import { createReleaseStore } from '../src/mastra/skills/release-store.ts';

export type DoctorArgs = { json: boolean };

export function parseDoctorArgs(argv: string[]): DoctorArgs {
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: skills:doctor [--json]\nRead-only. Exit 0 healthy/repairable, 2 unavailable, 1 infrastructure.');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { json };
}

export async function runSkillDoctor(): Promise<{ exitCode: number; body: string }> {
  const root = getSkillsStorageRoot();
  const blobStore = createBlobStore({ root });
  const releaseStore = createReleaseStore({ root, blobStore });
  const reports = [];
  let infrastructureFailure = false;
  let targets;
  try {
    targets = await listPublishedSkillTargets();
  } catch {
    infrastructureFailure = true;
    targets = [];
  }
  for (const target of targets) {
    try {
      reports.push(redactHealthReport(await inspectSkillStorage(target, { releaseStore, blobStore })));
    } catch (error) {
      infrastructureFailure = true;
      if (!(error instanceof SkillHealthInfrastructureError)) infrastructureFailure = true;
    }
  }
  const exitCode = skillDoctorExitCode({ reports, infrastructureFailure });
  const payload = {
    exitCode,
    infrastructureFailure,
    reports: reports.map(report => ({
      skillId: report.skillId,
      version: report.version,
      manifestHash: report.manifestHash,
      status: report.status,
      safeCode: report.safeCode,
      resourceCount: report.resourceCount,
      missingCount: report.missingCount,
      corruptCount: report.corruptCount,
      resources: report.resources,
    })),
  };
  return { exitCode, body: JSON.stringify(payload) };
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('skills-doctor.ts') || entry.endsWith('skills-doctor.js')) {
  parseDoctorArgs(process.argv.slice(2));
  runSkillDoctor().then(result => {
    console.log(result.body);
    process.exit(result.exitCode);
  }).catch(() => {
    console.error('skill storage health infra');
    process.exit(1);
  });
}
