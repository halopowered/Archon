#!/usr/bin/env bash
# Boot-time self-heal + continuous SERIAL drain for the Dependabot pipeline.
#
# WHY: the backlog sweeps are the only thing that drains EXISTING untagged
# Dependabot PRs, but they were launched by hand (nohup) and did NOT survive a
# crash/reboot — every restart left the drain silently stopped plus a pile of
# orphaned "running" run rows (their processes died with the box, but the
# Postgres rows persist). Launched by docker-entrypoint.sh on every boot (gated
# on WEBHOOK_AUTODRAIN), this makes the drain self-healing:
#   1. Abandon orphaned runs. At boot NOTHING is executing yet, so any run still
#      in 'running' is an orphan from the previous process generation — safe to
#      abandon before starting new work. (Only 'running'; 'paused' approval-gate
#      runs, if any, are left for a human.)
#   2. Drain each target repo SERIALLY — one repo's builds at a time. Concurrent
#      drains repeatedly tipped the 4GB box over (OOM, then an exit-1 crash);
#      serial keeps peak load to a single pipeline. Loop forever with an idle gap
#      so newly-opened Dependabot PRs get picked up on the next pass (tag-based,
#      so already-handled PRs are skipped and passes are cheap once drained).
#
# Gated OFF by default (WEBHOOK_AUTODRAIN unset) so a plain deploy never
# auto-merges; set WEBHOOK_AUTODRAIN=1 in fly.toml [env] to enable.
set -u
REPOS="${WEBHOOK_TARGET_REPOS:-halopowered/stack-artifacts}"
CHECKOUTS_DIR="/.archon/checkouts"
IDLE_BETWEEN_PASSES="${WEBHOOK_AUTODRAIN_IDLE:-300}"

log() { echo "[archon] auto-drain: $*"; }

# Wait until at least one checkout exists (the entrypoint clones them in the
# same background block that launches us).
for _ in $(seq 1 60); do
  ls -d "$CHECKOUTS_DIR"/*/.git >/dev/null 2>&1 && break
  sleep 5
done

# --- 1. Orphan cleanup (once, at boot) ------------------------------------
first_ck=$(ls -d "$CHECKOUTS_DIR"/*/ 2>/dev/null | head -1)
if [ -n "$first_ck" ]; then
  cd "$first_ck" || true
  ids=$(archon workflow status --json 2>/dev/null | jq -r '.runs[]? | select(.status=="running") | .id')
  n=0
  for id in $ids; do
    archon workflow abandon "$id" >/dev/null 2>&1 && n=$((n+1))
  done
  log "abandoned $n orphaned running run(s) from the previous process generation"
fi

# --- 2. Continuous serial drain -------------------------------------------
log "starting continuous serial drain of: $REPOS (idle ${IDLE_BETWEEN_PASSES}s between passes)"
while true; do
  for repo in $REPOS; do
    log "sweeping $repo"
    bash /app/deploy/webhook-host/sweep-repo.sh "$repo" \
      > "/.archon/sweep-${repo##*/}.log" 2>&1 \
      || log "sweep of $repo exited nonzero (continuing)"
  done
  log "full pass complete; idling ${IDLE_BETWEEN_PASSES}s"
  sleep "$IDLE_BETWEEN_PASSES"
done
