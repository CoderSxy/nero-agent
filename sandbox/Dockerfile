# Sandbox / skill-script image (UID 10001). Pin by digest via SANDBOX_IMAGE.
# Interpreters: python3, node, bash — dependencies are baked at build time; no runtime pip/npm.
#
# Preferred base (when registry/apt reachable):
#   FROM python:3.12-slim-bookworm
# Offline host fallback used when docker.io / deb.debian.org are unreachable:
#   local python:3.13.7 + node binary copied from a local image that already has Node.
ARG PYTHON_BASE=python:3.13.7
ARG NODE_SRC=primeai-harness-sandbox:latest

FROM ${NODE_SRC} AS node-src

FROM ${PYTHON_BASE}

COPY --from=node-src /usr/bin/node /usr/local/bin/node

RUN set -eux; \
  if command -v apt-get >/dev/null 2>&1; then \
    apt-get update \
      && apt-get install -y --no-install-recommends bash ca-certificates \
      && rm -rf /var/lib/apt/lists/* || true; \
  fi; \
  if ! id -u sandbox >/dev/null 2>&1; then \
    useradd --uid 10001 --create-home --shell /bin/bash sandbox; \
  fi; \
  mkdir -p /workspace; \
  chown 10001:10001 /workspace; \
  ln -sf /usr/local/bin/node /usr/bin/node 2>/dev/null || true; \
  python3 --version; \
  node --version; \
  bash --version | head -n1

USER 10001:10001
WORKDIR /workspace

CMD ["sleep", "infinity"]
