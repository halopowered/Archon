# Auto-resolve Dependabot PRs via Archon — webhook setup

This points a GitHub repo's Dependabot PRs at our Archon server, which runs the
`dependabot-pipeline` workflow on each one (validates install/build/test,
auto-merges patch/minor bumps, escalates the rest for human review).

## Endpoint

| Field | Value |
|---|---|
| **Payload URL** | `https://archon-sandbox.fly.dev:8443/dependabot` |
| **Content type** | `application/json` |
| **Secret** | the shared `GITHUB_WEBHOOK_SECRET` (get it from our team secret store / whoever runs the Archon deploy — **don't invent a new one**, it must match the server) |
| **Events** | "Let me select individual events" → **Pull requests** only |
| **SSL verification** | Enabled |
| **Active** | ✓ |

> ⚠️ Note the **`:8443`** port — it's not the default `443`. GitHub supports
> custom ports; just include it exactly. (Port `443` is the Archon web UI.)

## Step 0 — Prerequisite: the repo must be allow-listed on the server

The server only acts on repos in its `WEBHOOK_TARGET_REPOS` list (currently
**`halopowered/stack-artifacts`**). A webhook from any other repo is received
but **ignored** (`repo_not_configured`).

If your repo isn't on the list yet, ask the deploy owner to add it:

1. Add `owner/repo` to `WEBHOOK_TARGET_REPOS` in `fly.toml` (space-separated).
2. `fly deploy` — the entrypoint clones it into `/.archon/checkouts/<repo>`.
3. Confirm the server's `GH_TOKEN` has access to that repo (needs `repo` scope;
   for org repos it must be SSO-authorized).

Once the repo is allow-listed, proceed.

## Step 1 — Add the webhook

**Via the GitHub UI:** Repo → **Settings → Webhooks → Add webhook** → fill in the
table above → **Add webhook**.

**Or via the CLI** (replace `OWNER/REPO`; paste the secret when prompted, it
won't echo):

```bash
read -rsp "Webhook secret: " SECRET; echo
gh api -X POST repos/OWNER/REPO/hooks \
  -f "name=web" \
  -F "active=true" \
  -f "events[]=pull_request" \
  -f "config[url]=https://archon-sandbox.fly.dev:8443/dependabot" \
  -f "config[content_type]=json" \
  -f "config[secret]=$SECRET"
```

## Step 2 — Verify it's wired up

GitHub sends a `ping` immediately on save. Check **Settings → Webhooks → (your
hook) → Recent Deliveries** — the `ping` should show a green **✓ 200**.

Quick health check (no auth needed):

```bash
curl https://archon-sandbox.fly.dev:8443/dependabot/health    # → {"ok":true}
```

## What happens after that

- When Dependabot opens/reopens a PR, GitHub posts it to the server. The server
  verifies the signature, confirms it's a Dependabot PR for an allow-listed
  repo, and queues a pipeline run.
- Runs are **serial per repo** (one at a time; different repos run in parallel),
  each routed to that repo's checkout.
- Outcome per PR: **patch/minor that passes build+test → auto-merged**; anything
  that can't be safely auto-merged → left open and labeled **`archon-reviewed`**
  for a human.
- Only `opened`/`reopened` PR events trigger a run. The server's own actions are
  loop-suppressed (`sender == bot login`).

## Backlog (existing open PRs)

By default the server is **event-driven only** — it processes PRs as their
webhooks arrive, and does not touch the existing backlog of already-open
Dependabot PRs. To drain the backlog, the deploy owner sets
`WEBHOOK_DISCOVERY=1` in `fly.toml` and redeploys; the server then scans every
open Dependabot PR (minus those already labeled `archon-reviewed`) on boot and
after each run, draining them one at a time per repo.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Delivery shows **401** | Secret mismatch — re-enter the exact shared `GITHUB_WEBHOOK_SECRET`. |
| Delivery **200** but nothing runs, response `repo_not_configured` | Repo not in `WEBHOOK_TARGET_REPOS` — do Step 0. |
| Delivery **200**, response `not_dependabot` | The PR isn't Dependabot-authored (expected; only Dependabot PRs run). |
| `ping` never turns green / connection error | Check the `:8443` port is in the URL; confirm `curl …/dependabot/health` returns `{"ok":true}`. |
| Connection refused | Server may be redeploying — retry shortly; GitHub also auto-retries. |

## Reference

- Webhook server + dispatcher: `deploy/webhook-host/` (see `README.md`).
- The 5 pipeline workflows: `deploy/archon-workflows/`.
- Server filtering / env details: `deploy/webhook-host/servers/dependabot/server-readme.md`.
