# =============================================================================
# Archon - Remote Agentic Coding Platform
# Multi-stage build: deps → web build → production image
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.11-slim AS deps

WORKDIR /app

# Copy root package files and lockfile
COPY package.json bun.lock ./

# Copy ALL workspace package.json files (monorepo lockfile depends on all of them)
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
# docs-web source is NOT copied — it's a static site deployed separately
# (see .github/workflows/deploy-docs.yml). package.json is included only
# so Bun's workspace lockfile resolves correctly.
COPY packages/docs-web/package.json ./packages/docs-web/
COPY packages/git/package.json ./packages/git/
COPY packages/isolation/package.json ./packages/isolation/
COPY packages/paths/package.json ./packages/paths/
COPY packages/providers/package.json ./packages/providers/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/workflows/package.json ./packages/workflows/

# Install ALL dependencies (including devDependencies needed for web build)
# --linker=hoisted: Bun's default "isolated" linker stores packages in
# node_modules/.bun/ with symlinks that Vite/Rollup cannot resolve during
# production builds. Hoisted layout gives classic flat node_modules.
RUN bun install --frozen-lockfile --linker=hoisted

# ---------------------------------------------------------------------------
# Stage 2: Build web UI (Vite + React)
# ---------------------------------------------------------------------------
FROM deps AS web-build

# Copy full source (needed for workspace resolution and web build)
COPY . .

# Build the web frontend — output goes to packages/web/dist/
RUN bun run build:web && \
    test -f packages/web/dist/index.html || \
    (echo "ERROR: Web build produced no index.html" >&2 && exit 1)

# ---------------------------------------------------------------------------
# Stage 3: Production image
# ---------------------------------------------------------------------------
FROM oven/bun:1.3.11-slim AS production

# OCI Labels for GHCR
LABEL org.opencontainers.image.source="https://github.com/coleam00/Archon"
LABEL org.opencontainers.image.description="Control AI coding assistants remotely from Telegram, Slack, Discord, and GitHub"
LABEL org.opencontainers.image.licenses="MIT"

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Install system dependencies + gosu for privilege dropping in entrypoint
RUN apt-get update && apt-get install -y \
    curl \
    git \
    bash \
    ca-certificates \
    gnupg \
    gosu \
    postgresql-client \
    # jq: required by the webhook-host dependabot workflows (JSON parsing)
    jq \
    # Chromium for agent-browser E2E testing (drives browser via CDP)
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser CLI (Vercel Labs) for E2E testing workflows
# - Uses npm (not bun) because postinstall script downloads the native Rust binary
# - After install, symlink the Rust binary directly so it works standalone
# - agent-browser auto-detects Docker (via /.dockerenv) and adds --no-sandbox to Chromium
#
# NOTE: nodejs/npm are intentionally KEPT (not purged) — the webhook-host
# dependabot workflows (verify-and-merge, auto-fix-install) run `npm ci`,
# `npm install`, `npm run build`, and `npm test` on target-repo PR branches.
# Node.js 22 (LTS) via the official binary tarball, not Debian's Node 20: modern
# pnpm (v11, selected by corepack) requires `node:sqlite`, which only exists in
# Node 22+ (Node 20 fails with ERR_UNKNOWN_BUILTIN_MODULE). The lockfile-conflict
# auto-fix regenerates pnpm/yarn lockfiles, so it needs a working pnpm.
# Tarball (.tar.gz) install is deterministic — no apt repo / gpg dependency.
# Resolve the LATEST Node 22.x at build time (pnpm 11 needs >= 22.13, so a
# fixed older patch like 22.12 fails); index.json is newest-first. jq + curl
# are already installed above. corepack@latest then honors each project's
# `packageManager` pin.
RUN ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in amd64) NODEARCH=x64 ;; arm64) NODEARCH=arm64 ;; *) echo "unsupported arch $ARCH" >&2; exit 1 ;; esac \
    && NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | startswith("v22."))][0].version')" \
    && echo "Installing Node ${NODE_VERSION} (${NODEARCH})" \
    && curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODEARCH}.tar.gz" \
       | tar -xz -C /usr/local --strip-components=1 --no-same-owner \
    && node --version && npm --version \
    && npm install -g corepack@latest \
    && npm install -g agent-browser@0.22.1 \
    && NATIVE_BIN=$(find /usr/local/lib/node_modules/agent-browser -name 'agent-browser-*' -type f -executable 2>/dev/null | head -1) \
    && if [ -n "$NATIVE_BIN" ]; then \
         cp "$NATIVE_BIN" /usr/local/bin/agent-browser-native \
         && chmod +x /usr/local/bin/agent-browser-native \
         && ln -sf /usr/local/bin/agent-browser-native /usr/local/bin/agent-browser; \
       else \
         echo "ERROR: agent-browser native binary not found after npm install" >&2 && exit 1; \
       fi \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/agent-browser \
    && rm -rf /var/lib/apt/lists/*

