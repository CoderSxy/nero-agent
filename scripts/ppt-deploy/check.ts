import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { getPool } from '../../src/mastra/auth/db.ts';
import { createBlobStore } from '../../src/mastra/skills/blob-store.ts';
import { createReleaseStore } from '../../src/mastra/skills/release-store.ts';
import { previewSkillZip } from '../../src/mastra/skills/package.ts';
import { getSkillsStorageRoot } from '../../src/mastra/skills/config.ts';

const args = process.argv.slice(2);
const pool = getPool();
try {
  if (args.length === 1 && args[0] === '--admins') {
    console.log(JSON.stringify((await pool.query(`SELECT u.id, u.display_name FROM app_users u
      JOIN app_user_roles ur ON ur.user_id=u.id JOIN app_roles r ON r.id=ur.role_id
      WHERE u.status='active' AND r.code='admin' ORDER BY u.created_at`)).rows, null, 2));
  } else {
    if (args.length !== 2 || args[0] !== '--file') throw new Error('Usage: check.mjs --admins | --file <skill.zip>');
    const bytes = await readFile(args[1]);
    const preview = await previewSkillZip(Readable.toWeb(Readable.from([bytes])));
    const pkg = preview.package;
    if (pkg.canonicalName !== 'ppt') throw new Error('Expected canonical skill name ppt');
    const matches = (await pool.query(`SELECT s.id,s.enabled,s.visibility,s.published_version,
      v.manifest_hash FROM app_skills s LEFT JOIN app_skill_versions v
      ON v.skill_id=s.id AND v.version=s.published_version
      WHERE s.canonical_name=$1 AND s.deleted_at IS NULL`, [pkg.canonicalName])).rows;
    if (!matches.length) {
      console.log('PPT_NOT_INSTALLED');
      process.exitCode = 3;
    } else {
      const skill = matches[0];
      const root = getSkillsStorageRoot();
      const release = createReleaseStore({ root, blobStore: createBlobStore({ root }) });
      const expected = release.computeManifestHash(pkg.skillMd, pkg.resources.map(file => ({
        path:file.path,size:file.size,isText:file.isText,
        blobHash:createHash('sha256').update(file.bytes).digest('hex'),
      })));
      if (!skill.enabled || skill.visibility !== 'global' || skill.manifest_hash !== expected) {
        throw new Error('Existing ppt is disabled, private, a draft, or differs from this package. Update/publish it in Skills management; existing content was not overwritten.');
      }
      await release.verifyRelease(skill.id, skill.published_version, skill.manifest_hash);
      console.log(JSON.stringify({ status:'published-global-enabled', ...skill, resources:pkg.resources.length }));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'PPT verification failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
