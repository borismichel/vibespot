# Docker Deployment Guide

Run vibeSpot as a containerised service — expose the web UI to your team over LAN, VPN, or HTTPS.

## Quick start (LAN / VPN only)

```bash
cp .env.example .env
# Edit .env — set at least one AI API key (e.g. ANTHROPIC_API_KEY)
docker compose up -d
```

Open `http://<host-ip>:4200` in a browser.

## Quick start with HTTPS

For public or semi-public deployments, activate the Caddy reverse proxy profile. Caddy auto-provisions a TLS certificate from Let's Encrypt.

```bash
cp .env.example .env
# Edit .env — set your domain and at least one AI key:
#   VIBESPOT_DOMAIN=vibespot.example.com
#   ANTHROPIC_API_KEY=sk-ant-...
docker compose --profile https up -d
```

Caddy binds ports 80 and 443. Point your DNS A record at the host, and HTTPS works automatically.

## Environment variables

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBESPOT_PORT` | `4200` | Port the vibeSpot server listens on inside the container |
| `VIBESPOT_DOMAIN` | — | Public domain for the Caddy HTTPS profile |
| `VIBESPOT_NO_OPEN` | `1` (in Docker) | Suppress auto-open browser on startup |

### AI engine

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBESPOT_AI_ENGINE` | — | Default engine: `anthropic-api`, `openai-api`, `gemini-api`, `langdock-api` |
| `VIBESPOT_AGENTIC_MODE` | — | Set `true` to enable the multi-stage agentic pipeline |
| `ANTHROPIC_API_KEY` | — | Anthropic Claude API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `GEMINI_API_KEY` | — | Google Gemini API key |
| `GOOGLE_AI_API_KEY` | — | Alternative Gemini key variable |
| `LANGDOCK_API_KEY` | — | Langdock EU gateway key |
| `LANGDOCK_BASE_URL` | — | Override Langdock endpoint for self-hosted deployments |

### Integrations

| Variable | Default | Description |
|----------|---------|-------------|
| `HUBSPOT_PERSONAL_ACCESS_KEY` | — | HubSpot PAK — enables theme upload without configuring through the UI |
| `FIGMA_TOKEN` | — | Figma personal access token for design import |

## Persistence

Two named Docker volumes keep data across container restarts:

| Volume | Container path | Contents |
|--------|---------------|----------|
| `vibespot-config` | `/home/vibespot/.vibespot` | `config.json`, session data |
| `vibespot-themes` | `/home/vibespot/vibespot-themes` | Generated HubSpot themes |

To back up:

```bash
docker compose cp vibespot:/home/vibespot/.vibespot ./backup-config
docker compose cp vibespot:/home/vibespot/vibespot-themes ./backup-themes
```

## Reverse proxy (nginx / Traefik / k8s Ingress)

If you already have a reverse proxy, skip the Caddy profile and configure your own:

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
    }
}
```

Key points for any reverse proxy:

- **WebSocket upgrade** is required — the chat, pipeline progress, and upload UI all use a persistent WebSocket connection.
- **Timeout > 120s** — agentic AI generation can run for several minutes. Set read/send timeouts to at least 300s.
- **No buffering** — for streaming AI responses, disable proxy buffering (`proxy_buffering off` in nginx).

### Kubernetes

A minimal k8s deployment:

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
          image: vibespot:latest
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
- **Runs as non-root** — the container runs as user `vibespot` (UID 100). Volume permissions must allow this user to write.
- **Git inside the container** — git is installed for the version history feature (auto-commit after each generation). The theme volume is a git repo per theme.
- **No external database required** — the default filesystem storage adapter persists sessions to `~/.vibespot/sessions/`. A PostgreSQL adapter exists (`VIBESPOT_STORAGE_BACKEND=postgres`, `DATABASE_URL=postgres://...`) but is not yet wired into the Docker startup path.

## Security considerations

- **API keys** — never bake keys into the image. Pass them via `.env` file or k8s Secrets. The `.env` file is excluded from the Docker build via `.dockerignore`.
- **Network exposure** — without the HTTPS profile, vibeSpot serves plain HTTP. Only expose port 4200 on trusted networks (LAN, VPN, Tailscale).
- **CORS** — the server allows requests from `localhost`, `127.0.0.1`, and RFC 1918 / Tailscale IP ranges. Behind a reverse proxy with the same origin, CORS is not relevant (same-origin requests).
- **No authentication** — vibeSpot does not have built-in user authentication. For multi-user deployments, put an authenticating reverse proxy (e.g. OAuth2 Proxy, Authelia, Cloudflare Access) in front.

## Troubleshooting

**Container starts but UI is unreachable**
- Check `docker compose logs vibespot` for startup errors.
- Verify the port mapping: `docker compose ps` should show `0.0.0.0:4200->4200/tcp`.

**AI generation fails**
- Verify your API key: `docker compose exec vibespot wget -qO- http://localhost:4200/api/settings/status`.
- Check that `VIBESPOT_AI_ENGINE` matches the key you provided.

**WebSocket disconnects behind a proxy**
- Ensure your reverse proxy forwards the `Upgrade` and `Connection` headers.
- Increase proxy timeouts to at least 300 seconds.

**Permission denied on volumes**
- The container runs as UID 100. On Linux hosts, set ownership: `sudo chown -R 100:101 ./data`.
