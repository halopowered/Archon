# dependabot-webhook

Single-file Node receiver for GitHub `pull_request` webhooks. Filters Dependabot PRs and triggers the `dependabot-pipeline` Archon workflow for each one.

## What it does

Per incoming POST:

1. Verifies `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET`. Rejects with **401** on mismatch.
2. **Ping events** (sent when the webhook is first configured) → 200 OK, no action.
3. **Non-`pull_request` events** → 200 OK with `{ignored: true}`. (We respond 200 so GitHub doesn't retry.)
4. **`pull_request` events** with action other than `opened` / `reopened` / `synchronize` → 200 OK ignored.
5. **Self-induced events** (sender == this bot's GitHub login) → 200 OK ignored. Prevents loops when our pipeline's `gh api .../update-branch` call fires a `synchronize` event back at us.
6. **Dependabot PR + handled action + non-self sender** → spawns:
   ```
   archon workflow run dependabot-pipeline \
     --branch webhook/pipeline-pr-<N>-<timestamp> \
     --from $ARCHON_FROM_BRANCH \
     <N>
   ```
   detached, returns **202** immediately. The unique timestamp in the branch name avoids Archon's auto-resume from cached state across runs.

## Setup

Requires Node 18+ and `archon` on `PATH`.

```bash
cd SEARCH-24-auto-resolve-dependabot-prs/experiment/webhook

# Required: same secret you'll paste into GitHub's webhook config
export GITHUB_WEBHOOK_SECRET="<your-secret>"

# Run
node server.js
```

In a second terminal, tunnel:

```bash
ngrok http 3000
```

In GitHub → repo Settings → Webhooks → Add webhook:

- **Payload URL:** `https://<your-id>.ngrok-free.app/`
- **Content type:** `application/json`
- **Secret:** the same value as `$GITHUB_WEBHOOK_SECRET`
- **Events:** select **"Let me select individual events"** → just **Pull requests**
- **Active:** ✓

GitHub fires a `ping` event immediately. The server should log `GitHub ping — webhook is wired up correctly`.

## Optional env

| Var                  | Default                                           | Purpose                                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `3000`                                            | Listen port                                                                                                                                                                                                                         |
| `ARCHON_WORKDIR`     | dev worktree path                                 | CWD for the spawned archon process; must contain `.archon/workflows/dependabot-pipeline.yaml`                                                                                                                                       |
| `ARCHON_FROM_BRANCH` | `archon/task-build-workflow-dependabot-fix-check` | Branch the orchestrator's worktree starts from. After the workflows merge to `main`, change to `main` (or remove `--from` from `server.js`).                                                                                        |
| `WEBHOOK_BOT_LOGIN`  | auto-resolved via `gh api /user -q .login`        | GitHub login of the bot/user whose `GH_TOKEN` the pipeline acts under. Webhook events with `sender.login == WEBHOOK_BOT_LOGIN` are treated as self-induced and ignored. Set explicitly to skip the auto-resolve, or to override it. |

## Health check

`GET /health` → `{"ok": true}` — useful for ngrok-keepalive or LB probes.

## Operational notes

- The server **fires-and-forgets** archon. Pipeline progress is only visible via `archon`'s own logs, the worktree directory under `~/.archon/workspaces/...`, or by tailing the workflow run's artifacts.
- Each triggered run uses a unique `--branch webhook/pipeline-pr-<N>-<timestamp>` to bypass Archon's auto-resume of prior cached state.
- Each Dependabot PR action creates a new orchestrator worktree. Periodic cleanup recommended via `git worktree remove` from `~/.archon/workspaces/.../source/`.
- The webhook secret is the only authentication. Treat it like a password. Rotate by restarting the server with a new value (and updating GitHub).

## Failure modes

| Symptom                                | Cause                                              | Fix                                                                               |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| 401 on every request                   | secret mismatch between server and GitHub          | re-copy the same secret to both, restart server                                   |
| Pipeline never starts despite 202      | archon binary not on PATH for the spawned child    | ensure `archon` is in PATH; or set `ARCHON_BIN` (not yet implemented — see TODOs) |
| Pipeline runs but can't find workflows | `ARCHON_WORKDIR` doesn't have `.archon/workflows/` | set `ARCHON_WORKDIR` to the dev worktree, or merge workflows to main              |

## TODOs (out of scope for v1)

- Configurable `archon` binary path (`ARCHON_BIN` env)
- Persistence: log every accepted run to a file for audit
- Concurrency cap: today, every PR-event spawns an archon run; add a queue or limit
