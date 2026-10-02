import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const postgresEnvPath = '.env.postgres';
if (!existsSync(postgresEnvPath)) {
  const password = randomBytes(24).toString('base64url');
  writeFileSync(postgresEnvPath,
    `POSTGRES_USER=nero_agent\nPOSTGRES_DB=nero_agent\nPOSTGRES_PASSWORD=${password}\n`, { mode: 0o600 });
}
const postgresEnv = readFileSync(postgresEnvPath, 'utf8');
const password = postgresEnv.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1];
if (!password) throw new Error('.env.postgres 缺少 POSTGRES_PASSWORD');
const localUrl = `postgresql://nero_agent:${encodeURIComponent(password)}@127.0.0.1:5433/nero_agent`;
const envPath = '.env';
const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const configured = existing.match(/^DATABASE_URL=(.+)$/m)?.[1];
if (configured && configured !== localUrl) {
  throw new Error('.env 中已有不同的 DATABASE_URL；请确认目标数据库后再运行本地初始化');
}
if (!configured) writeFileSync(envPath, `${existing.trimEnd()}\nDATABASE_URL=${localUrl}\n`, { mode: 0o600 });
let cachedImage = true;
try { execFileSync('docker', ['image', 'inspect', 'postgres:16'], { stdio: 'ignore' }); }
catch { cachedImage = false; }
execFileSync('docker', ['compose', 'up', '-d', ...(cachedImage ? ['--pull', 'never'] : []),
  '--wait', 'postgres'], { stdio: 'inherit' });
execFileSync('npm', ['run', 'db:migrate'], { stdio: 'inherit' });
