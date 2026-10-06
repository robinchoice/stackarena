#!/usr/bin/env bash
# Runs a command from harness/ against the in-memory reference API, e.g.
#   api/with-reference.sh bun test api/
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=18080 bun reference/api.ts >/dev/null &
pid=$!
trap 'kill $pid' EXIT
for _ in $(seq 50); do curl -sf http://127.0.0.1:18080/health >/dev/null && break; sleep 0.1; done
BASE_URL=http://127.0.0.1:18080 "$@"
