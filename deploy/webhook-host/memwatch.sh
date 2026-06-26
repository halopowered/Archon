#!/usr/bin/env bash
# Memory watchdog — last-resort guard so the VM can never go OOM-unreachable.
#
# Why: the Dependabot pipeline runs `npm ci`/`poetry install` in worktrees to
# verify bumps. A single big install (e.g. an Angular monorepo) resides at
# ~1.8GB. On the 4GB Fly VM, two installs coexisting (a PR's verify + auto-fix
# step, or an un-reaped orphan) exhausts RAM and the OOM killer makes the whole
# box unreachable. Swap (fly.toml swap_size_mb) absorbs the normal spike; this
# watchdog is the floor below it: if combined headroom (free RAM + free swap)
# falls under the floor, kill ONLY the drain (sweep / pipeline / sub-runs /
# their npm·node·poetry children) — never the Archon server or webhook host —
# so the machine stays reachable. The drain is tag-based and resumable, so a
# killed PR is simply retried on the next sweep.
#
# Runs continuously (launched by docker-entrypoint.sh). Negligible cost: one
# `free`/`pgrep` every interval. Logs the trend to /.archon/memwatch.log.
LOG="${MEMWATCH_LOG:-/.archon/memwatch.log}"
FLOOR_MB="${MEMWATCH_FLOOR_MB:-900}"   # kill the drain below this combined headroom
INTERVAL="${MEMWATCH_INTERVAL:-5}"     # sample fast — webpack/Angular builds grow in seconds
: > "$LOG" 2>/dev/null || LOG=/tmp/memwatch.log
echo "$(date +%H:%M:%S) watchdog started (floor=${FLOOR_MB}MB headroom, interval=${INTERVAL}s)" >> "$LOG"
while :; do
  mem_avail=$(free -m | awk '/^Mem:/{print $7}')
  swap_free=$(free -m | awk '/^Swap:/{print $4}')
  headroom=$(( ${mem_avail:-0} + ${swap_free:-0} ))
  used=$(free -m | awk '/^Mem:/{print $3}')
  top=$(ps -eo rss,comm --sort=-rss | awk 'NR>1{printf "%s:%dM ",$2,$1/1024}' | head -c 110)
  echo "$(date +%H:%M:%S) headroom=${headroom}M (ram_avail=${mem_avail}M swap_free=${swap_free}M used=${used}M) top=[${top}]" >> "$LOG"
  if [ "${headroom:-99999}" -lt "$FLOOR_MB" ]; then
    echo "$(date +%H:%M:%S) !!! GUARD TRIPPED headroom=${headroom}M < ${FLOOR_MB}M — killing drain (server/host spared)" >> "$LOG"
    # Kill the drain process trees only. The bracket trick avoids self-match.
    # `node` + `webpack` are the real hogs: verify runs `npm run build`, which
    # for Angular/webpack spawns several ~1GB node workers. Killing npm does NOT
    # reap those detached node children, so they MUST be on this list or the box
    # stays pinned. Safe: the Archon server + webhook host run on `bun`, not
    # node, so no legitimate long-running node process exists to protect.
    pkill -9 -f "[s]weep-repo"        2>/dev/null
    pkill -9 -f "dependabot-pipeline" 2>/dev/null
    pkill -9 -f "workflow run"        2>/dev/null
    pkill -9 -x npm                   2>/dev/null
    pkill -9 -x node                  2>/dev/null
    pkill -9 -f "webpack"             2>/dev/null
    pkill -9 -x poetry                2>/dev/null
    pkill -9 -x claude                2>/dev/null
    echo "$(date +%H:%M:%S) drain killed; continuing to watch" >> "$LOG"
  fi
  sleep "$INTERVAL"
done
