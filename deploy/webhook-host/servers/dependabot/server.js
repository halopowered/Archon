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
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
// Legacy single-repo fallback: only used when no allowlist is configured.
const ARCHON_WORKDIR = process.env.ARCHON_WORKDIR || '';
const FROM_BRANCH = process.env.ARCHON_FROM_BRANCH || 'main';
const LOG_DIR = process.env.WEBHOOK_LOG_DIR || path.join(__dirname, 'logs');

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

const DEPENDABOT_LOGINS = new Set(['dependabot[bot]', 'app/dependabot', 'dependabot']);
const HANDLED_ACTIONS = new Set(['opened', 'reopened']);

// Testing aid: when set, `reopened` events whose sender is this bot are NOT
// suppressed, so you can manually reopen a Dependabot PR to trigger the
// pipeline. Loop protection for `synchronize` (the `update-branch` echo)
// is unaffected. Unset/remove this for normal operation.
const ALLOW_SELF_REOPEN = process.env.WEBHOOK_ALLOW_SELF_REOPEN === '1';

// Backlog discovery. On boot (and after every run completes), list open
// Dependabot PRs per repo and enqueue any not yet handled — so PRs that opened
// while the server was down, or while another PR was running, get picked up.
// Default ON; set WEBHOOK_DISCOVER_ON_BOOT=0 to disable the boot scan.
const DISCOVER_ON_BOOT = process.env.WEBHOOK_DISCOVER_ON_BOOT !== '0';

// Durable dedup marker. After a run, if the PR is still OPEN (escalated to
// human review / not auto-merged / failed), the server adds this label so
// future discovery sweeps skip it permanently (across restarts). Merged PRs
// close and drop out of `--state open` naturally. Remove the label by hand to
// re-queue a PR.
const PROCESSED_LABEL = process.env.WEBHOOK_PROCESSED_LABEL || 'archon-reviewed';

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
  const link = path.join(os.homedir(), '.archon', 'workspaces', repoFullName, 'source');
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

// ── Per-repo serial work queue ───────────────────────────────────────────────
// Archon uses a single `source` symlink per codebase, so two pipeline runs for
// the SAME repo cannot run concurrently (they contend over it). We serialize
// per repo: one run at a time per repo, repos drain independently. Both
// webhook deliveries and backlog discovery feed the same queue.
//
//   repoStates: repo(full_name) -> { dir, pending: [prNumbers], seen: Set, running: bool }
const repoStates = new Map();

function repoState(repo, dir) {
  let s = repoStates.get(repo);
  if (!s) {
    s = { dir, pending: [], seen: new Set(), running: false };
    repoStates.set(repo, s);
  } else if (dir) {
    s.dir = dir;
  }
  return s;
}

// Add a PR to a repo's queue (deduped within the session) and kick the drain.
function enqueue(repo, dir, pr) {
  const s = repoState(repo, dir);
  if (s.seen.has(pr)) return false;
  s.seen.add(pr);
  s.pending.push(pr);
  console.log(`[${repo}] queued PR #${pr} (queue depth ${s.pending.length})`);
  drain(repo);
  return true;
}

// Run the next queued PR for a repo if none is currently running. On
// completion: label the PR if it's still open, then re-discover (catching PRs
// opened during the run) and drain the next.
function drain(repo) {
  const s = repoStates.get(repo);
  if (!s || s.running || s.pending.length === 0) return;
  s.running = true;
  const pr = s.pending.shift();
  const child = runPipeline(repo, s.dir, pr, `pr-${pr}`);
  child.on('close', code => {
    console.log(`[${repo}] PR #${pr} run exited (code ${code}); queue depth ${s.pending.length}`);
    labelIfStillOpen(repo, pr);
    s.running = false;
    rediscover(repo, s.dir).finally(() => drain(repo));
  });
}

