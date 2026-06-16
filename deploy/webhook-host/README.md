# webhook-host

Runs an **arbitrary number of webhook listener servers** alongside Archon on the
same Fly machine. Each receives platform webhooks (e.g. GitHub) and drives the
`archon` CLI. `host.ts` is a supervisor + path-routing reverse proxy; each
`servers/<name>/` is one webhook server.

## Layout

```
host.ts                        # supervisor + dispatcher (bun), listens :9000
servers/<name>/
  webhook.json                 # { name, path, port, entry, env }
  server.js                    # the webhook server (any runtime bun can exec)
archon-workflows/  (sibling)   # ../archon-workflows: YAMLs copied to /.archon/workflows on boot
```

## How requests flow

```
GitHub ──HTTPS──▶ Fly edge :8443 ──▶ host.ts :9000 ──path /<name>──▶ 127.0.0.1:<port>
                                          │
                                          └─ raw body + headers forwarded UNCHANGED
                                             (so the child's HMAC check still passes)
```

Fly exposes only `:8443 → 9000`. Child ports (e.g. 9101) are loopback-only.

## Adding a new webhook server

1. `mkdir servers/<name>/`, add `server.js` (read `PORT`, `GITHUB_WEBHOOK_SECRET`,
   bind `127.0.0.1`) and `webhook.json` with a unique `path` and `port` (≥ 9101).
2. If it triggers workflows, drop their YAMLs in `../archon-workflows/`.
3. Add any new secrets via `fly secrets set …`.
4. `fly deploy`. The new server is live at `https://archon-sandbox.fly.dev:8443/<path>`.

No `host.ts` or `fly.toml` change is needed — discovery is automatic.

## Children inherit

`GH_TOKEN`, Claude OAuth, `DATABASE_URL`, and a `PATH` containing `archon`,
`gh`, `git`, `bun`, `node`/`npm`, `jq` — merged with the per-server `env` from
`webhook.json`. Triggered `archon` runs land in the shared Postgres, so they
appear in the same Archon web UI.

## Servers

- **dependabot** (`/dependabot`, port 9101): filters Dependabot `pull_request`
  events and spawns `archon workflow run dependabot-pipeline <pr>`. See
  `servers/dependabot/server-readme.md`. Workflows: `dependabot-pipeline`,
  `dependabot-fix-check`, `readiness-check`, `verify-and-merge`,
  `auto-fix-install` (in `../archon-workflows/`).