# Poetry — the Dependabot pipeline verifies/auto-fixes Python (Poetry) projects
# (verify = poetry install/ruff/pytest; auto-fix-conflict regenerates poetry.lock).
# python3 (3.13, satisfies the projects' >=3.12) is already in the base image;
# install Poetry into its own venv under /opt and symlink onto PATH for appuser.
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
    && curl -sSL https://install.python-poetry.org | POETRY_HOME=/opt/poetry python3 - \
    && ln -s /opt/poetry/bin/poetry /usr/local/bin/poetry \
    && poetry --version \
    && rm -rf /var/lib/apt/lists/*

# Extra Python runtimes for Poetry's interpreter auto-discovery. The base image
# only ships python3.13, but projects commonly pin e.g. ">=3.11,<3.13", which
# 3.13 does NOT satisfy — Poetry then fails every install/lint/test with
# "unable to find a compatible version". Install uv (fast python-build-standalone
# interpreters, no compilation) and place 3.11 + 3.12 on PATH as python3.11 /
# python3.12 so Poetry's "find a compatible version" routine selects one
# automatically (no workflow changes). Shared + world-readable so appuser can
# execute them. (Need a project on <3.11? add it to the `uv python install`.)
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN curl -LsSf https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    && export PATH="/usr/local/bin:/root/.local/bin:$PATH" \
    && uv python install 3.11 3.12 \
    && ln -sf "$(uv python find 3.11)" /usr/local/bin/python3.11 \
    && ln -sf "$(uv python find 3.12)" /usr/local/bin/python3.12 \
    && chmod -R a+rX /opt/uv-python \
    && python3.11 --version && python3.12 --version

# Point agent-browser to system Chromium (avoids ~400MB Chrome for Testing download)
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

# CLAUDE_BIN_PATH is set at container startup (docker-entrypoint.sh).
# The entrypoint pins the glibc variant to bypass the SDK's musl-first resolver.

# Create non-root user for running Claude Code
# Claude Code refuses to run with --dangerously-skip-permissions as root for security
RUN useradd -m -u 1001 -s /bin/bash appuser \
    && chown -R appuser:appuser /app

# Create Archon directories
RUN mkdir -p /.archon/workspaces /.archon/worktrees \
    && chown -R appuser:appuser /.archon

# Copy root package files and lockfile
COPY package.json bun.lock ./

# Copy ALL workspace package.json files
COPY packages/adapters/package.json ./packages/adapters/
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
# docs-web source is NOT copied — it's a static site deployed separately
# (see .github/workflows/deploy-docs.yml). package.json is included only
# so Bun's workspace lockfile resolves correctly.
COPY packages/docs-web/package.json ./packages/docs-web/
COPY packages/git/package.json ./packages/git/
COPY packages/isolation/package.json ./packages/isolation/
COPY packages/paths/package.json ./packages/paths/
COPY packages/providers/package.json ./packages/providers/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/workflows/package.json ./packages/workflows/

# Install production dependencies only (--ignore-scripts skips husky prepare hook)
RUN bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted

# Copy application source (Bun runs TypeScript directly, no compile step needed)
COPY packages/adapters/ ./packages/adapters/
COPY packages/cli/ ./packages/cli/
COPY packages/core/ ./packages/core/
COPY packages/git/ ./packages/git/
COPY packages/isolation/ ./packages/isolation/
COPY packages/paths/ ./packages/paths/
COPY packages/providers/ ./packages/providers/
COPY packages/server/ ./packages/server/
COPY packages/workflows/ ./packages/workflows/

# Copy pre-built web UI from build stage
COPY --from=web-build /app/packages/web/dist/ ./packages/web/dist/

# Copy config, migrations, and bundled defaults
COPY .archon/ ./.archon/
COPY migrations/ ./migrations/
COPY tsconfig*.json ./

# Webhook-host subsystem: supervisor + per-server webhook listeners, plus the
# Archon workflow YAMLs they trigger (copied into /.archon/workflows at boot by
# docker-entrypoint.sh). See deploy/webhook-host/README.md.
COPY deploy/ ./deploy/

# Fix permissions for appuser
RUN chown -R appuser:appuser /app

# Create .codex directory for Codex authentication
RUN mkdir -p /home/appuser/.codex && chown appuser:appuser /home/appuser/.codex

# Configure git to trust Archon directories (as appuser)
RUN gosu appuser git config --global --add safe.directory '/.archon/workspaces' && \
    gosu appuser git config --global --add safe.directory '/.archon/workspaces/*' && \
    gosu appuser git config --global --add safe.directory '/.archon/worktrees' && \
    gosu appuser git config --global --add safe.directory '/.archon/worktrees/*'

# Copy entrypoint script (fixes volume permissions, drops to appuser)
# sed strips Windows CRLF in case .gitattributes eol=lf was bypassed
COPY docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose the `archon` CLI on PATH. A thin wrapper execs the CLI source already
# baked into the image, so it always matches the server version + DB schema (no
# released-binary drift, no network fetch). Runs the script directly (not via
# `bun --cwd`) so module resolution finds the hoisted /app/node_modules while
# process.cwd() stays as the caller's directory — required for workflow commands
# that resolve the git repo from cwd (e.g. inside worktrees).
RUN printf '#!/bin/bash\nexec bun /app/packages/cli/src/cli.ts "$@"\n' > /usr/local/bin/archon \
    && chmod +x /usr/local/bin/archon

# Default port (matches .env.example PORT=3000)
EXPOSE 3000

# Webhook-host dispatcher port (Fly maps the public :8443 edge to this).
EXPOSE 9000

ENTRYPOINT ["docker-entrypoint.sh"]
