#!/bin/sh
# Build the Linux/amd64 Mastra server and the Web static site on macOS.
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo 'This release script must run on macOS.' >&2
  exit 1
fi

ROOT_DIR=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
DIST_DIR="$ROOT_DIR/dist"
BACKEND_DIR="$DIST_DIR/mastra-linux-amd64"
BACKEND_TAR="$DIST_DIR/mastra-linux-amd64.tar.gz"
WEB_TAR="$DIST_DIR/nero-agent-web.tar.gz"
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
NPM_CACHE=${NPM_CACHE:-/tmp/nero-agent-web-npm-cache}

for command_name in docker npm tar file shasum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

mkdir -p "$DIST_DIR"
TEMP_BACKEND_DIR=$(mktemp -d "$DIST_DIR/.mastra-linux-amd64.XXXXXX")
BACKEND_TAR_TMP="$DIST_DIR/.mastra-linux-amd64.tar.gz.tmp.$$"
WEB_TAR_TMP="$DIST_DIR/.nero-agent-web.tar.gz.tmp.$$"
cleanup() {
  rm -rf "$TEMP_BACKEND_DIR"
  rm -f "$BACKEND_TAR_TMP" "$WEB_TAR_TMP"
}
trap cleanup 0
trap 'exit 1' 1 2 3 15

cd "$ROOT_DIR"
echo 'Building Mastra for Linux/amd64...'
docker buildx build \
  --platform linux/amd64 \
  --file Dockerfile.mastra-build \
  --target artifact \
  --build-arg "NPM_REGISTRY=$NPM_REGISTRY" \
  --output "type=local,dest=$TEMP_BACKEND_DIR" \
  .

test -s "$TEMP_BACKEND_DIR/index.mjs"
test -s "$TEMP_BACKEND_DIR/migrate.mjs"
test -f "$TEMP_BACKEND_DIR/migrations/001_identity.sql"
NATIVE_BINDING="$TEMP_BACKEND_DIR/node_modules/@duckdb/node-bindings-linux-x64/duckdb.node"
test -s "$NATIVE_BINDING"
if ! file "$NATIVE_BINDING" | grep -q 'ELF 64-bit.*x86-64'; then
  echo 'DuckDB native binding is not Linux x86-64.' >&2
  exit 1
fi

for migration in "$ROOT_DIR"/migrations/*.sql; do
  test -f "$TEMP_BACKEND_DIR/migrations/$(basename "$migration")"
done

UNEXPECTED_DATA=$(find "$TEMP_BACKEND_DIR" -type f \
  \( -name '*.duckdb' -o -name '*.duckdb.wal' -o -name '*.db' \
     -o -name '*.db-wal' -o -name '*.db-shm' -o -name '.env' -o -name '.env.*' \) -print)
if [ -n "$UNEXPECTED_DATA" ]; then
  printf 'Backend output contains local data or environment files:\n%s\n' "$UNEXPECTED_DATA" >&2
  exit 1
fi

DARWIN_BINDINGS=$(find "$TEMP_BACKEND_DIR/node_modules" -type d -name '*darwin*' -print)
if [ -n "$DARWIN_BINDINGS" ]; then
  printf 'Backend output contains macOS native dependencies:\n%s\n' "$DARWIN_BINDINGS" >&2
  exit 1
fi

echo 'Installing Web dependencies and building Web...'
npm ci --prefix web --legacy-peer-deps --include=optional --no-audit --no-fund \
  --cache "$NPM_CACHE" \
  --registry "$NPM_REGISTRY"
npm run build:web
test -s "$ROOT_DIR/web/dist/index.html"

echo 'Creating release archives...'
tar --no-xattrs --disable-copyfile --exclude '._*' \
  -czf "$BACKEND_TAR_TMP" -C "$TEMP_BACKEND_DIR" .
tar --no-xattrs --disable-copyfile --exclude '._*' \
  -czf "$WEB_TAR_TMP" -C "$ROOT_DIR/web/dist" .
tar -tzf "$BACKEND_TAR_TMP" >/dev/null
tar -tzf "$WEB_TAR_TMP" >/dev/null

rm -rf "$BACKEND_DIR"
mv "$TEMP_BACKEND_DIR" "$BACKEND_DIR"
mv "$BACKEND_TAR_TMP" "$BACKEND_TAR"
mv "$WEB_TAR_TMP" "$WEB_TAR"

echo 'Release archives:'
ls -lh "$BACKEND_TAR" "$WEB_TAR"
echo 'SHA-256 (compare with ECS after upload):'
shasum -a 256 "$BACKEND_TAR" "$WEB_TAR"
