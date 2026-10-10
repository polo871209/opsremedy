# syntax=docker/dockerfile:1

# Build on native amd64. Wolfi's bun needs AVX2 and breaks under QEMU.
FROM cgr.dev/chainguard/wolfi-base:latest AS deps

# hadolint ignore=DL3018
RUN apk add --no-cache bun

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && \
    find node_modules -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \
      -o -iname 'readme*' -o -iname 'changelog*' -o -iname 'history.md' \) -delete

FROM cgr.dev/chainguard/glibc-dynamic:latest

COPY --from=deps /usr/bin/bun /usr/bin/bun
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY protos ./protos
COPY config.yaml seed-calls.yaml ./
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["bun"]
CMD ["run", "src/index.ts"]
