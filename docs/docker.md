# Running vibespot with Docker

This guide covers running vibespot as a container — locally for evaluation
and as the deployment artifact for the single-customer EU hosted variant
(parent: [VIB-446](/VIB/issues/VIB-446)).

If you want to run vibespot the "normal" way with `npm install -g vibespot`,
see the main [README](../README.md). The Docker path exists so customers can
run the app without installing Node.js, npm, or any system dependencies.

## Prerequisites

- Docker 24+ and the `docker compose` plugin
- A valid AI API key (Anthropic, OpenAI, or Gemini) for end-to-end generation
- A public domain pointed at the host (production only — local testing works
  on `localhost`)

## Option A — Pull the published image

The image is published to GHCR on every push to `main` and on every release tag:

```bash
docker pull ghcr.io/borismichel/vibespot:latest
docker run --rm -p 4200:4200 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  ghcr.io/borismichel/vibespot:latest
```

Open <http://localhost:4200> and the vibe-coding UI loads.

Tags published:

| Trigger              | Tag(s)                                          |
| -------------------- | ----------------------------------------------- |
| Push to `main`       | `main`, `sha-<short>`                           |
| Tag `vX.Y.Z`         | `vX.Y.Z`, `X.Y`, `latest`, `sha-<short>`        |

## Option B — Clone and use the compose bundle

The compose bundle is the recommended deployment for the EU hosted variant.
It includes Caddy (TLS + reverse proxy), Postgres (for the hosted-mode
storage adapter), and an oauth2-proxy slot (auth gate ships in a sibling
issue under [VIB-446](/VIB/issues/VIB-446)).

```bash
git clone https://github.com/borismichel/vibespot.git
cd vibespot
cp .env.example .env
# Edit .env — at minimum set VIBESPOT_DOMAIN, VIBESPOT_TLS_EMAIL, and
# one AI API key.
docker compose up -d
```

On first boot Caddy will request a Let's Encrypt certificate for
`VIBESPOT_DOMAIN`. Visit `https://<your-domain>` and you should land on the
vibe-coding setup screen.

### Local testing

Set `VIBESPOT_DOMAIN=localhost` in `.env` to skip Let's Encrypt and serve
HTTP only:

```bash
echo "VIBESPOT_DOMAIN=localhost" >> .env
docker compose up -d
open http://localhost
```

### Enable the auth gate

The `oauth2-proxy` service is gated behind the `auth` compose profile.
When the upstream SSO/OIDC work lands, enable it with:

```bash
docker compose --profile auth up -d
```

Wire `OAUTH2_*` variables in `.env` to your IdP before flipping this on.

### Switch to Postgres storage

Set `VIBESPOT_STORAGE=postgres` in `.env`. The bundled `postgres` service is
always up; the env var tells vibespot to use the hosted storage adapter
instead of the filesystem default.

## Building locally

```bash
docker build -t vibespot:dev .
docker run --rm -p 4200:4200 vibespot:dev
```

The build is multi-stage (`node:22-alpine` builder + runtime). The final
image strips dev dependencies via `npm prune --omit=dev`.

## Operational notes

- **Healthcheck.** The container exposes `GET /healthz` (returns
  `{"status":"ok"}`). Docker uses it for the built-in `HEALTHCHECK`, and the
  CI smoke test polls it on every push.
- **Persistence.** Three named volumes are created by compose:
  `vibespot-config` (`~/.vibespot/` — API keys, sessions, project state),
  `vibespot-workspace` (theme working dirs), and `postgres-data`.
- **Ports.** Caddy publishes `:80` and `:443`. The vibespot service itself
  is internal-only when running via compose. For direct access without
  Caddy, expose `4200` on the `vibespot` service.
- **Image size.** Target is ≤ 200 MB; if a future dependency pushes us over,
  drop to `node:22-slim` instead of alpine.

## Troubleshooting

| Symptom                                     | Likely cause / fix                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `docker compose up` exits with port-in-use  | Something else owns `:80`/`:443`. Stop it, or override the published ports under `caddy:`.      |
| Healthcheck flaps                           | Container can't reach itself — check that `VIBESPOT_PORT` matches what Caddy proxies to.        |
| `/api/starters` returns `[]`                | Image build dropped `starters/`. Rebuild with the supplied `.dockerignore`.                     |
| Let's Encrypt certificate request fails     | Make sure ports 80/443 are reachable from the public internet and `VIBESPOT_DOMAIN` resolves.   |
| Generation fails with "no AI engine"        | No provider key set. Add `ANTHROPIC_API_KEY` (or another) to `.env` and `docker compose up -d`. |
