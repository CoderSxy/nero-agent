FROM python:3.12-slim-bookworm

RUN useradd --uid 10001 --create-home --shell /bin/bash sandbox \
  && mkdir -p /workspace \
  && chown 10001:10001 /workspace

USER 10001:10001
WORKDIR /workspace

CMD ["sleep", "infinity"]
