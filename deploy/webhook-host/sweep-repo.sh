#!/usr/bin/env bash
# Tag-based, single-repo Dependabot backlog sweep.
#
# Processes every OPEN Dependabot PR in <owner/repo> that does NOT carry the
# processed label (default 'archon-reviewed'), ONE AT A TIME, tagging each
# still-open PR afterward so it isn't reprocessed. Stops when no untagged
# Dependabot PRs remain. Scoped to <owner/repo> ONLY — other repos are never
# touched. Idempotent and resumable: re-running picks up where it left off.
#
# This is the on-demand, single-repo counterpart to the webhook-host's
# automatic discovery (same tag semantics) — use it to drain one repo's
# backlog without enabling global WEBHOOK_DISCOVERY.
#
# Run on the Archon server as appuser, e.g.:
#   fly ssh console -a archon-sandbox -C \
#     "gosu appuser bash -lc 'nohup bash /app/deploy/webhook-host/sweep-repo.sh owner/repo \
#        > /.archon/sweep-owner-repo.log 2>&1 & echo started pid \$!'"
#   # then tail /.archon/sweep-owner-repo.log
#
# Usage: sweep-repo.sh <owner/repo>
# Env:   WEBHOOK_PROCESSED_LABEL (default archon-reviewed)
#        WEBHOOK_CHECKOUTS_DIR   (default /.archon/checkouts)
#        ARCHON_FROM_BRANCH      (default main)
set -uo pipefail

REPO="${1:?usage: sweep-repo.sh <owner/repo>}"
LABEL="${WEBHOOK_PROCESSED_LABEL:-archon-reviewed}"
CHECKOUTS_DIR="${WEBHOOK_CHECKOUTS_DIR:-/.archon/checkouts}"
FROM_BRANCH="${ARCHON_FROM_BRANCH:-main}"
CHECKOUT="$CHECKOUTS_DIR/${REPO##*/}"

# Ensure a checkout exists (clone on demand — lets the sweep run even before
# the repo is added to WEBHOOK_TARGET_REPOS).
if [ ! -d "$CHECKOUT/.git" ]; then
  echo "Cloning $REPO -> $CHECKOUT ..."
  mkdir -p "$CHECKOUTS_DIR"
  git clone "https://github.com/$REPO.git" "$CHECKOUT" || { echo "ERROR: clone failed"; exit 1; }
fi
cd "$CHECKOUT"

# Ensure the label exists so --add-label can't fail.
gh label create "$LABEL" --repo "$REPO" --color FBCA04 \
  --description "Handled by the Archon dependabot pipeline" >/dev/null 2>&1 || true

echo "Sweeping $REPO for untagged Dependabot PRs (label gate: '$LABEL')..."
processed=0
while :; do
  # Next OPEN Dependabot PR that lacks the processed label.
  pr=$(gh pr list --repo "$REPO" --author app/dependabot --state open \
         --json number,labels --limit 100 \
       | jq -r --arg L "$LABEL" \
         '[.[] | select(any(.labels[]?; .name == $L) | not)] | .[0].number // empty')

  if [ -z "$pr" ]; then
    echo "✅ $REPO: no untagged Dependabot PRs remain (processed $processed this run)."
    break
  fi

  echo "──────── ▶ $REPO PR #$pr ────────"
  archon workflow run dependabot-pipeline "$pr" --from "$FROM_BRANCH" \
    || echo "  (run errored — continuing to next PR)"

  # If the PR is still OPEN it wasn't auto-merged (escalated / failed) — tag it
  # so the next iteration skips it. Merged/closed PRs drop out naturally.
  state=$(gh pr view "$pr" --repo "$REPO" --json state -q .state 2>/dev/null || echo UNKNOWN)
  if [ "$state" = "OPEN" ]; then
    gh pr edit "$pr" --repo "$REPO" --add-label "$LABEL" >/dev/null \
      && echo "  PR #$pr still open → tagged '$LABEL'"
  else
    echo "  PR #$pr is $state"
  fi
  processed=$((processed + 1))
done
