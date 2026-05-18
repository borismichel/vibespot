# vibeSpot Docker Deployment with Langdock

Technical reference for deploying vibeSpot as a Docker container using Langdock as the AI engine. Covers architecture, configuration, networking, and operations.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│  Docker host                                            │
│                                                         │
│  ┌──────────┐    ┌───────────────┐    ┌────────────┐    │
│  │  Caddy   │───▶│   vibeSpot    │───▶│  Postgres   │   │
│  │  :80/443 │    │   :4200       │    │  :5432      │   │
│  └──────────┘    └───────┬───────┘    └────────────┘    │
│                          │                              │
└──────────────────────────┼──────────────────────────────┘
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

---

## Prerequisites

- Docker 24+ with the `docker compose` plugin
- A Langdock API key ([langdock.com](https://langdock.com) — generate under API settings)
- A HubSpot Personal Access Key (`pat-...`) with CMS scope for theme uploads
- A public domain pointed at the host (production) or `localhost` (local testing)

---

## Quick start

```bash
git clone https://github.com/borismichel/vibespot.git
cd vibespot
cp .env.example .env
```

Edit `.env` with the minimum required variables:

```bash
# AI engine — Langdock routes Claude through a GDPR-compliant EU gateway
VIBESPOT_AI_ENGINE=langdock-api
LANGDOCK_API_KEY=your-langdock-api-key

# HubSpot — for uploading generated themes
HUBSPOT_PERSONAL_ACCESS_KEY=pat-eu1-...

# Domain — set to your public hostname, or localhost for local testing
VIBESPOT_DOMAIN=localhost
```

Start the stack:

```bash
docker compose up -d
```

Open `http://localhost` (or `https://<your-domain>` in production). The vibe-coding UI loads.

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

### Recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBESPOT_DOMAIN` | `localhost` | Public hostname — Caddy auto-provisions TLS via Let's Encrypt |
| `VIBESPOT_TLS_EMAIL` | *(none)* | Contact email for Let's Encrypt certificate notifications |
| `VIBESPOT_STORAGE` | `filesystem` | Set to `postgres` to use the bundled Postgres for session persistence |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `LANGDOCK_BASE_URL` | `https://api.langdock.com/anthropic` | Override for self-hosted Langdock |
| `VIBESPOT_AGENTIC_MODE` | `true` | Multi-stage agentic pipeline (recommended; set `false` for single-call mode) |
| `VIBESPOT_PORT` | `4200` | Internal container port |
| `POSTGRES_PASSWORD` | `vibespot` | Postgres password (change in production) |

---

## Compose services

The `docker-compose.yml` bundle includes four services:

| Service | Image | Role |
|---------|-------|------|
| `vibespot` | `ghcr.io/borismichel/vibespot:latest` | App server — serves UI, runs AI pipeline, talks to HubSpot |
| `postgres` | `postgres:16-alpine` | Session and theme file storage (activated by `VIBESPOT_STORAGE=postgres`) |
| `caddy` | `caddy:2-alpine` | TLS termination and reverse proxy (auto Let's Encrypt) |
| `oauth2-proxy` | `oauth2-proxy:v7.6.0` | Auth gate (disabled by default; enable with `--profile auth`) |

### Persistent volumes

| Volume | Mount | Contents |
|--------|-------|----------|
| `vibespot-config` | `~/.vibespot/` | API keys, sessions, project state |
| `vibespot-workspace` | `/workspace` | Theme working directories |
| `postgres-data` | Postgres data dir | Database files |
| `caddy-data` | Caddy data dir | TLS certificates |

---

## Production deployment

For a public-facing deployment with automatic TLS:

```bash
# .env
VIBESPOT_AI_ENGINE=langdock-api
LANGDOCK_API_KEY=your-key
HUBSPOT_PERSONAL_ACCESS_KEY=pat-eu1-...
VIBESPOT_DOMAIN=vibespot.example.com
VIBESPOT_TLS_EMAIL=ops@example.com
VIBESPOT_STORAGE=postgres
POSTGRES_PASSWORD=a-strong-password-here
```

```bash
docker compose up -d
```

Caddy requests a Let's Encrypt certificate on first boot. Ports 80 and 443 must be reachable from the public internet.

---

## Firewall / network policy

If your host runs behind a corporate firewall or in a locked-down VPC, allow outbound HTTPS (port 443) to:

| Destination | CIDR / DNS | Notes |
|-------------|-----------|-------|
| Langdock API | `api.langdock.com` | Or your `LANGDOCK_BASE_URL` if self-hosted |
| HubSpot API | `api.hubapi.com` | Theme uploads and portal verification |
| Let's Encrypt | `acme-v02.api.letsencrypt.org` | Only if using Caddy's auto-TLS on a public domain |

No other outbound destinations are needed. Inbound: only 80/443 to Caddy (or just 4200 if you skip Caddy).

---

## Health check

The container exposes `GET /healthz` returning `{"status":"ok"}`. Docker's built-in `HEALTHCHECK` polls it every 30 seconds. Monitor it from your orchestrator or uptime tool:

```bash
curl -sf http://localhost:4200/healthz
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| "No AI engine configured" | `VIBESPOT_AI_ENGINE` not set or `LANGDOCK_API_KEY` missing. Add both to `.env`, restart. |
| AI generation returns 401 | Langdock API key is invalid or expired. Regenerate at langdock.com. |
| Theme upload fails | `HUBSPOT_PERSONAL_ACCESS_KEY` missing or lacks CMS scope. Check HubSpot private app settings. |
| TLS certificate not provisioned | Ports 80/443 not reachable, or `VIBESPOT_DOMAIN` doesn't resolve to this host. |
| Container unhealthy | Check `docker logs vibespot`. Common cause: port conflict or missing env vars. |
| Postgres connection refused | Postgres container not ready yet. It starts with a health check — vibeSpot waits automatically. |
