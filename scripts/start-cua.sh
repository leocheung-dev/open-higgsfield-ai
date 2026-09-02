#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env
  set +a
fi

export OPENAI_API_KEY="${OPENAI_API_KEY:-${openai_key:-}}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-${base_url:-}}"
CUA_PORT="${PORT:-3000}"

if [[ -z "$OPENAI_API_KEY" ]]; then
  echo "ERROR=Missing OPENAI_API_KEY" >&2
  exit 1
fi
if [[ -z "$OPENAI_BASE_URL" ]]; then
  echo "ERROR=Missing OPENAI_BASE_URL" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR=Node.js is required" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "ERROR=Node.js 20 or newer is required" >&2
  exit 1
fi
if lsof -nP -iTCP:"$CUA_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ERROR=Port $CUA_PORT is already in use" >&2
  exit 1
fi

mkdir -p outputs uploads runtime

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
  pnpm build
  echo "CUA_APP_URL=http://127.0.0.1:$CUA_PORT/"
  exec pnpm exec next start --hostname 127.0.0.1 --port "$CUA_PORT"
fi

corepack pnpm install --frozen-lockfile
corepack pnpm build
echo "CUA_APP_URL=http://127.0.0.1:$CUA_PORT/"
exec corepack pnpm exec next start --hostname 127.0.0.1 --port "$CUA_PORT"