// Spawn one `dependabot-pipeline` run in `workdir`. NOT detached — we track
// completion to serialize the queue and re-discover afterward.
function runPipeline(repo, workdir, argument, label) {
  // Clear the prior run's source registration so Archon re-registers this
  // run's worktree without a symlink conflict.
  clearStaleArchonSource(repo);

  const slug = label || `pr-${argument}`;
  const branch = `webhook/pipeline-${slug}-${Date.now()}`;
  const args = [
    'workflow',
    'run',
    'dependabot-pipeline',
    '--branch',
    branch,
    '--from',
    FROM_BRANCH,
    String(argument),
  ];
  const logFile = path.join(LOG_DIR, branch.replace(/\//g, '_') + '.log');
  const logFd = fs.openSync(logFile, 'a');
  fs.writeSync(
    logFd,
    `\n=== ${new Date().toISOString()} ` +
      `[${repo}] ${slug} (cwd ${workdir}) → archon ${args.join(' ')} ===\n`
  );

  console.log(`[${repo}] ${slug}: spawning (cwd ${workdir}) archon ${args.join(' ')}`);
  console.log(`  log: ${logFile}`);

  return spawn('archon', args, {
    cwd: workdir,
    stdio: ['ignore', logFd, logFd],
  });
}

// After a run, if the PR is still OPEN it wasn't auto-merged (escalated to
// human review / failed). Label it so discovery skips it permanently. Merged
// PRs are CLOSED and drop out of `--state open` on their own.
function labelIfStillOpen(repo, pr) {
  try {
    const v = spawnSync(
      'gh',
      ['pr', 'view', String(pr), '--repo', repo, '--json', 'state', '-q', '.state'],
      { encoding: 'utf8', timeout: 10000 }
    );
    if ((v.stdout || '').trim() !== 'OPEN') return;
    // Ensure the label exists (idempotent), then add it.
    spawnSync(
      'gh',
      [
        'label',
        'create',
        PROCESSED_LABEL,
        '--repo',
        repo,
        '--color',
        'FBCA04',
        '--description',
        'Handled by the Archon dependabot pipeline; needs human review',
      ],
      { timeout: 10000 }
    );
    spawnSync('gh', ['pr', 'edit', String(pr), '--repo', repo, '--add-label', PROCESSED_LABEL], {
      timeout: 10000,
    });
    console.log(`[${repo}] PR #${pr} still open after run → labeled '${PROCESSED_LABEL}'`);
  } catch (err) {
    console.warn(`[${repo}] could not label PR #${pr}: ${err.message}`);
  }
}

// List open Dependabot PRs for a repo that lack the processed label, and
// enqueue any not already seen this session. Resolves when done (best effort).
function rediscover(repo, workdir) {
  return new Promise(resolve => {
    let out = '';
    const child = spawn(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--author',
        'app/dependabot',
        '--state',
        'open',
        '--json',
        'number,labels',
        '--limit',
        '100',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    child.stdout.on('data', d => {
      out += d;
    });
    child.on('error', () => resolve());
    child.on('close', () => {
      try {
        const prs = JSON.parse(out || '[]');
        let added = 0;
        for (const p of prs) {
          const labeled = (p.labels || []).some(l => l.name === PROCESSED_LABEL);
          if (labeled) continue;
          if (enqueue(repo, workdir, p.number)) added++;
        }
        if (added) console.log(`[${repo}] discovery enqueued ${added} new PR(s)`);
      } catch (err) {
        console.warn(`[${repo}] discovery parse failed: ${err.message}`);
      }
      resolve();
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return reply(res, 200, { ok: true });
  }
  if (req.method !== 'POST') {
    return reply(res, 405, { error: 'method_not_allowed' });
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
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
          `WEBHOOK_ALLOW_SELF_REOPEN=1 — not suppressing reopened event (testing)`
      );
    }
    if (SELF_LOGIN && sender === SELF_LOGIN && !selfReopenAllowed) {
      console.log(
        `[${repo}] PR #${pr && pr.number}: sender '${sender}' is this bot — ` +
          `suppressing self-induced ${action} event`
      );
      return reply(res, 200, {
        ignored: true,
        reason: 'self_triggered_event',
        sender,
        action,
      });
    }

    const author = pr && pr.user && pr.user.login;
    if (!DEPENDABOT_LOGINS.has(author)) {
      console.log(
        `[${repo}] PR #${pr && pr.number}: author '${author}' is not Dependabot — ignoring`
      );
      return reply(res, 200, { ignored: true, reason: 'not_dependabot', author });
    }

    // Route to THIS repo's checkout. 200 (not 4xx) on a miss so GitHub doesn't
    // retry — a misconfigured/unknown repo is a config issue, not transient.
    const resolved = workdirForRepo(repo);
    if (resolved.error) {
      console.warn(`[${repo}] PR #${pr && pr.number}: ${resolved.error} — ignoring`);
      return reply(res, 200, { ignored: true, reason: resolved.error, repo });
    }

    // Enqueue onto the repo's serial queue (deduped). The queue drains one run
    // at a time per repo and re-discovers the backlog after each completes.
    const queued = enqueue(repo, resolved.dir, pr.number);
    return reply(res, 202, {
      accepted: true,
      queued,
      pr: pr.number,
      title: pr.title,
      repo,
      action,
    });
  });

  req.on('error', err => {
    console.error('Request error:', err.message);
    reply(res, 500, { error: 'request_error' });
  });
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`dependabot-webhook listening on http://${BIND_HOST}:${PORT}`);
  const repoList =
    TARGET_REPOS.size > 0
      ? [...TARGET_REPOS].join(', ')
      : `(none — fallback ${ARCHON_WORKDIR || 'unset'})`;
  console.log(`  target repos:      ${repoList}`);
  console.log(`  checkouts dir:     ${CHECKOUTS_DIR}`);
  console.log(`  --from branch:     ${FROM_BRANCH}`);
  console.log(`  log dir:           ${LOG_DIR}`);
  if (SELF_LOGIN) {
    console.log(`  self login:        ${SELF_LOGIN} (events from this user will be suppressed)`);
  } else {
    console.log(
      `  self login:        (unresolved — set WEBHOOK_BOT_LOGIN to enable self-event suppression)`
    );
  }
  if (ALLOW_SELF_REOPEN) {
    console.log(
      `  self-reopen:       ALLOWED (WEBHOOK_ALLOW_SELF_REOPEN=1 — testing; reopened events from self are NOT suppressed)`
    );
  }
  console.log(`  processed label:   ${PROCESSED_LABEL}`);
  console.log(
    `  boot discovery:    ${DISCOVER_ON_BOOT ? 'ON (enqueue existing open Dependabot PRs)' : 'off (WEBHOOK_DISCOVER_ON_BOOT=0)'}`
  );
  console.log(`  health endpoint:   http://${BIND_HOST}:${PORT}/health`);

  // Backlog discovery on boot: per repo, enqueue every open Dependabot PR that
  // isn't already labeled. The per-repo serial queue then drains them one at a
  // time (concurrent across repos), so existing PRs are caught up gradually.
  if (DISCOVER_ON_BOOT) {
    for (const repo of TARGET_REPOS) {
      const resolved = workdirForRepo(repo);
      if (resolved.error) {
        console.warn(`Boot discovery: ${repo} → ${resolved.error}, skipping.`);
        continue;
      }
      console.log(`Boot discovery: scanning open Dependabot PRs for ${repo}...`);
      rediscover(repo, resolved.dir);
    }
  }
});
