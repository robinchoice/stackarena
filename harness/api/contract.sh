#!/usr/bin/env bash
# Property-based contract run with Schemathesis against a backend at BASE_URL.
# Logout is excluded because it would revoke the token the run uses.
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE_URL=${BASE_URL:-http://127.0.0.1:8080}

email="contract-$(date +%s%N)@stackarena.test"
token=$(curl -sf -X POST "$BASE_URL/auth/register" -H 'content-type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"correct-horse-battery\"}" |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')

docker run --rm --network host -v "$PWD/spec:/spec:ro" \
  -v "$PWD/harness/api/schemathesis.toml:/tmp/schemathesis.toml:ro" -w /tmp schemathesis/schemathesis:stable \
  run /spec/openapi.yaml --url "$BASE_URL" -H "Authorization: Bearer $token" \
  --exclude-path /auth/logout --checks all --max-examples "${MAX_EXAMPLES:-100}" "$@"
