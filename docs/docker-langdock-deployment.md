# vibeSpot Docker Deployment with Langdock

Technical reference for deploying vibeSpot as a Docker container using **Langdock** as the AI engine — a GDPR-compliant, EU-hosted (Frankfurt) gateway to Claude. Covers architecture, configuration, networking, and operations.

Everything here works from the **public container image** (`ghcr.io/borismichel/vibespot`) — no access to the source repository is required. For non-Langdock deployment details (other AI engines, k8s, generic reverse-proxy config), see [docker-deployment.md](./docker-deployment.md).

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│  Docker host                                            │
│                                                         │
│  ┌──────────┐         ┌───────────────┐                 │
│  │  Caddy   │────────▶│   vibeSpot    │                 │
│  │  :80/443 │         │   :4200       │                 │
│  └──────────┘         └───────┬───────┘                 │
│                               │                         │
└───────────────────────────────┼─────────────────────────┘
                                │ outbound HTTPS only
                   ┌────────────┴────────────┐
                   ▼                         ▼
        api.langdock.com            api.hubapi.com
        (AI generation)             (theme upload)
```

vibeSpot needs outbound HTTPS to exactly two external services:

| Service | Endpoint | Purpose |
|---------|----------|---------|
| **Langdock** | `https://api.langdock.com/anthropic` | AI generation — all prompts route through Langdock's Anthropic-compatible proxy in Frankfurt |
| **HubSpot** | `https://api.hubapi.com` | Theme upload — pushes generated modules and templates to your HubSpot portal |

No other outbound connectivity is required. The container accepts no inbound traffic except HTTP(S) from Caddy (or your own reverse proxy).

Sessions and generated themes persist to the container filesystem (on named Docker volumes) — there is **no database to run**.

---

## Prerequisites

