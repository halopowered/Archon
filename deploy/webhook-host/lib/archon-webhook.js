// archon-webhook — shared runtime for webhook servers that drive `archon`.
//
// Factor out everything generic so a new webhook task is just a thin config:
// HMAC verification, /health, per-repo SERIAL work queue (Archon's per-codebase
// source symlink means same-repo runs can't overlap), multi-repo routing to
// per-repo checkouts, spawning the workflow run, backlog discovery, and the
// post-run hook. Each task supplies only its task-specific decisions.
//
// Usage (servers/<name>/server.js):
//
//   const { createArchonWebhookServer, resolveSelfLogin, ghText, ghJson } =
//     require('../../lib/archon-webhook');
//
//   createArchonWebhookServer({
//     name: 'dependabot',          // used in logs + run branch names
//     workflow: 'dependabot-pipeline',
//     match({ event, payload }) {  // → { repo, key, meta? } to enqueue,
//       ...                        //   or { ignore: '<reason>', detail? } to 200-skip
//     },
//     buildArg(key) { return String(key); },          // workflow argument (default String(key))
//     async discover(repo) { return [/* keys */]; },   // backlog keys (optional)
//     async onComplete({ repo, key, dir }) { ... },     // post-run hook (optional)
//   });
//
// Env (read once at startup, shared by every task):
//   GITHUB_WEBHOOK_SECRET   required — HMAC secret
//   PORT                    listen port (the host dispatcher assigns this)
//   WEBHOOK_BIND_HOST       bind address (default 127.0.0.1 — host-only)
//   WEBHOOK_TARGET_REPOS    space/comma-separated owner/repo allowlist
//   WEBHOOK_CHECKOUTS_DIR   where target repos are cloned (default /.archon/checkouts)
//   ARCHON_FROM_BRANCH      base branch for the run's worktree (default main)
//   ARCHON_BIN              explicit archon executable (overrides auto-detect)
//   ARCHON_CLI_ENTRY        CLI source entry for `bun` (default /app/packages/cli/src/cli.ts)
//   WEBHOOK_DISCOVERY       '0' disables proactive backlog scans (default on)
//   WEBHOOK_LOG_DIR         per-run log directory (default <task dir>/logs)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ── gh helpers ───────────────────────────────────────────────────────────────
// Synchronous (use off the request hot path only).
function gh(args, opts = {}) {
  return spawnSync('gh', args, { encoding: 'utf8', timeout: 10000, ...opts });
}
// Async stdout — safe to await without blocking the event loop. Resolves to the
// trimmed stdout string ('' on any error/non-zero exit; never rejects).
function ghText(args) {
  return new Promise(resolve => {
    let out = '';
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', d => (out += d));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out.trim()));
  });
}
// Async JSON — resolves to the parsed value, or `fallback` ([] by default).
async function ghJson(args, fallback = []) {
  const out = await ghText(args);
  try {
    return out ? JSON.parse(out) : fallback;
  } catch {
    return fallback;
  }
}

