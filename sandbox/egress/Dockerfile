# Build context: repository root. Prebuild proxy.mjs with npm run build:egress.
ARG EGRESS_BASE=node:22-bookworm-slim
FROM ${EGRESS_BASE}
WORKDIR /app
COPY sandbox/egress/dist/proxy.mjs /app/proxy.mjs
USER 10001:10001
CMD ["node", "/app/proxy.mjs"]
