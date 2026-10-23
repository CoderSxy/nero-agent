#!/usr/bin/env bash
# Usage: bash install.sh --admins | --install <production-admin-uuid>
set -euo pipefail
DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
BACKEND_DIR=${BACKEND_DIR:-/opt/nero-agent/current/mastra}
ENV_FILE=${ENV_FILE:-/opt/nero-agent/.env}
NODE=${NODE:-/usr/local/bin/node}
cd "$DIR"
sha256sum -c SHA256SUMS
if [[ ! -d "$BACKEND_DIR/node_modules" ]]; then
  echo 'BACKEND_DIR must point to the deployed Mastra directory with node_modules.' >&2; exit 1
fi
# Use the dependencies already shipped with the production release, not Mac binaries.
if [[ ! -e "$DIR/node_modules" && ! -L "$DIR/node_modules" ]]; then
  ln -s "$BACKEND_DIR/node_modules" "$DIR/node_modules"
fi
[[ $(readlink -f "$DIR/node_modules") == $(readlink -f "$BACKEND_DIR/node_modules") ]] || {
  echo 'node_modules link targets another release; remove only this bundle link and retry.' >&2; exit 1;
}
if [[ ${1:-} == --admins && $# == 1 ]]; then
  exec "$NODE" --env-file="$ENV_FILE" "$DIR/check.mjs" --admins
fi
if [[ ${1:-} != --install || $# != 2 ]]; then
  echo 'Usage: bash install.sh --admins | --install <production-admin-uuid>' >&2; exit 1
fi
[[ $2 =~ ^[a-fA-F0-9-]{36}$ ]] || { echo 'Invalid admin UUID' >&2; exit 1; }
set +e
"$NODE" --env-file="$ENV_FILE" "$DIR/check.mjs" --file "$DIR/ppt-nero.zip"
result=$?
set -e
if [[ $result == 3 ]]; then
  "$NODE" --env-file="$ENV_FILE" "$DIR/import.mjs" --actor-user-id "$2" \
    --file "$DIR/ppt-nero.zip" --name ppt --global --publish --enable
elif [[ $result != 0 ]]; then
  exit "$result"
fi
"$NODE" --env-file="$ENV_FILE" "$DIR/check.mjs" --file "$DIR/ppt-nero.zip"
echo 'PPT is published, globally visible and enabled. Run enable-runtime.sh separately to enable execution.'
