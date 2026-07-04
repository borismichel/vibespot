# Docker Deployment Guide

Run vibeSpot as a containerised service — expose the web UI to your team over LAN, VPN, or HTTPS.

Everything here works from the **public container image** alone. You do **not** need access to the source repository — just Docker and an AI API key.

## The image

vibeSpot is published to the GitHub Container Registry. The package is public, so no login is required to pull it:

```bash
docker pull ghcr.io/borismichel/vibespot:latest
```

Available tags:

| Tag | Points to |
|-----|-----------|
| `latest` | Most recent tagged release |
| `1.5.0`, `1.5` | Specific release / minor series |
| `v1.5.0` | Specific release (git tag form) |
| `main` | Latest commit on the main branch (may be unstable) |

Pin a specific version (e.g. `1.5.0`) for production so deploys are reproducible.

## Quick start — `docker run`

The fastest way to get a single instance up:

```bash
docker run -d --name vibespot \
  -p 4200:4200 \
  -e VIBESPOT_AI_ENGINE=anthropic-api \
  -e VIBESPOT_AGENTIC_MODE=true \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -v vibespot-config:/home/vibespot/.vibespot \
  -v vibespot-themes:/home/vibespot/vibespot-themes \
  ghcr.io/borismichel/vibespot:latest
```

The container binds beyond loopback, so the server requires a shared-secret token (VIB-1889). Grab the tokenized URL from the logs:

```bash
docker logs vibespot | grep token
#  v http://localhost:4200/?token=<48-hex-secret>
```

