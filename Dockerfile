# syntax=docker/dockerfile:1

# Bun cross-compiles, so the build stage runs on the native platform and never under QEMU.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4 AS build
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN bun run build --target="bun-linux-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH")"

FROM cgr.dev/chainguard/glibc-dynamic:latest
WORKDIR /app
COPY --from=build /app/dist/opsremedy /usr/local/bin/opsremedy
COPY config.yaml seed-calls.yaml ./
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["opsremedy"]
