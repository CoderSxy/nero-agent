#!/usr/bin/env bash
set -euo pipefail
DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
[[ $# == 1 ]] || { echo 'Usage: smoke.sh <local-image-id-or-digest>' >&2; exit 1; }
docker run --rm --network none --read-only --user 10001:10001 \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 768m --cpus 1 \
  --tmpfs /workspace:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700 \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount "type=bind,source=$DIR,target=/bundle,readonly" \
  -e PYTHONDONTWRITEBYTECODE=1 "$1" python3 /bundle/smoke.py
