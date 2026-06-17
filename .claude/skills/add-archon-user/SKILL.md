---
name: add-archon-user
description: >-
  Authorize a teammate to log into the Archon web UI (the Fly deployment at
  archon-sandbox.fly.dev). Use when someone wants to add/invite a new user,
  let a teammate sign in, grant web access, or manage the login allowlist.
  Triggers: "add a user", "authorize <email>", "let <person> log in", "invite
  a teammate to archon", "give access to the web UI", "add to the allowlist",
  "remove a user / revoke access".
---

# Add an authorized Archon web user

The Archon web UI uses Better Auth with an **invite allowlist**: only emails in
`ARCHON_AUTH_ALLOWED_EMAILS` can sign up. To let a teammate in, add their email
to that list, then they self-register with a password of their choice.

Key facts:
- The allowlist is a **Fly secret** (`ARCHON_AUTH_ALLOWED_EMAILS`), not in the
  repo — so teammate emails aren't exposed in the public fork.
- `fly secrets` can't read a value back, but the secret is injected as an env
  var in the running machine, so the current list **is** readable via
  `fly ssh console -C "printenv ARCHON_AUTH_ALLOWED_EMAILS"`. The helper script
  uses this to append without clobbering existing entries.
- Setting the secret triggers a rolling restart (~30s). The allowlist gates
  **signup only** — existing logged-in users are unaffected.
- App: `archon-sandbox` · URL: `https://archon-sandbox.fly.dev` (override the
  app with `ARCHON_FLY_APP`).

## Add a user

Run the helper (idempotent — merges + de-dupes, case-insensitive):

```bash
bash .claude/skills/add-archon-user/scripts/add-user.sh teammate@example.com [more@example.com ...]
```

It reads the current allowlist from the running machine, appends the new
email(s), and `fly secrets set`s the merged list (triggering a restart).

Then verify and brief the teammate:

```bash
curl -s https://archon-sandbox.fly.dev/api/auth/status     # → {"enabled":true,"signup":"allowlist"}
```

Tell the teammate:
1. Go to **https://archon-sandbox.fly.dev**.
2. Sign up with the **exact email** you allow-listed + a password they choose.
   (Non-listed emails get a 403 "not on the invite allowlist".)
3. They're in — subsequent visits just log in.

## Remove a user / revoke signup

Re-set the list without that email (read current, drop it, set):

```bash
APP=archon-sandbox
current=$(fly ssh console -a "$APP" -C "printenv ARCHON_AUTH_ALLOWED_EMAILS" 2>/dev/null | tr -d '\r' | tail -1)
# remove someone@example.com:
new=$(echo "$current" | tr ',' '\n' | grep -vix "someone@example.com" | paste -sd, -)
fly secrets set -a "$APP" "ARCHON_AUTH_ALLOWED_EMAILS=$new"
```

Note: removing an email blocks **new** signups for it; an already-issued
session stays valid until it expires. To force them out immediately, also
revoke their session in the DB (out of scope here).

## If something's off

- `signup` is `disabled` (not `allowlist`) in `/api/auth/status` → the
  allowlist ended up empty, or web auth isn't enabled. Confirm
  `ARCHON_AUTH_ALLOWED_EMAILS` is non-empty and `BETTER_AUTH_SECRET` +
  `DATABASE_URL` (Postgres) are set.
- Teammate gets 403 on signup → their email isn't an exact (case-insensitive)
  match for a list entry; re-run the add script with the exact address.
- `fly ssh console` can't connect → the machine may be mid-restart; wait and retry.
