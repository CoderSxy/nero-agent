#!/usr/bin/env bash
# Candidate/backend directory + NEW backup directory. Does not switch/restart/enable.
set -euo pipefail
umask 077
[[ $# == 2 && $1 == /* && $2 == /* ]] || { echo 'Usage: prepare-release.sh /absolute/release/mastra /absolute/new-backup' >&2; exit 2; }
candidate=$1
backup=$2
node_bin=${NODE_BIN:-/usr/local/bin/node}
env_file=${ENV_FILE:-/opt/nero-agent/.env}
ops=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
test -s "$candidate/index.mjs"
test -s "$candidate/migrate.mjs"
test -x "$node_bin"
if ! bash "$ops/backup.sh" "$backup"; then echo 'Backup failed; migration is blocked' >&2; exit 1; fi
test -s "$backup/COMPLETE"
# Re-read every archived byte before permitting database mutation.
python3 - "$backup" <<'PY'
import hashlib,sys
from pathlib import Path
root=Path(sys.argv[1])
for line in (root/'SHA256SUMS').read_text().splitlines():
 expected,name=line.split('  ',1); h=hashlib.sha256()
 with (root/name).open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
 if h.hexdigest()!=expected: raise SystemExit('Backup checksum mismatch; migration blocked')
PY
APP_MIGRATIONS_DIR="$candidate/migrations" NODE_OPTIONS=--max-old-space-size=128 "$node_bin" --env-file="$env_file" "$candidate/migrate.mjs"
APP_MIGRATIONS_DIR="$candidate/migrations" NODE_OPTIONS=--max-old-space-size=128 "$node_bin" --env-file="$env_file" "$candidate/migrate.mjs" --check
printf 'Candidate prepared: %s\n' "$candidate" > "$backup/PREPARED"
echo 'Backup and migration gates passed. Service remains stopped; install protection before controlled start.'
