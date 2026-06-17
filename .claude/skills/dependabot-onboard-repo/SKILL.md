---
name: dependabot-onboard-repo
description: >-
  Add a new repository to the Archon Dependabot flow and drain its existing
  backlog of untouched Dependabot PRs — scoped to that ONE repo, without
  touching any other repo. Tag-based on the 'archon-reviewed' label (idempotent
  / resumable). Use when: "add a repo to the dependabot flow", "onboard
  <owner/repo>", "process the backlog for <repo>", "iterate through untouched
  dependabot PRs for one repo", "drain dependabot PRs for <repo> only".
---

# Onboard a repo into the Dependabot flow (+ one-time backlog sweep)

Two independent things: **ongoing** handling (webhook → pipeline as new PRs
open) and a **one-time backlog drain** of the PRs already open. The backlog
drain is **tag-based**: it processes only open Dependabot PRs that lack the
`archon-reviewed` label, and tags each still-open PR as it finishes — so it's
idempotent, resumable, and scoped to the single repo you name. It does NOT use
global `WEBHOOK_DISCOVERY` (which would sweep every configured repo), so other
repos are never touched.

App: `archon-sandbox` · webhook URL (shared by all repos, multiplexed by repo
name): `https://archon-sandbox.fly.dev:8443/dependabot`.

## Step 1 — Add the repo to the flow (ongoing)

Append `owner/repo` to `WEBHOOK_TARGET_REPOS` in `fly.toml` (space-separated),
then deploy. The entrypoint clones it to `/.archon/checkouts/<repo>` and the
webhook server will route its PRs.

```toml
# fly.toml [env]
WEBHOOK_TARGET_REPOS = 'halopowered/stack-artifacts owner/new-repo'
```

```bash
fly deploy --config fly.toml
```

Confirm the server's `GH_TOKEN` can read/merge that repo (private/org repos:
the PAT must have `repo` scope and, if SSO is enforced, be SSO-authorized).

## Step 2 — One-time tag-based backlog sweep (this repo only)

Run the sweep on the server (it loops open Dependabot PRs lacking
`archon-reviewed`, runs the pipeline on each, tags the still-open ones). It's
long-running, so launch it in the background and tail the log:

```bash
REPO=owner/new-repo; NAME=${REPO##*/}
fly ssh console -a archon-sandbox -C \
  "gosu appuser bash -lc 'nohup bash /app/deploy/webhook-host/sweep-repo.sh $REPO > /.archon/sweep-$NAME.log 2>&1 & echo started pid \$!'"

# monitor:
fly ssh console -a archon-sandbox -C "tail -n 40 /.archon/sweep-$NAME.log"
fly ssh console -a archon-sandbox -C "gosu appuser archon workflow runs --json"
```

Each PR is processed sequentially (one at a time — respects Archon's
per-codebase source-link constraint). Outcome per PR follows the normal policy:
safe bumps auto-merge; pre-existing build failures don't block (baseline check);
lint failures route to `auto-fix-lint`; anything left open is tagged
`archon-reviewed` so the sweep won't revisit it. Re-running the sweep later only
picks up newly-opened, still-untagged PRs.

## Step 3 — Add the GitHub webhook (ongoing) — do this LAST

Add it after the backlog sweep so live deliveries don't race the sweep on the
same repo. Use the shared webhook URL (see `deploy/webhook-host/SETUP.md` for
the full UI/CLI steps and the shared secret):

```bash
read -rsp "Webhook secret: " SECRET; echo
gh api -X POST repos/owner/new-repo/hooks \
  -f name=web -F active=true -f 'events[]=pull_request' \
  -f 'config[url]=https://archon-sandbox.fly.dev:8443/dependabot' \
  -f 'config[content_type]=json' -f "config[secret]=$SECRET"
```

## Notes

- **Scoped:** the sweep only ever touches the repo you pass; global discovery
  stays off (`WEBHOOK_DISCOVERY=0`).
- **Tag-based / resumable:** `archon-reviewed` marks "already handled." To
  re-process a PR a human cleared, remove that label and re-run the sweep.
- **Re-onboarding / re-sweeping** is safe — already-tagged or merged PRs are
  skipped.
- The sweep is the on-demand, single-repo counterpart to the webhook-host's
  automatic discovery; both share the same `archon-reviewed` tag semantics.
