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
  on `localhost`). The live preview is served from a second hostname,
  `preview.<your-domain>` by default, so point a DNS record at the host for
  that too (an extra A/CNAME record; Caddy provisions its certificate the
  same way).

## Option A — Pull the published image

The image is published to GHCR on every push to `main` and on every release tag:

```bash
docker pull ghcr.io/borismichel/vibespot:latest
docker run --rm -p 4200:4200 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  ghcr.io/borismichel/vibespot:latest
```

Open <http://localhost:4200> and the vibe-coding UI loads.

> **Private repo note:** The GitHub repo can be private while the GHCR
> package is public — GitHub decouples the two. A repo admin must toggle
> the package to public once (GitHub → Packages → vibespot → Settings →
> Change visibility → Public). The CI workflow includes a post-publish
> check that warns if the package reverts to private.

Tags published:

| Trigger              | Tag(s)                                          |
| -------------------- | ----------------------------------------------- |
| Push to `main`       | `main`, `sha-<short>`                           |
| Tag `vX.Y.Z`         | `vX.Y.Z`, `X.Y`, `latest`, `sha-<short>`        |

## Option B — Clone and use the compose bundle

The compose bundle is the recommended deployment for the EU hosted variant.
It includes Caddy (TLS + reverse proxy) and an optional Azure Entra SSO gate
(`oauth2-proxy`, off by default — see [Enable the auth gate](#enable-the-auth-gate) below).

```bash
git clone https://github.com/borismichel/vibespot.git
cd vibespot
cp .env.example .env
# Edit .env — at minimum set VIBESPOT_DOMAIN, VIBESPOT_TLS_EMAIL, and
# one AI API key.
docker compose up -d
```

On first boot Caddy will request Let's Encrypt certificates for
`VIBESPOT_DOMAIN` **and** `preview.<VIBESPOT_DOMAIN>` (the live-preview
origin — override the hostname with `VIBESPOT_PREVIEW_DOMAIN` if needed;
both need DNS records pointing at the host). Visit `https://<your-domain>`
and you should land on the vibe-coding setup screen.

### Local testing

Set `VIBESPOT_DOMAIN=localhost` in `.env` to skip Let's Encrypt and use
Caddy's locally-generated certificates:

```bash
echo "VIBESPOT_DOMAIN=localhost" >> .env
docker compose up -d
open https://localhost
```

The live preview loads from `https://preview.localhost` (browsers resolve
`*.localhost` to the loopback address). Because the local certificates are
signed by Caddy's own CA, the preview iframe will stay blank until the
browser trusts that certificate — either visit <https://preview.localhost>
once and accept the warning, or trust Caddy's root CA
(`docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt`).

### Enable the auth gate

The bundle ships an opt-in **Azure Entra (Entra ID) SSO gate** that puts a
login in front of the web UI *and* the chat WebSocket. It is off by default —
`docker compose up` runs ungated.

> ⚠️ **Use the `docker-compose.auth.yml` overlay — not `--profile auth` alone.**
> The profile only starts `oauth2-proxy`; it does **not** put it in the request
> path, so Caddy keeps serving vibespot **ungated**. The overlay re-points
> Caddy at the proxy (`Caddy → oauth2-proxy → vibespot`) and is fail-closed
> (compose refuses to start if you forget `--profile auth`).

```bash
docker compose --profile auth -f docker-compose.yml -f docker-compose.auth.yml up -d
```

Set the `OAUTH2_*` variables in `.env` first. Full step-by-step (Entra App
registration, redirect URI, client secret, tenant-scoped issuer, restricting
to your org) is in
[docs/docker-deployment.md → Authentication gate](docker-deployment.md#authentication-gate--azure-entra-sso-optional).

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
- **Persistence.** Two named volumes are created by compose:
  `vibespot-config` (`~/.vibespot/` — API keys, sessions, project state),
  and `vibespot-workspace` (theme working dirs). Postgres storage is not
  supported by this image; `VIBESPOT_STORAGE` and `DATABASE_URL` are ignored.
- **Ports.** Caddy publishes `:80` and `:443` and serves two hostnames: the
  app (`VIBESPOT_DOMAIN` → `vibespot:4200`) and the live-preview origin
  (`VIBESPOT_PREVIEW_DOMAIN`, default `preview.<VIBESPOT_DOMAIN>` →
  `vibespot:4202`; VIB-1933). The vibespot service itself is internal-only
  when running via compose. For direct access without Caddy, publish `4200`
  **and** `4202` on the `vibespot` service (the preview iframe loads from
  app port + 2).
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
| Preview pane blank / "live preview disabled" | The preview origin isn't reachable. Check DNS for `preview.<your-domain>`, that `VIBESPOT_PREVIEW_PUBLIC_ORIGIN` matches the Caddy preview site, and (localhost) that the browser trusts Caddy's local CA — see [Local testing](#local-testing). |
