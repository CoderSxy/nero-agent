# Task runtime: Python venv/pip, full Node/npm, Bash, curl and CA certificates.
# Build-time arguments can select equivalent local bases for offline development.
ARG NODE_BASE=node:22-bookworm-slim
ARG PYTHON_BASE=python:3.13-slim-bookworm
FROM ${NODE_BASE} AS node-src
FROM ${PYTHON_BASE}
COPY --from=node-src /usr/local/bin/node /usr/local/bin/node
COPY --from=node-src /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && useradd --uid 10001 --create-home --shell /bin/bash sandbox \
 && mkdir -p /workspace && chown 10001:10001 /workspace \
 && python3 -m pip --version && python3 -m venv /tmp/venv-probe \
 && rm -rf /tmp/venv-probe && node --version && npm --version
USER 10001:10001
WORKDIR /workspace
CMD ["sleep", "infinity"]
