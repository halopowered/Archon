#!/usr/bin/env bun
// dependabot — webhook task config.
//
// Filters GitHub `pull_request` events to Dependabot-authored PRs and runs the
// `dependabot-pipeline` workflow on each (validate install/build/test,
// auto-merge patch/minor, escalate the rest). All the generic machinery —
// HMAC, /health, the per-repo serial queue, multi-repo routing, spawning the
// run, backlog discovery — lives in ../../lib/archon-webhook.js. This file is
// just the Dependabot-specific decisions.
//
// Task-specific env:
//   WEBHOOK_BOT_LOGIN          login whose token the runs act under; events
//                              from this sender are suppressed (auto-resolved
//                              via `gh api /user` if unset)
//   WEBHOOK_ALLOW_SELF_REOPEN  '1' lets a self-`reopened` event through (testing)
//   WEBHOOK_PROCESSED_LABEL    label applied to still-open PRs after a run so
//                              discovery skips them (default 'archon-reviewed')

const {
  createArchonWebhookServer,
  resolveSelfLogin,
  ghText,
  ghJson,
} = require('../../lib/archon-webhook');

const DEPENDABOT_LOGINS = new Set(['dependabot[bot]', 'app/dependabot', 'dependabot']);
const HANDLED_ACTIONS = new Set(['opened', 'reopened']);
const ALLOW_SELF_REOPEN = process.env.WEBHOOK_ALLOW_SELF_REOPEN === '1';
const PROCESSED_LABEL = process.env.WEBHOOK_PROCESSED_LABEL || 'archon-reviewed';
const SELF_LOGIN = resolveSelfLogin();

createArchonWebhookServer({
  name: 'dependabot',
  workflow: 'dependabot-pipeline',

  // Decide whether an incoming delivery is an actionable Dependabot PR.
  match({ event, payload }) {
    if (event !== 'pull_request') {
      return { ignore: 'not_pull_request_event', detail: { event } };
    }
    const action = payload.action;
    const pr = payload.pull_request;
    const repo = (payload.repository && payload.repository.full_name) || 'unknown';

    if (!HANDLED_ACTIONS.has(action)) {
      return { ignore: 'unhandled_action', detail: { action } };
    }

    // Self-induced event suppression: our pipeline's `update-branch` call fires
    // a `synchronize` back at us; the PR author is still Dependabot, but
    // `sender.login` is the user whose token acted, so skip when that's us.
    const sender = payload.sender && payload.sender.login;
    const selfReopenAllowed = ALLOW_SELF_REOPEN && action === 'reopened';
    if (SELF_LOGIN && sender === SELF_LOGIN && !selfReopenAllowed) {
      return { ignore: 'self_triggered_event', detail: { sender, action } };
    }

    const author = pr && pr.user && pr.user.login;
    if (!DEPENDABOT_LOGINS.has(author)) {
      return { ignore: 'not_dependabot', detail: { author } };
    }

    return { repo, key: pr.number, meta: { pr: pr.number, title: pr.title, action } };
  },

  // Backlog: open Dependabot PRs that aren't already labeled as handled.
  async discover(repo) {
    const prs = await ghJson([
      'pr', 'list', '--repo', repo, '--author', 'app/dependabot',
      '--state', 'open', '--json', 'number,labels', '--limit', '100',
    ]);
    return prs
      .filter(p => !(p.labels || []).some(l => l.name === PROCESSED_LABEL))
      .map(p => p.number);
  },

  // After a run, if the PR is still OPEN it wasn't auto-merged (escalated /
  // failed) — label it so discovery skips it. Merged PRs close and drop out.
  async onComplete({ repo, key }) {
    const state = await ghText([
      'pr', 'view', String(key), '--repo', repo, '--json', 'state', '-q', '.state',
    ]);
    if (state !== 'OPEN') return;
    await ghText([
      'label', 'create', PROCESSED_LABEL, '--repo', repo, '--color', 'FBCA04',
      '--description', 'Handled by the Archon dependabot pipeline; needs human review',
    ]);
    await ghText(['pr', 'edit', String(key), '--repo', repo, '--add-label', PROCESSED_LABEL]);
    console.log(`[${repo}] PR #${key} still open after run → labeled '${PROCESSED_LABEL}'`);
  },

  describe() {
    return [
      `self login:        ${SELF_LOGIN || '(unresolved — set WEBHOOK_BOT_LOGIN)'}`,
      `processed label:   ${PROCESSED_LABEL}`,
      ...(ALLOW_SELF_REOPEN ? ['self-reopen:       ALLOWED (testing)'] : []),
    ];
  },
});
