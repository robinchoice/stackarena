#!/usr/bin/env bash
# Load test against BASE_URL. The k6 summary lands in $OUT/load-summary.json.
set -euo pipefail
cd "$(dirname "$0")"
BASE_URL=${BASE_URL:-http://127.0.0.1:8080}
OUT=${OUT:-$PWD/../../results}
mkdir -p "$OUT"
docker run --rm --network host --user "$(id -u):$(id -g)" -v "$PWD:/scripts:ro" -v "$OUT:/out" grafana/k6 \
  run --quiet -e BASE_URL="$BASE_URL" --summary-export /out/load-summary.json /scripts/sync.js
