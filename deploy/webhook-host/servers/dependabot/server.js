#!/usr/bin/env node
// dependabot-webhook
//
// Tiny HTTP receiver for GitHub `pull_request` webhooks. Verifies the
// GitHub HMAC-SHA256 signature, filters to Dependabot-authored PRs, and
// fires off an `archon workflow run dependabot-pipeline ...` in the
// background for each one.
//
// Required env:
//   GITHUB_WEBHOOK_SECRET   — the secret you configured on the GitHub
//                             webhook page; payloads are HMAC-verified
//                             against this.
// Optional env:
//   PORT                    — listen port, default 3000
//   ARCHON_WORKDIR          — CWD for the spawned archon process. Must be
//                             a directory where the dependabot-pipeline
//                             workflow YAML is discoverable. Defaults to
//                             the dev worktree path.
//   ARCHON_FROM_BRANCH      — value passed to `archon workflow run --from`
//                             so the orchestrator's worktree starts from a
//                             branch that has the workflow YAMLs.
//                             Defaults to the dev branch. Once the
//                             workflows are merged to `main`, set this to
//                             `main` (or change the code to omit --from).
//   WEBHOOK_BOT_LOGIN       — GitHub login of the user whose token the
//                             pipeline workflows act under. When the
//                             webhook receives a `pull_request` event whose
//                             `sender.login` equals this, the event is
//                             treated as self-induced and the pipeline is
//                             NOT respawned. Prevents loops when the
//                             pipeline calls `update-branch` (which fires
//                             a `synchronize` event). If unset, the server
//                             auto-resolves it at startup via
//                             `gh api /user -q .login`. Set explicitly to
//                             skip that lookup.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 3000;
// Loopback by default: the webhook-host dispatcher is the only thing that
// should reach this child. Fly exposes only the dispatcher's port (9000),
// never the child ports, but binding 127.0.0.1 is defense in depth.
const BIND_HOST = process.env.WEBHOOK_BIND_HOST || '127.0.0.1';
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
// Multi-repo routing. Each incoming PR is run against a git checkout of ITS
// own repo (cwd for the spawned `archon`), so `archon workflow run`
// auto-registers the right repo and finds the globally-discovered workflows.
// The entrypoint clones each WEBHOOK_TARGET_REPOS entry into
// CHECKOUTS_DIR/<repo-name>. Set WEBHOOK_TARGET_REPOS in fly.toml [env].
const CHECKOUTS_DIR = process.env.WEBHOOK_CHECKOUTS_DIR || '/.archon/checkouts';
const TARGET_REPOS = new Set(
  (process.env.WEBHOOK_TARGET_REPOS || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
// Legacy single-repo fallback: only used when no allowlist is configured.
const ARCHON_WORKDIR = process.env.ARCHON_WORKDIR || '';
const FROM_BRANCH = process.env.ARCHON_FROM_BRANCH || 'main';
const LOG_DIR = process.env.WEBHOOK_LOG_DIR ||
  path.join(__dirname, 'logs');

// Resolve the working directory (a git checkout) for an incoming repo.
// Returns { dir } on success, or { error } when the repo isn't allowlisted or
// has no checkout on disk. With no allowlist + an explicit ARCHON_WORKDIR, it
// falls back to that single dir (legacy single-repo mode).
function workdirForRepo(repoFullName) {
  if (!repoFullName || repoFullName === 'unknown') return { error: 'unknown_repo' };
  if (TARGET_REPOS.size > 0 && !TARGET_REPOS.has(repoFullName.toLowerCase())) {
    return { error: 'repo_not_configured' };
  }
  const name = repoFullName.split('/')[1];
  const dir = name ? path.join(CHECKOUTS_DIR, name) : null;
  if (dir && fs.existsSync(path.join(dir, '.git'))) return { dir };
  if (TARGET_REPOS.size === 0 && ARCHON_WORKDIR) return { dir: ARCHON_WORKDIR };
  return { error: 'no_checkout' };
}

fs.mkdirSync(LOG_DIR, { recursive: true });

if (!SECRET) {
  console.error('ERROR: GITHUB_WEBHOOK_SECRET environment variable is required.');
  console.error('Set it to the secret you configured on the GitHub webhook page.');
  process.exit(1);
}

// Resolve the GitHub login of the bot/user whose token the pipeline runs
// under. Used to suppress self-induced webhook events (e.g. our own
// `update-branch` call firing a `synchronize` event back to us).
function resolveSelfLogin() {
  if (process.env.WEBHOOK_BOT_LOGIN) {
    return process.env.WEBHOOK_BOT_LOGIN.trim();
  }
  try {
    const result = spawnSync('gh', ['api', '/user', '-q', '.login'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // gh missing or not authed — caller logs and continues
  }
  return null;
}
const SELF_LOGIN = resolveSelfLogin();

const DEPENDABOT_LOGINS = new Set([
  'dependabot[bot]',
  'app/dependabot',
  'dependabot',
]);
const HANDLED_ACTIONS = new Set(['opened', 'reopened']);

// Testing aid: when set, `reopened` events whose sender is this bot are NOT
// suppressed, so you can manually reopen a Dependabot PR to trigger the
// pipeline. Loop protection for `synchronize` (the `update-branch` echo)
// is unaffected. Unset/remove this for normal operation.
const ALLOW_SELF_REOPEN = process.env.WEBHOOK_ALLOW_SELF_REOPEN === '1';

// Boot sweep: when set, on startup the server kicks off ONE pipeline run in
// "all" mode, which sequentially processes every open Dependabot PR for the
// target repo (the checkout at ARCHON_WORKDIR). Useful for catching PRs that
// opened while the server was down. A single sequential run (not N concurrent
// runs) avoids the per-codebase source-link contention. NOTE: this fires on
// EVERY start, including launchd auto-restarts — leave off unless you want a
// full sweep each boot.
const SWEEP_ON_BOOT = process.env.WEBHOOK_SWEEP_ON_BOOT === '1';

function verifySignature(payload, signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const [algo, sig] = signatureHeader.split('=');
  if (algo !== 'sha256' || !sig) return false;
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(payload);
  const expected = hmac.digest('hex');
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Each run uses a unique branch, so Archon creates a fresh worktree and
// auto-registers the codebase by repointing
//   ~/.archon/workspaces/<owner>/<repo>/source
// at THIS run's worktree. A leftover symlink from a prior run makes
// registration fail ("Source symlink ... already points to ..., expected
// ..."), which blocks every run after the first. Archon recreates the
// link on registration, so removing the stale one lets each run start
// clean. Only touch it when it's a symlink we can safely drop.
//
// NOTE: this resolves the common serial case (one run at a time). Truly
// concurrent runs of the same repo still contend for the single source
// link — Archon's per-codebase source model can't isolate those.
function clearStaleArchonSource(repoFullName) {
  if (!repoFullName || repoFullName === 'unknown') return;
  const link = path.join(
    os.homedir(), '.archon', 'workspaces', repoFullName, 'source');
  try {
    if (fs.lstatSync(link).isSymbolicLink()) {
      fs.unlinkSync(link);
      console.log(`  cleared stale Archon source link: ${link}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`  could not clear Archon source link (${link}): ${err.message}`);
    }
  }
}

// Resolve owner/repo of the checkout at `workdir`. Used by the boot sweep to
// scope the source-link cleanup and for logging.
function resolveTargetRepo(workdir) {
  try {
    const r = spawnSync(
      'gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { cwd: workdir, encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {
    // gh missing/unauthed — caller logs and skips the sweep
  }
  return null;
}

// Spawn one detached `dependabot-pipeline` run in `workdir` (the target repo's
// checkout). `argument` is what the workflow classifies — a PR number (single
// PR) or "all" (sweep every open Dependabot PR). `label` names the branch/log.
function triggerPipeline(argument, repoFullName, workdir, label) {
  // Clear the prior run's source registration so Archon re-registers this
  // run's worktree without a symlink conflict.
  clearStaleArchonSource(repoFullName);

  const slug = label || `pr-${argument}`;
  const branch = `webhook/pipeline-${slug}-${Date.now()}`;
  const args = [
    'workflow', 'run', 'dependabot-pipeline',
    '--branch', branch,
    '--from', FROM_BRANCH,
    String(argument),
  ];
  // One log file per spawned run; safe filename (no slashes) and easy to tail.
  const logFile = path.join(LOG_DIR, branch.replace(/\//g, '_') + '.log');
  const logFd = fs.openSync(logFile, 'a');
  fs.writeSync(logFd,
    `\n=== ${new Date().toISOString()} ` +
    `[${repoFullName}] ${slug} (cwd ${workdir}) → archon ${args.join(' ')} ===\n`);

  console.log(`[${repoFullName}] ${slug}: spawning (cwd ${workdir}) archon ${args.join(' ')}`);
  console.log(`  log: ${logFile}`);

  const child = spawn('archon', args, {
    cwd: workdir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  return { branch, logFile };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return reply(res, 200, { ok: true });
  }
  if (req.method !== 'POST') {
    return reply(res, 405, { error: 'method_not_allowed' });
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);

    if (!verifySignature(raw, req.headers['x-hub-signature-256'])) {
      console.warn('Rejected: invalid or missing X-Hub-Signature-256');
      return reply(res, 401, { error: 'invalid_signature' });
    }

    const event = req.headers['x-github-event'];
    if (event === 'ping') {
      console.log('GitHub ping — webhook is wired up correctly');
      return reply(res, 200, { ok: true, event: 'ping' });
    }
    if (event !== 'pull_request') {
      console.log(`Ignoring event: ${event}`);
      return reply(res, 200, { ignored: true, reason: 'not_pull_request_event', event });
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply(res, 400, { error: 'invalid_json' });
    }

    const action = payload.action;
    const pr = payload.pull_request;
    const repo = (payload.repository && payload.repository.full_name) || 'unknown';

    if (!HANDLED_ACTIONS.has(action)) {
      console.log(`[${repo}] Ignoring PR action: ${action}`);
      return reply(res, 200, { ignored: true, reason: 'unhandled_action', action });
    }

    // Self-induced event suppression. When our pipeline calls
    // `update-branch` against a Dependabot PR, GitHub creates a merge
    // commit on the PR head and fires a `synchronize` event back at us.
    // The PR author is still Dependabot, so the existing author check
    // doesn't help — but `sender.login` is the user whose token initiated
    // the action. If that's us, ignore the event.
    const sender = payload.sender && payload.sender.login;
    const selfReopenAllowed = ALLOW_SELF_REOPEN && action === 'reopened';
    if (selfReopenAllowed && sender === SELF_LOGIN) {
      console.log(
        `[${repo}] PR #${pr && pr.number}: sender '${sender}' is this bot but ` +
        `WEBHOOK_ALLOW_SELF_REOPEN=1 — not suppressing reopened event (testing)`);
    }
    if (SELF_LOGIN && sender === SELF_LOGIN && !selfReopenAllowed) {
      console.log(
        `[${repo}] PR #${pr && pr.number}: sender '${sender}' is this bot — ` +
        `suppressing self-induced ${action} event`);
      return reply(res, 200, {
        ignored: true,
        reason: 'self_triggered_event',
        sender,
        action,
      });
    }

    const author = pr && pr.user && pr.user.login;
    if (!DEPENDABOT_LOGINS.has(author)) {
      console.log(`[${repo}] PR #${pr && pr.number}: author '${author}' is not Dependabot — ignoring`);
      return reply(res, 200, { ignored: true, reason: 'not_dependabot', author });
    }

    // Route to THIS repo's checkout. 200 (not 4xx) on a miss so GitHub doesn't
    // retry — a misconfigured/unknown repo is a config issue, not transient.
    const resolved = workdirForRepo(repo);
    if (resolved.error) {
      console.warn(`[${repo}] PR #${pr && pr.number}: ${resolved.error} — ignoring`);
      return reply(res, 200, { ignored: true, reason: resolved.error, repo });
    }

    const { branch, logFile } = triggerPipeline(pr.number, repo, resolved.dir);
    return reply(res, 202, {
      accepted: true,
      pr: pr.number,
      title: pr.title,
      repo,
      action,
      branch,
      log_file: logFile,
    });
  });

  req.on('error', (err) => {
    console.error('Request error:', err.message);
    reply(res, 500, { error: 'request_error' });
  });
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`dependabot-webhook listening on http://${BIND_HOST}:${PORT}`);
  const repoList = TARGET_REPOS.size > 0 ? [...TARGET_REPOS].join(', ') : `(none — fallback ${ARCHON_WORKDIR || 'unset'})`;
  console.log(`  target repos:      ${repoList}`);
  console.log(`  checkouts dir:     ${CHECKOUTS_DIR}`);
  console.log(`  --from branch:     ${FROM_BRANCH}`);
  console.log(`  log dir:           ${LOG_DIR}`);
  if (SELF_LOGIN) {
    console.log(`  self login:        ${SELF_LOGIN} (events from this user will be suppressed)`);
  } else {
    console.log(`  self login:        (unresolved — set WEBHOOK_BOT_LOGIN to enable self-event suppression)`);
  }
  if (ALLOW_SELF_REOPEN) {
    console.log(`  self-reopen:       ALLOWED (WEBHOOK_ALLOW_SELF_REOPEN=1 — testing; reopened events from self are NOT suppressed)`);
  }
  console.log(`  boot sweep:        ${SWEEP_ON_BOOT ? 'ON (WEBHOOK_SWEEP_ON_BOOT=1 — sweeps all open Dependabot PRs each start)' : 'off'}`);
  console.log(`  health endpoint:   http://${BIND_HOST}:${PORT}/health`);

  // Boot sweep: one sequential "all" run per configured repo checkout.
  if (SWEEP_ON_BOOT) {
    const repos = TARGET_REPOS.size > 0
      ? [...TARGET_REPOS]
      : (ARCHON_WORKDIR ? [resolveTargetRepo(ARCHON_WORKDIR)].filter(Boolean) : []);
    if (repos.length === 0) {
      console.warn('Boot sweep enabled but no target repos resolved — skipping sweep.');
    }
    for (const repo of repos) {
      const resolved = workdirForRepo(repo);
      if (resolved.error) {
        console.warn(`Boot sweep: ${repo} → ${resolved.error}, skipping.`);
        continue;
      }
      console.log(`Boot sweep: processing all open Dependabot PRs for ${repo} (one sequential run)...`);
      triggerPipeline('all', repo, resolved.dir, 'sweep');
    }
  }
});
