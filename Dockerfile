# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

FROM rust:1-slim-bookworm AS server
WORKDIR /app/server
COPY server/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/server/target \
    cargo build --release --locked && cp target/release/swarm-milker /usr/local/bin/swarm-milker

FROM python:3.12-slim-bookworm
RUN useradd --create-home --uid 10001 milker
WORKDIR /app
COPY --from=server /usr/local/bin/swarm-milker /usr/local/bin/swarm-milker
COPY --from=web /app/web/dist web/dist
COPY watch/ watch/
COPY scripture/ scripture/
COPY reports/ reports/
COPY AGENTS.md ./
RUN mkdir -p data && chown -R milker:milker data reports
USER milker
ENV MILKER_ROOT=/app \
    HOST=0.0.0.0 \
    PORT=43124 \
    WATCH_PYTHON=python3
EXPOSE 43124
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:43124/api/health', timeout=4)"
CMD ["swarm-milker"]
