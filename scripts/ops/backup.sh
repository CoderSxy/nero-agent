#!/usr/bin/env bash
# Run under a bounded systemd transient unit; never opens DuckDB.
set -euo pipefail
umask 077
[[ $# == 1 && $1 == /* ]] || { echo 'Usage: backup.sh /absolute/new/backup-directory' >&2; exit 2; }
[[ $(id -u) == 0 ]] || { echo 'Run as root' >&2; exit 2; }
unit=${AGENT_UNIT:-nero-agent.service}
state=$(systemctl show "$unit" --value -p ActiveState)
pid=$(systemctl show "$unit" --value -p MainPID)
[[ ( $state == inactive || $state == failed ) && $pid == 0 ]] || { echo 'Agent must be stopped (inactive/failed and MainPID=0)' >&2; exit 1; }
destination=$1
[[ ! -e $destination && ! -L $destination ]] || { echo 'Backup destination already exists' >&2; exit 1; }
mkdir -p "$(dirname "$destination")"
exec 9>"$(dirname "$destination")/.nero-backup.lock"
flock -n 9 || { echo 'Another backup is running' >&2; exit 1; }
mkdir -m 0700 "$destination"
container=${PG_CONTAINER:-nero-agent-postgres}
pg_user=${PG_USER:-nero_agent}
pg_database=${PG_DATABASE:-nero_agent}
duckdb=${DUCKDB_PATH:-/var/lib/nero-agent/mastra.duckdb}
env_file=${ENV_FILE:-/opt/nero-agent/.env}
# copyfile is byte-for-byte; source hash and stat comparison catch an accidental writer.
python3 - "$duckdb" "$destination" <<'PY'
import hashlib, json, os, shutil, sys
from pathlib import Path
source, dest = Path(sys.argv[1]), Path(sys.argv[2])
paths = [source, Path(str(source) + '.wal')]
if paths[1].exists() and not source.exists(): raise SystemExit('Orphan DuckDB WAL; stop and investigate')
required = sum(p.stat().st_size for p in paths if p.exists()) + 512*1024*1024
if shutil.disk_usage(dest).free < required: raise SystemExit('Insufficient free backup space')
manifest = []
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
 return h.hexdigest()
for p in paths:
 if p.is_symlink(): raise SystemExit('DuckDB source must not be a symlink')
 if not p.exists():
  manifest.append({'source':str(p),'present':False}); continue
 before=p.stat(); target=dest / ('mastra.duckdb.wal' if p == paths[1] else 'mastra.duckdb')
 shutil.copyfile(p,target); os.chmod(target,0o600)
 after=p.stat()
 if digest(p)!=digest(target) or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns): raise SystemExit('DuckDB changed during backup')
 manifest.append({'source':str(p),'present':True,'bytes':before.st_size})
(dest/'duckdb-manifest.json').write_text(json.dumps(manifest,indent=2))
PY
docker exec "$container" psql -U "$pg_user" -d "$pg_database" -Atc 'SELECT current_database(), current_user, version()' > "$destination/postgres-identity.txt"
docker exec "$container" pg_dump -U "$pg_user" -d "$pg_database" -Fc -Z1 > "$destination/postgres.dump"
test -s "$destination/postgres.dump"
docker exec -i "$container" pg_restore --list < "$destination/postgres.dump" > "$destination/postgres-contents.txt"
test -s "$destination/postgres-contents.txt"
cp -p "$env_file" "$destination/env"
chmod 600 "$destination/env"
systemctl cat "$unit" > "$destination/systemd.txt"
readlink "${CURRENT_LINK:-/opt/nero-agent/current}" > "$destination/previous-release" || :
# Recheck immediately before the success marker; a started service invalidates this backup attempt.
[[ $(systemctl show "$unit" --value -p MainPID) == 0 ]] || { echo 'Agent started during backup; incomplete backup' >&2; exit 1; }
python3 - "$destination" <<'PY'
import hashlib, sys
from pathlib import Path
root=Path(sys.argv[1]); lines=[]
for p in sorted(root.iterdir()):
 if not p.is_file(): continue
 h=hashlib.sha256()
 with p.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
 lines.append(f'{h.hexdigest()}  {p.name}')
(root/'SHA256SUMS').write_text(chr(10).join(lines)+chr(10))
(root/'COMPLETE').write_text('Archive checks passed; isolated restore drill still required.'+chr(10))
PY
printf 'Backup complete: %s\n' "$destination"
