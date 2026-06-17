# webhook-host

Runs an **arbitrary number of webhook listener servers** alongside Archon on the
same Fly machine. Each receives platform webhooks (e.g. GitHub) and drives the
`archon` CLI. `host.ts` is a supervisor + path-routing reverse proxy; each
`servers/<name>/` is one webhook server.

## Layout

```
host.ts                        # supervisor + dispatcher (bun), listens :9000
lib/archon-webhook.js          # shared runtime: HMAC, /health, per-repo serial
                               #   queue, multi-repo routing, run spawning,
                               #   backlog discovery — all the generic machinery
servers/<name>/
  webhook.json                 # { name, path, port, entry, env }
  server.js                    # thin TASK CONFIG: calls createArchonWebhookServer({...})
archon-workflows/  (sibling)   # ../archon-workflows: YAMLs copied to /.archon/workflows on boot
```

Each task server is a thin config on top of `lib/archon-webhook.js`. The library
owns everything generic; a task supplies only its decisions: `match()` (is this
delivery actionable + what's its identity), the `workflow` to run, and optional
`discover()` (backlog) / `onComplete()` (post-run) hooks.

## How requests flow

```
GitHub ──HTTPS──▶ Fly edge :8443 ──▶ host.ts :9000 ──path /<name>──▶ 127.0.0.1:<port>
                                          │
                                          └─ raw body + headers forwarded UNCHANGED
                                             (so the child's HMAC check still passes)
```

Fly exposes only `:8443 → 9000`. Child ports (e.g. 9101) are loopback-only.

## Adding a new webhook task

1. `mkdir servers/<name>/` and add a `webhook.json` with a unique `path` and
   `port` (≥ 9101):
   ```json
   { "name": "<name>", "path": "/<name>", "port": 9102, "entry": "server.js",
     "env": { "ARCHON_FROM_BRANCH": "main", "WEBHOOK_BIND_HOST": "127.0.0.1" } }
   ```
2. Add `servers/<name>/server.js` — a thin config using the shared library:
   ```js
   const { createArchonWebhookServer } = require('../../lib/archon-webhook');
   createArchonWebhookServer({
     name: '<name>',
     workflow: '<workflow-to-run>',
     match({ event, payload }) {
       // return { repo, key, meta? } to enqueue a run, or
       // { ignore: '<reason>', detail? } to 200-skip.
     },
     // optional: async discover(repo) { return [/* backlog keys */]; },
     // optional: async onComplete({ repo, key, dir }) { /* mark handled */ },
   });
   ```
   The library handles HMAC, `/health`, the per-repo serial queue, multi-repo
   routing, spawning `archon workflow run <workflow> <buildArg(key)>`, and
   backlog discovery (gated by `WEBHOOK_DISCOVERY`).
3. If it triggers workflows, drop their YAMLs in `../archon-workflows/`.
4. Add any new secrets via `fly secrets set …`.
5. `fly deploy`. The new task is live at `https://archon-sandbox.fly.dev:8443/<path>`.

No `host.ts`, `lib/`, or `fly.toml` change is needed — discovery is automatic.
See `servers/dependabot/server.js` for a complete worked example.

## Children inherit

`GH_TOKEN`, Claude OAuth, `DATABASE_URL`, and a `PATH` containing `archon`,
`gh`, `git`, `bun`, `node`/`npm`, `jq` — merged with the per-server `env` from
`webhook.json`. Triggered `archon` runs land in the shared Postgres, so they
appear in the same Archon web UI.

### How `archon` is invoked

The library spawns the workflow run via, in order of preference: `ARCHON_BIN`
(explicit override), else `bun <ARCHON_CLI_ENTRY>` (default
`/app/packages/cli/src/cli.ts` — the in-image CLI source, deterministic, no
dependency on the `archon` PATH wrapper), else `archon` on `PATH`. Each run is
a separate subprocess (crash isolation; mirrors Archon's own `--detach`).

## Servers

- **dependabot** (`/dependabot`, port 9101): filters Dependabot `pull_request`
  events and spawns `archon workflow run dependabot-pipeline <pr>`. See
  `servers/dependabot/server-readme.md`. Workflows: `dependabot-pipeline`,
  `dependabot-fix-check`, `readiness-check`, `verify-and-merge`,
  `auto-fix-install` (in `../archon-workflows/`).