// Resolve the bot/user login whose token the runs act under, for self-event
// suppression. Explicit env wins; otherwise `gh api /user`. null if unknown.
function resolveSelfLogin(envVar = 'WEBHOOK_BOT_LOGIN') {
  if (process.env[envVar]) return process.env[envVar].trim();
  try {
    const r = gh(['api', '/user', '-q', '.login'], { timeout: 5000 });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch {
    /* gh missing/unauthed */
  }
  return null;
}

// How to invoke the archon CLI. Prefer an explicit ARCHON_BIN; else run the
// in-image CLI source deterministically via bun (no dependency on the `archon`
// PATH wrapper); else fall back to `archon` on PATH (local/standalone use).
function buildArchonInvocation(workflowArgs) {
  const bin = process.env.ARCHON_BIN;
  if (bin) return { cmd: bin, args: workflowArgs };
  const cliEntry = process.env.ARCHON_CLI_ENTRY || '/app/packages/cli/src/cli.ts';
  try {
    if (fs.existsSync(cliEntry)) return { cmd: 'bun', args: [cliEntry, ...workflowArgs] };
  } catch {
    /* fall through */
  }
  return { cmd: 'archon', args: workflowArgs };
}

function createArchonWebhookServer(task) {
  if (!task || !task.name || typeof task.match !== 'function' || !task.workflow) {
    throw new Error('createArchonWebhookServer: task requires { name, workflow, match() }');
  }

  const PORT = parseInt(process.env.PORT, 10) || 3000;
  const BIND_HOST = process.env.WEBHOOK_BIND_HOST || '127.0.0.1';
  const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
  const CHECKOUTS_DIR = process.env.WEBHOOK_CHECKOUTS_DIR || '/.archon/checkouts';
  const TARGET_REPOS = new Set(
    (process.env.WEBHOOK_TARGET_REPOS || '')
      .split(/[\s,]+/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  );
  const ARCHON_WORKDIR = process.env.ARCHON_WORKDIR || '';
  const FROM_BRANCH = process.env.ARCHON_FROM_BRANCH || 'main';
  // Default logs next to the task's server file (argv[1] is the script bun ran).
  const entryFile = process.argv[1] || (require.main && require.main.filename) || process.cwd();
  const LOG_DIR = process.env.WEBHOOK_LOG_DIR || path.join(path.dirname(entryFile), 'logs');
  const DISCOVERY_ENABLED = process.env.WEBHOOK_DISCOVERY !== '0';
  const buildArg = task.buildArg || (key => String(key));

  fs.mkdirSync(LOG_DIR, { recursive: true });

  if (!SECRET) {
    console.error('ERROR: GITHUB_WEBHOOK_SECRET is required.');
    process.exit(1);
  }

  // Resolve a target repo to its on-disk checkout (cwd for the spawned run).
  // { dir } on success; { error } when not allowlisted or not cloned. With no
  // allowlist + an explicit ARCHON_WORKDIR, falls back to that single dir.
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

  // Each run uses a unique branch so Archon creates a fresh worktree and
  // re-registers the codebase. A leftover source symlink from a prior run
  // blocks registration; drop it when it's a symlink we can safely remove.
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

  // ── Per-repo serial work queue ──────────────────────────────────────────────
  // repo -> { dir, pending: [keys], seen: Set, running: bool }
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

  function enqueue(repo, dir, key) {
    const s = repoState(repo, dir);
    if (s.seen.has(key)) return false;
    s.seen.add(key);
    s.pending.push(key);
    console.log(`[${repo}] queued ${key} (queue depth ${s.pending.length})`);
    drain(repo);
    return true;
  }

  function drain(repo) {
    const s = repoStates.get(repo);
    if (!s || s.running || s.pending.length === 0) return;
    s.running = true;
    const key = s.pending.shift();
    const child = runArchon(repo, s.dir, key);
    child.on('close', async code => {
      console.log(`[${repo}] ${key} run exited (code ${code}); queue depth ${s.pending.length}`);
      if (task.onComplete) {
        try {
          await task.onComplete({ repo, key, dir: s.dir });
        } catch (err) {
          console.warn(`[${repo}] onComplete(${key}) failed: ${err.message}`);
        }
      }
      s.running = false;
      // Only re-scan the backlog when discovery is enabled; otherwise stay
      // event-driven and just drain what the webhook already queued.
      if (DISCOVERY_ENABLED && task.discover) {
        await discoverInto(repo, s.dir).catch(() => {});
      }
      drain(repo);
    });
  }

  function runArchon(repo, workdir, key) {
    clearStaleArchonSource(repo);
    const slug = `${task.name}-${key}`;
    const branch = `webhook/${slug}-${Date.now()}`;
    const wfArgs = [
      'workflow',
      'run',
      task.workflow,
      '--branch',
      branch,
      '--from',
      FROM_BRANCH,
      buildArg(key),
    ];
    const { cmd, args } = buildArchonInvocation(wfArgs);
    const logFile = path.join(LOG_DIR, branch.replace(/\//g, '_') + '.log');
    const logFd = fs.openSync(logFile, 'a');
    fs.writeSync(
      logFd,
      `\n=== ${new Date().toISOString()} [${repo}] ${slug} (cwd ${workdir}) → ${cmd} ${args.join(' ')} ===\n`
    );
    console.log(`[${repo}] ${slug}: spawning (cwd ${workdir}) ${cmd} ${args.join(' ')}`);
    console.log(`  log: ${logFile}`);
    return spawn(cmd, args, { cwd: workdir, stdio: ['ignore', logFd, logFd] });
  }

  // Ask the task for backlog keys for a repo and enqueue any not yet seen.
  async function discoverInto(repo, dir) {
    const keys = (await task.discover(repo, dir)) || [];
    let added = 0;
    for (const key of keys) {
      if (enqueue(repo, dir, key)) added++;
    }
    if (added) console.log(`[${repo}] discovery enqueued ${added} new item(s)`);
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return reply(res, 200, { ok: true, server: task.name });
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

      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply(res, 400, { error: 'invalid_json' });
      }

      // Task decides: enqueue ({ repo, key, meta? }) or skip ({ ignore, detail? }).
      let decision;
      try {
        decision = task.match({ event, payload });
      } catch (err) {
        console.error(`match() threw: ${err.message}`);
        return reply(res, 500, { error: 'match_error' });
      }

      if (!decision || !decision.repo || decision.key === undefined) {
        const reason = (decision && decision.ignore) || 'ignored';
        return reply(res, 200, { ignored: true, reason, ...((decision && decision.detail) || {}) });
      }

      // 200 (not 4xx) on a routing miss so GitHub doesn't retry a config issue.
      const resolved = workdirForRepo(decision.repo);
      if (resolved.error) {
        console.warn(`[${decision.repo}] ${decision.key}: ${resolved.error} — ignoring`);
        return reply(res, 200, { ignored: true, reason: resolved.error, repo: decision.repo });
      }

      const queued = enqueue(decision.repo, resolved.dir, decision.key);
      return reply(res, 202, {
        accepted: true,
        queued,
        repo: decision.repo,
        key: decision.key,
        ...(decision.meta || {}),
      });
    });

    req.on('error', err => {
      console.error('Request error:', err.message);
      reply(res, 500, { error: 'request_error' });
    });
  });

  server.listen(PORT, BIND_HOST, () => {
    console.log(`${task.name}-webhook listening on http://${BIND_HOST}:${PORT}`);
    const repoList =
      TARGET_REPOS.size > 0
        ? [...TARGET_REPOS].join(', ')
        : `(none — fallback ${ARCHON_WORKDIR || 'unset'})`;
    console.log(`  workflow:          ${task.workflow}`);
    console.log(`  target repos:      ${repoList}`);
    console.log(`  checkouts dir:     ${CHECKOUTS_DIR}`);
    console.log(`  --from branch:     ${FROM_BRANCH}`);
    console.log(`  log dir:           ${LOG_DIR}`);
    console.log(
      `  discovery:         ${DISCOVERY_ENABLED ? 'ON (scans + drains the backlog on boot and after each run)' : 'off (event-driven only; WEBHOOK_DISCOVERY=0)'}`
    );
    if (typeof task.describe === 'function') {
      for (const line of task.describe()) console.log(`  ${line}`);
    }
    console.log(`  health endpoint:   http://${BIND_HOST}:${PORT}/health`);

    if (DISCOVERY_ENABLED && task.discover) {
      for (const repo of TARGET_REPOS) {
        const resolved = workdirForRepo(repo);
        if (resolved.error) {
          console.warn(`Boot discovery: ${repo} → ${resolved.error}, skipping.`);
          continue;
        }
        console.log(`Boot discovery: scanning ${repo}...`);
        discoverInto(repo, resolved.dir).catch(() => {});
      }
    }
  });

  return server;
}

module.exports = { createArchonWebhookServer, resolveSelfLogin, gh, ghText, ghJson };
