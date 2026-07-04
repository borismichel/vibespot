# syntax=docker/dockerfile:1.7

# ---------- builder ----------
FROM node:22-alpine AS builder

WORKDIR /build

RUN apk add --no-cache git

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY bin ./bin
COPY assets ./assets
COPY ui ./ui
COPY starters ./starters

RUN npm run build

# Strip dev dependencies for the runtime image.
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.source="https://github.com/borismichel/vibespot" \
      org.opencontainers.image.title="vibespot" \
      org.opencontainers.image.description="AI-powered HubSpot CMS landing page builder"

RUN apk add --no-cache tini git \
    && addgroup -S vibespot \
    && adduser -S -G vibespot -h /home/vibespot vibespot

WORKDIR /app

COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/bin ./bin
COPY --from=builder /build/assets ./assets
COPY --from=builder /build/ui ./ui
COPY --from=builder /build/starters ./starters

RUN mkdir -p /home/vibespot/.vibespot /workspace \
    && chown -R vibespot:vibespot /app /home/vibespot /workspace

USER vibespot

# VIBESPOT_HOST=0.0.0.0: a container must bind beyond loopback to be reachable
# from the compose network / port mapping. This makes token auth mandatory
# (VIB-1889) — set VIBESPOT_AUTH_TOKEN, or read the generated URL from logs.
ENV NODE_ENV=production \
    VIBESPOT_PORT=4200 \
    VIBESPOT_NO_OPEN=1 \
    VIBESPOT_HOST=0.0.0.0 \
    HOME=/home/vibespot

EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${VIBESPOT_PORT}/healthz >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--", "node", "bin/vibespot.mjs"]
CMD []