Open `http://<host-ip>:4200/?token=<secret>` in a browser — the token is exchanged for a session cookie on first load. Pin a stable secret with `-e VIBESPOT_AUTH_TOKEN=$(openssl rand -hex 24)`. Swap the engine/key pair for whichever provider you use (see [AI engine](#ai-engine)).

The two `-v` volumes keep your config and generated themes across restarts — see [Persistence](#persistence).

## Quick start — Docker Compose (LAN / VPN)

Create a `docker-compose.yml`:

```yaml
services:
  vibespot:
    image: ghcr.io/borismichel/vibespot:latest
    container_name: vibespot
    restart: unless-stopped
    ports:
      - "4200:4200"
    environment:
      VIBESPOT_AI_ENGINE: ${VIBESPOT_AI_ENGINE:-anthropic-api}
      VIBESPOT_AGENTIC_MODE: ${VIBESPOT_AGENTIC_MODE:-true}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
      LANGDOCK_API_KEY: ${LANGDOCK_API_KEY:-}
      HUBSPOT_PERSONAL_ACCESS_KEY: ${HUBSPOT_PERSONAL_ACCESS_KEY:-}
    volumes:
      - vibespot-config:/home/vibespot/.vibespot
      - vibespot-themes:/home/vibespot/vibespot-themes
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4200/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

volumes:
  vibespot-config:
  vibespot-themes:
```

Create a `.env` file next to it with the secrets you need:

```bash
# At least one AI key matching VIBESPOT_AI_ENGINE
ANTHROPIC_API_KEY=sk-ant-...

# Optional: pre-configure HubSpot uploads without using the UI
# HUBSPOT_PERSONAL_ACCESS_KEY=pat-...

# Optional: switch provider — anthropic-api | openai-api | gemini-api | langdock-api
# VIBESPOT_AI_ENGINE=anthropic-api
```

Then:

```bash
docker compose up -d
```

Open `http://<host-ip>:4200`. Compose automatically reads `.env` from the same directory.

## Quick start with HTTPS (Caddy)

For public or semi-public deployments, add a [Caddy](https://caddyserver.com/) reverse proxy that auto-provisions a Let's Encrypt TLS certificate.

**1.** Create a `Caddyfile` next to your compose file:

```caddyfile
{
	email you@example.com
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

**2.** Use this `docker-compose.yml` instead (vibeSpot is no longer published directly — only Caddy is):

```yaml
services:
  vibespot:
    image: ghcr.io/borismichel/vibespot:latest
    container_name: vibespot
    restart: unless-stopped
    environment:
      VIBESPOT_AI_ENGINE: ${VIBESPOT_AI_ENGINE:-anthropic-api}
      VIBESPOT_AGENTIC_MODE: ${VIBESPOT_AGENTIC_MODE:-true}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      HUBSPOT_PERSONAL_ACCESS_KEY: ${HUBSPOT_PERSONAL_ACCESS_KEY:-}
    volumes:
      - vibespot-config:/home/vibespot/.vibespot
      - vibespot-themes:/home/vibespot/vibespot-themes
    expose:
      - "4200"

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

**3.** Point your DNS A record at the host, set the domain + email in the `Caddyfile`, then:

```bash
docker compose up -d
```

HTTPS works automatically on ports 80/443. The `@websockets` block is required — vibeSpot's chat and generation pipeline run over a persistent WebSocket.

## Environment variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBESPOT_PORT` | `4200` | Port the vibeSpot server listens on inside the container |
| `VIBESPOT_NO_OPEN` | `1` (in Docker) | Suppress auto-open browser on startup |
| `VIBESPOT_HOST` | `0.0.0.0` (in Docker), `127.0.0.1` otherwise | Bind address. Any non-loopback bind turns on token auth |
| `VIBESPOT_AUTH_TOKEN` | generated at boot | Shared-secret access token for the UI, API and WebSocket. Empty → a random one is generated and printed in the container logs as part of the URL |
| `VIBESPOT_DISABLE_AUTH` | — | Set `1` **only** when a trusted auth proxy (e.g. the Entra SSO overlay) fronts vibeSpot. Turns off the built-in token gate |

### AI engine

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBESPOT_AI_ENGINE` | — | Default engine: `anthropic-api`, `openai-api`, `gemini-api`, `langdock-api` |
| `VIBESPOT_AGENTIC_MODE` | — | Set `true` to enable the multi-stage agentic pipeline (recommended) |
| `ANTHROPIC_API_KEY` | — | Anthropic Claude API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `GEMINI_API_KEY` | — | Google Gemini API key |
| `GOOGLE_AI_API_KEY` | — | Alternative Gemini key variable |
| `LANGDOCK_API_KEY` | — | Langdock EU gateway key (GDPR-compliant, Frankfurt) |
| `LANGDOCK_BASE_URL` | — | Override Langdock endpoint for self-hosted deployments |

Set `VIBESPOT_AI_ENGINE` to match whichever key you provide. EU teams with data-residency requirements can use `langdock-api`.

### Integrations

| Variable | Default | Description |
|----------|---------|-------------|
| `HUBSPOT_PERSONAL_ACCESS_KEY` | — | HubSpot PAK — enables theme upload without configuring through the UI |
| `FIGMA_TOKEN` | — | Figma personal access token for design import |

## Persistence

Two named Docker volumes keep data across container restarts and image upgrades:

| Volume | Container path | Contents |
|--------|---------------|----------|
| `vibespot-config` | `/home/vibespot/.vibespot` | `config.json`, session data |
| `vibespot-themes` | `/home/vibespot/vibespot-themes` | Generated HubSpot themes (one git repo per theme) |

> **Important:** mount the themes volume at exactly `/home/vibespot/vibespot-themes`. That is where the app writes generated themes (`$HOME/vibespot-themes`). Without this volume, themes are lost when the container is recreated.

To back up:

```bash
docker cp vibespot:/home/vibespot/.vibespot ./backup-config
docker cp vibespot:/home/vibespot/vibespot-themes ./backup-themes
```

## Upgrading

```bash
docker compose pull        # fetch the newer image
docker compose up -d       # recreate the container
```

Your data survives because it lives in the named volumes, not the container layer. Pin a tag (e.g. `:1.5.0`) if you want to control exactly when you move versions.

## Reverse proxy (nginx / Traefik / k8s Ingress)

If you already run a reverse proxy, skip Caddy and configure your own:

```nginx
# nginx example
server {
    listen 443 ssl;
    server_name vibespot.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://vibespot:4200;
        proxy_http_version 1.1;

        # WebSocket upgrade — required for the chat/generation pipeline
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # AI generation can take minutes
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
```

Key points for any reverse proxy:

- **WebSocket upgrade** is required — the chat, pipeline progress, and upload UI all use a persistent WebSocket connection.
- **Timeout > 120s** — agentic AI generation can run for several minutes. Set read/send timeouts to at least 300s.
- **No buffering** — for streaming AI responses, disable proxy buffering (`proxy_buffering off` in nginx).

### Kubernetes

A minimal single-instance deployment, pulling the public image:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vibespot
spec:
  replicas: 1   # single-instance — sessions are in-memory
  selector:
    matchLabels:
      app: vibespot
  template:
    metadata:
      labels:
        app: vibespot
    spec:
      containers:
        - name: vibespot
          image: ghcr.io/borismichel/vibespot:latest
          ports:
            - containerPort: 4200
          envFrom:
            - secretRef:
                name: vibespot-secrets
          volumeMounts:
            - name: config
              mountPath: /home/vibespot/.vibespot
            - name: themes
              mountPath: /home/vibespot/vibespot-themes
          livenessProbe:
            httpGet:
              path: /healthz
              port: 4200
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /healthz
              port: 4200
            initialDelaySeconds: 5
            periodSeconds: 10
      volumes:
        - name: config
          persistentVolumeClaim:
            claimName: vibespot-config
        - name: themes
          persistentVolumeClaim:
            claimName: vibespot-themes
---
apiVersion: v1
kind: Service
metadata:
  name: vibespot
spec:
  selector:
    app: vibespot
  ports:
    - port: 80
      targetPort: 4200
```

Create a Secret for your API keys:

```bash
kubectl create secret generic vibespot-secrets \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  --from-literal=VIBESPOT_AI_ENGINE=anthropic-api \
  --from-literal=VIBESPOT_AGENTIC_MODE=true
```

Use an Ingress or Gateway API resource with TLS termination pointing at the Service.

## Architecture notes

- **Single instance** — vibeSpot keeps active sessions in memory. Do not scale to multiple replicas behind a load balancer without sticky sessions.
- **Runs as non-root** — the container runs as the `vibespot` user. On Linux, named Docker volumes are chowned automatically; bind mounts must be writable by that user (see [Troubleshooting](#troubleshooting)).
- **Git inside the container** — git is bundled for the version history feature (auto-commit after each generation). Each theme directory is its own git repo.
- **No external database required** — sessions persist to the filesystem (`~/.vibespot/sessions/`). There is no Postgres or other datastore to run.
- **Health endpoint** — `GET /healthz` returns 200 once the server is ready; it backs the container `HEALTHCHECK` and the k8s probes.

## Security considerations

- **API keys** — never bake keys into a custom image. Pass them via `.env`, `-e` flags, or k8s Secrets.
- **Network exposure** — without HTTPS, vibeSpot serves plain HTTP. Only expose port 4200 on trusted networks (LAN, VPN, Tailscale).
- **CORS** — the server allows requests from `localhost`, `127.0.0.1`, and RFC 1918 / Tailscale IP ranges. Behind a same-origin reverse proxy, CORS is not a factor.
- **No built-in app login** — vibeSpot itself has no user accounts. For internet-facing deployments, gate it with the bundled Entra SSO overlay below (or your own authenticating proxy — Authelia, Cloudflare Access, etc.).

## Authentication gate — Azure Entra SSO (optional)

The compose bundle ships an opt-in SSO gate (`oauth2-proxy`) that puts an Azure Entra (Entra ID) login in front of the web UI **and** the chat WebSocket. It is **off by default** — a plain `docker compose up` runs exactly as before, ungated.

**1. Register an app in Entra.** In the Azure portal → *Entra ID → App registrations → New registration*, add a **Web** redirect URI of `https://<your-domain>/oauth2/callback`, then create a **client secret**.

**2. Fill in `.env`** (see the *Entra SSO* section of `.env.example`):

```bash
OAUTH2_PROVIDER=oidc
OAUTH2_ISSUER_URL=https://login.microsoftonline.com/<TENANT_ID>/v2.0   # tenant-scoped → only your org can sign in
OAUTH2_CLIENT_ID=<application (client) id>
OAUTH2_CLIENT_SECRET=<client secret value>
OAUTH2_REDIRECT_URL=https://<your-domain>/oauth2/callback
OAUTH2_COOKIE_SECRET=$(openssl rand -base64 32 | tr -- '+/' '-_')
OAUTH2_EMAIL_DOMAINS=yourcompany.com   # REQUIRED — empty = fail closed (nobody gets in)
```

**3. Start with the auth overlay** (the `--profile auth` flag is required — it activates the proxy):

```bash
docker compose --profile auth -f docker-compose.yml -f docker-compose.auth.yml up -d
```

The overlay re-points Caddy from `vibespot:4200` to `oauth2-proxy:4180`, so the request path becomes **Caddy (TLS) → oauth2-proxy (Entra OIDC) → vibespot**. Access is restricted twice: the tenant-scoped issuer limits sign-in to your org, and `OAUTH2_EMAIL_DOMAINS` filters which of those users get in. An out-of-org user is denied; an unauthenticated request is redirected to the Entra login.

Notes:
- **WebSocket** — the chat socket upgrade and its auth cookie are proxied through (`OAUTH2_PROXY_PROXY_WEBSOCKETS=true`), so vibe coding works end-to-end behind the gate.
- **Health checks** — `/healthz` is left unauthenticated (`OAUTH2_PROXY_SKIP_AUTH_ROUTES`) so external monitors get `200`, not a login redirect.
- **Fail closed** — forget `--profile auth` and compose refuses to start rather than serving ungated; if the proxy is down, Caddy returns 502, never an open door.
- This is a **gate only** — there is no per-user or per-theme isolation yet (every authorized user shares the same workspace).

## Troubleshooting

**Container starts but UI is unreachable**
- Check `docker logs vibespot` (or `docker compose logs vibespot`) for startup errors.
- Verify the port mapping: `docker ps` should show `0.0.0.0:4200->4200/tcp`.

**AI generation fails**
- Verify your key: `docker exec vibespot wget -qO- http://localhost:4200/api/settings/status`.
- Check that `VIBESPOT_AI_ENGINE` matches the key you provided.

**WebSocket disconnects behind a proxy**
- Ensure your reverse proxy forwards the `Upgrade` and `Connection` headers.
- Increase proxy timeouts to at least 300 seconds.

**Generated themes disappear after a restart**
- Confirm the themes volume is mounted at `/home/vibespot/vibespot-themes` (not `/workspace` or another path).

**Permission denied on volumes (bind mounts on Linux)**
- Named volumes work out of the box. For host bind mounts, make the directory writable by the container user: `sudo chown -R 100:101 ./data` (the `vibespot` user/group). Named volumes are recommended over bind mounts.
