#!/usr/bin/env bash
# Authorize teammate email(s) to log into the Archon web UI by appending them
# to ARCHON_AUTH_ALLOWED_EMAILS (the Better Auth signup allowlist).
#
# Usage: add-user.sh <email> [email ...]
# Env:   ARCHON_FLY_APP   Fly app name (default: archon-sandbox)
set -euo pipefail

APP="${ARCHON_FLY_APP:-archon-sandbox}"

if [ "$#" -lt 1 ]; then
  echo "usage: add-user.sh <email> [email ...]" >&2
  exit 2
fi

# 1. Read the CURRENT allowlist from the running machine. `fly secrets` can't
#    read a value back, but the secret is injected as an env var in-container.
echo "Reading current allowlist from $APP ..."
current=$(fly ssh console -a "$APP" -C "printenv ARCHON_AUTH_ALLOWED_EMAILS" 2>/dev/null | tr -d '\r' | tail -1 || true)
case "$current" in
  *@*) : ;;             # looks like at least one email
  *)   current="" ;;    # unset/empty/garbage → treat as empty
esac
echo "  current: ${current:-<empty>}"

# 2. Merge current + new, trim, drop blanks, lowercase, de-dupe, re-join.
new_emails="$(IFS=,; echo "$*")"
merged=$(printf '%s,%s\n' "$current" "$new_emails" \
  | tr ',' '\n' \
  | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' \
  | sed '/^$/d' \
  | awk '{print tolower($0)}' \
  | awk '!seen[$0]++' \
  | paste -sd, -)
echo "  merged:  $merged"

# 3. Set the secret (triggers a rolling restart so the new env takes effect).
echo "Setting ARCHON_AUTH_ALLOWED_EMAILS on $APP (this restarts the app)..."
fly secrets set -a "$APP" "ARCHON_AUTH_ALLOWED_EMAILS=$merged"

cat <<EOF

✅ Allowlist updated. Tell the teammate(s) to:
   1. Open https://${APP}.fly.dev
   2. Sign up with the exact allow-listed email + a password they choose
   3. They're in (later visits just log in)

Verify signup posture:
   curl -s https://${APP}.fly.dev/api/auth/status   # expect {"enabled":true,"signup":"allowlist"}
EOF
