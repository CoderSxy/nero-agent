#!/usr/bin/env bash
set -euo pipefail
DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
PLATFORM=${PLATFORM:-linux/amd64}
BASE_TAG=${BASE_TAG:-nero-ppt-base:local}
PPT_TAG=${PPT_TAG:-nero-ppt-runtime:local}
cd "$DIR"
sha256sum -c SHA256SUMS
docker build --platform "$PLATFORM" -t "$BASE_TAG" -f Dockerfile.base .
docker image inspect --format 'Base image: {{.Id}}' "$BASE_TAG"
docker build --platform "$PLATFORM" --build-arg "SANDBOX_BASE=$BASE_TAG" -t "$PPT_TAG" -f Dockerfile.ppt .
PPT_ID=$(docker image inspect --format '{{.Id}}' "$PPT_TAG")
bash "$DIR/smoke.sh" "$PPT_ID"
printf '\nBuild and export smoke passed. Local-daemon pinned image:\n%s@%s\n' "$PPT_TAG" "$PPT_ID"
echo 'For other Docker hosts, push/load the image there first and use its registry RepoDigest or verified local image ID.'