- Docker 24+ with the `docker compose` plugin
- A Langdock API key ([langdock.com](https://langdock.com) — generate under API settings)
- A HubSpot Personal Access Key (`pat-...`) with CMS scope for theme uploads
- A public domain pointed at the host (production) or `localhost` (local testing)

You do **not** need to clone the repository — the deployment pulls the public image directly.

---

## Quick start

Create a working directory with two files.

**1.** `docker-compose.yml`:

```yaml
services:
  vibespot:
    image: ghcr.io/borismichel/vibespot:latest
    container_name: vibespot
    restart: unless-stopped
    environment:
      VIBESPOT_AI_ENGINE: langdock-api
      VIBESPOT_AGENTIC_MODE: "true"
      LANGDOCK_API_KEY: ${LANGDOCK_API_KEY:-}
      LANGDOCK_BASE_URL: ${LANGDOCK_BASE_URL:-}
      HUBSPOT_PERSONAL_ACCESS_KEY: ${HUBSPOT_PERSONAL_ACCESS_KEY:-}
    volumes:
      - vibespot-config:/home/vibespot/.vibespot
      - vibespot-themes:/home/vibespot/vibespot-themes
    expose:
      - "4200"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4200/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

  caddy:
    image: caddy:2-alpine
    container_name: vibespot-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - vibespot

volumes:
  vibespot-config:
  vibespot-themes:
  caddy-data:
  caddy-config:
```

**2.** `Caddyfile` (set your domain and email; use `localhost` for local-only testing — Caddy then skips Let's Encrypt):

```caddyfile
{
	email ops@example.com
}

vibespot.example.com {
	encode zstd gzip

	@websockets {
		header Connection *Upgrade*
		header Upgrade websocket
	}
	reverse_proxy @websockets vibespot:4200

	reverse_proxy vibespot:4200 {
		header_up Host {host}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto {scheme}
	}
}
```

**3.** `.env` with the secrets (Compose reads it automatically):

```bash
LANGDOCK_API_KEY=your-langdock-api-key
HUBSPOT_PERSONAL_ACCESS_KEY=pat-eu1-...
```

**4.** Start the stack:

```bash
docker compose up -d
```

Open `https://vibespot.example.com` (or `http://localhost` for local testing). The vibe-coding UI loads.

> **Skip Caddy for LAN-only:** if you don't need HTTPS, drop the `caddy` service, give `vibespot` a `ports: ["4200:4200"]` mapping instead of `expose`, and reach it at `http://<host-ip>:4200`.

---

## How Langdock is consumed

Langdock acts as a transparent proxy to Anthropic's Claude API, hosted in Frankfurt (eu-central-1). vibeSpot treats it as a drop-in replacement for direct Anthropic API calls.

**Request flow:**

1. vibeSpot's agentic pipeline (intent analysis, design system, module generation, quality check) builds standard Anthropic API requests.
2. The engine adapter swaps the base URL from `https://api.anthropic.com` to `https://api.langdock.com/anthropic`.
3. Langdock authenticates with your API key, forwards the request to Claude, and streams the response back.
4. Prompt caching, structured output (JSON schema), and extended thinking all work unchanged — Langdock's proxy is wire-compatible with the Anthropic Messages API.

**Default model:** `claude-sonnet-4-20250514`. Override via `LANGDOCK_API_MODEL` in the UI settings or `~/.vibespot/config.json`.

**Self-hosted Langdock:** If you run a private Langdock instance, set `LANGDOCK_BASE_URL` to your endpoint:

```bash
LANGDOCK_BASE_URL=https://langdock.internal.example.com/anthropic
```

---

## Environment variables

All variables are set in `.env` and passed to the vibeSpot container.

### Required

| Variable | Example | Description |
|----------|---------|-------------|
| `VIBESPOT_AI_ENGINE` | `langdock-api` | Selects Langdock as the AI engine |
| `LANGDOCK_API_KEY` | `ld-...` | Langdock API key |
| `HUBSPOT_PERSONAL_ACCESS_KEY` | `pat-eu1-...` | HubSpot PAK with CMS scope |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `LANGDOCK_BASE_URL` | `https://api.langdock.com/anthropic` | Override for self-hosted Langdock |
| `LANGDOCK_API_MODEL` | `claude-sonnet-4-20250514` | Override the Claude model |
| `VIBESPOT_AGENTIC_MODE` | `true` | Multi-stage agentic pipeline (recommended; set `false` for single-call mode) |
| `VIBESPOT_PORT` | `4200` | Internal container port |

TLS is configured directly in the `Caddyfile` (domain + email), not via environment variables.

---

## Compose services

The bundle above runs two services:

| Service | Image | Role |
|---------|-------|------|
| `vibespot` | `ghcr.io/borismichel/vibespot:latest` | App server — serves UI, runs AI pipeline, talks to HubSpot |
| `caddy` | `caddy:2-alpine` | TLS termination and reverse proxy (auto Let's Encrypt) |

### Persistent volumes

| Volume | Mount | Contents |
|--------|-------|----------|
| `vibespot-config` | `/home/vibespot/.vibespot` | API keys, sessions, project state |
| `vibespot-themes` | `/home/vibespot/vibespot-themes` | Generated theme working directories (one git repo each) |
| `caddy-data` | Caddy data dir | TLS certificates |
| `caddy-config` | Caddy config dir | Caddy runtime config |

> **Mount the themes volume at exactly `/home/vibespot/vibespot-themes`.** That is where the app writes generated themes (`$HOME/vibespot-themes`). Mounting elsewhere means themes are lost when the container is recreated.

> **Persistence is filesystem-only.** A Postgres storage adapter exists in the codebase but is not wired into the container startup path — `VIBESPOT_STORAGE` / `DATABASE_URL` have no effect today. Do not rely on them; use the named volumes above for durability.

---

## Production deployment

1. Point your DNS A record at the host; ports 80 and 443 must be reachable from the public internet.
2. Set your real domain and contact email in the `Caddyfile`.
3. Put secrets in `.env`:

```bash
LANGDOCK_API_KEY=your-key
HUBSPOT_PERSONAL_ACCESS_KEY=pat-eu1-...
```

4. Bring it up:

```bash
docker compose up -d
```

Caddy requests a Let's Encrypt certificate on first boot.

**Pin a version for production** so deploys are reproducible — replace `:latest` with a specific tag (e.g. `ghcr.io/borismichel/vibespot:1.5.0`).

### Upgrading

```bash
docker compose pull && docker compose up -d
```

Data survives upgrades because it lives in the named volumes, not the container layer.

---

## Firewall / network policy

If your host runs behind a corporate firewall or in a locked-down VPC, allow outbound HTTPS (port 443) to:

| Destination | CIDR / DNS | Notes |
|-------------|-----------|-------|
| Langdock API | `api.langdock.com` | Or your `LANGDOCK_BASE_URL` if self-hosted |
| HubSpot API | `api.hubapi.com` | Theme uploads and portal verification |
| GHCR | `ghcr.io` | One-time image pull (and on upgrades) |
| Let's Encrypt | `acme-v02.api.letsencrypt.org` | Only if using Caddy's auto-TLS on a public domain |

Inbound: only 80/443 to Caddy (or just 4200 if you skip Caddy).

---

## Health check

The container exposes `GET /healthz` returning `{"status":"ok"}`. Docker's built-in `HEALTHCHECK` polls it every 30 seconds. Monitor it from your orchestrator or uptime tool:

```bash
docker exec vibespot wget -qO- http://localhost:4200/healthz
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| "No AI engine configured" | `VIBESPOT_AI_ENGINE` not set or `LANGDOCK_API_KEY` missing. Add both, restart. |
| AI generation returns 401 | Langdock API key is invalid or expired. Regenerate at langdock.com. |
| Theme upload fails | `HUBSPOT_PERSONAL_ACCESS_KEY` missing or lacks CMS scope. Check HubSpot private app settings. |
| TLS certificate not provisioned | Ports 80/443 not reachable, or the domain in `Caddyfile` doesn't resolve to this host. |
| Container unhealthy | Check `docker logs vibespot`. Common cause: port conflict or missing env vars. |
| Generated themes disappear after restart | Themes volume not mounted at `/home/vibespot/vibespot-themes`. Verify the volume path. |
| WebSocket disconnects / chat hangs | Reverse proxy not forwarding `Upgrade`/`Connection` headers. The bundled Caddyfile handles this; custom proxies need the `@websockets` rule. |
