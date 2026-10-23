#!/usr/bin/env bash
# Run as root only after host project quota has actually been verified.
set -euo pipefail
DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
ENV_FILE=${ENV_FILE:-/opt/nero-agent/.env}
NODE=${NODE:-/usr/local/bin/node}
SERVICE=${SERVICE:-nero-agent}
SERVICE_USER=${SERVICE_USER:-nero-agent}
[[ ${EUID:-$(id -u)} == 0 ]] || { echo 'Run enable-runtime.sh as root' >&2; exit 1; }
[[ $# == 1 && $1 =~ ^.+@sha256:[a-f0-9]{64}$ ]] || {
  echo 'Usage: enable-runtime.sh <image-name@sha256:digest>' >&2; exit 1;
}
cd "$DIR"
sha256sum -c SHA256SUMS
"$NODE" "$DIR/configure-runtime.mjs" "$ENV_FILE" "$1" --check
# Match the application's local-image-ID fallback without an accidental remote pull.
image=${1#*@}
if ! docker image inspect "$image" >/dev/null 2>&1; then image=$1; fi
docker image inspect "$image" >/dev/null
runuser -u "$SERVICE_USER" -- docker image inspect "$image" >/dev/null
runuser -u "$SERVICE_USER" -- bash "$DIR/smoke.sh" "$image"
"$NODE" "$DIR/configure-runtime.mjs" "$ENV_FILE" "$1" --apply
systemctl restart "$SERVICE"
systemctl is-active --quiet "$SERVICE"
systemctl show "$SERVICE" -p ActiveState -p MainPID -p NRestarts --no-pager
echo 'Runtime configuration applied; export smoke passed. Now verify a new logged-in chat with the ppt skill.'
echo 'If application startup or chat fails, restore the printed .env backup and restart the service.'
