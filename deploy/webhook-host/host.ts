#!/usr/bin/env bun
/**
 * webhook-host — supervisor + path-routing reverse proxy for an arbitrary
 * number of webhook listener servers that drive the `archon` CLI.
 *
 * Each subdirectory of `servers/<name>/` with a `webhook.json` is one server:
 *
 *   { "name": "dependabot", "path": "/dependabot", "port": 9101,
 *     "entry": "server.js", "env": { ... } }
 *
 * On boot, host.ts:
 *   1. Discovers every `servers/<name>/webhook.json`.
 *   2. Launches each as a supervised child (`bun servers/<name>/<entry>`) on
 *      its loopback port, restarting it with backoff if it exits.
 *   3. Serves a single public listener on WEBHOOK_HOST_PORT (default 9000)
 *      that path-routes `/<name>/*` → `http://127.0.0.1:<port>/*`, forwarding
 *      the raw body bytes and all headers UNCHANGED so each child's GitHub
 *      HMAC verification still sees the exact payload it signed.
 *
 * Fly maps the public edge (`:8443`) to WEBHOOK_HOST_PORT only; child ports are
 * never exposed. Children inherit this process's env (GH_TOKEN, Claude OAuth,
 * DATABASE_URL, PATH with `archon`), merged with their per-server `env`.
 *
 * Adding a server = drop a new `servers/<name>/` dir + redeploy. No code change.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVERS_DIR = join(HERE, 'servers');
const HOST_PORT = parseInt(process.env.WEBHOOK_HOST_PORT || '9000', 10);

interface WebhookConfig {
  name: string;
  path: string; // public path prefix, e.g. "/dependabot"
  port: number; // loopback port the child listens on
  entry?: string; // default "server.js"
  env?: Record<string, string>;
}

function log(msg: string): void {
  console.log(`[webhook-host] ${msg}`);
}

function loadConfigs(): WebhookConfig[] {
  if (!existsSync(SERVERS_DIR)) {
    log(`no servers dir at ${SERVERS_DIR} — nothing to host`);
    return [];
  }
  const configs: WebhookConfig[] = [];
  for (const name of readdirSync(SERVERS_DIR)) {
    const dir = join(SERVERS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const cfgPath = join(dir, 'webhook.json');
    if (!existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as WebhookConfig;
      if (!cfg.path || !cfg.port) {
        log(`skipping ${name}: webhook.json missing required path/port`);
        continue;
      }
      cfg.name = cfg.name || name;
      cfg.entry = cfg.entry || 'server.js';
      configs.push(cfg);
    } catch (err) {
      log(`skipping ${name}: invalid webhook.json — ${(err as Error).message}`);
    }
  }
  return configs;
}

// Supervise one child forever: spawn, await exit, back off, respawn.
function superviseChild(cfg: WebhookConfig): void {
  const entryPath = join(SERVERS_DIR, cfg.name, cfg.entry!);
  let backoffMs = 1000;
  const MAX_BACKOFF = 30_000;

  const run = async (): Promise<void> => {
    while (true) {
      log(`starting '${cfg.name}' → bun ${entryPath} (port ${cfg.port})`);
      const proc = Bun.spawn(['bun', entryPath], {
        cwd: join(SERVERS_DIR, cfg.name),
        env: { ...process.env, ...cfg.env, PORT: String(cfg.port) },
        stdout: 'inherit',
        stderr: 'inherit',
      });
      const startedAt = Date.now();
      const code = await proc.exited;
      const ranMs = Date.now() - startedAt;
      // Reset backoff if the child stayed up a while; otherwise grow it.
      backoffMs = ranMs > 60_000 ? 1000 : Math.min(backoffMs * 2, MAX_BACKOFF);
      log(`'${cfg.name}' exited (code ${code}) after ${ranMs}ms — restarting in ${backoffMs}ms`);
      await Bun.sleep(backoffMs);
    }
  };
  void run();
}

const configs = loadConfigs();
// Longest path prefix first so "/foo-bar" can't be shadowed by "/foo".
const routes = [...configs].sort((a, b) => b.path.length - a.path.length);

for (const cfg of configs) superviseChild(cfg);

// Match a request path to a configured server, returning the child port and
// the remainder path to forward (prefix stripped). "/dependabot" → "/",
// "/dependabot/health" → "/health".
function matchRoute(pathname: string): { port: number; rest: string } | null {
  for (const r of routes) {
    if (pathname === r.path) return { port: r.port, rest: '/' };
    if (pathname.startsWith(r.path + '/')) {
      return { port: r.port, rest: pathname.slice(r.path.length) };
    }
  }
  return null;
}

Bun.serve({
  hostname: '0.0.0.0',
  port: HOST_PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);

    // Host-level health: lists configured servers (does not probe children).
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      return Response.json({
        ok: true,
        servers: configs.map(c => ({ name: c.name, path: c.path })),
      });
    }

    const route = matchRoute(url.pathname);
    if (!route) {
      return Response.json({ error: 'no_matching_webhook', path: url.pathname }, { status: 404 });
    }

    // Forward to the child UNCHANGED. Read the body as raw bytes so the
    // child's HMAC verification sees the exact signed payload. Drop `host`
    // and `content-length` so fetch sets them for the upstream connection.
    const body =
      req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.delete('content-length');
    const target = `http://127.0.0.1:${route.port}${route.rest}${url.search}`;

    try {
      const resp = await fetch(target, { method: req.method, headers, body });
      return new Response(resp.body, { status: resp.status, headers: resp.headers });
    } catch (err) {
      log(`proxy to ${target} failed: ${(err as Error).message}`);
      return Response.json({ error: 'upstream_unavailable' }, { status: 502 });
    }
  },
});

log(`listening on 0.0.0.0:${HOST_PORT}`);
if (configs.length === 0) {
  log('WARNING: no webhook servers configured');
} else {
  for (const c of configs) log(`route ${c.path} → 127.0.0.1:${c.port} (${c.name})`);
}
