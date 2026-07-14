#!/usr/bin/env bash
# Upload the clean .r2-staging tree to the konfigurator-assets R2 bucket using the
# Workers/D1/R2 API token (no S3 creds needed). Parallel, idempotent (overwrite), resumable.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
WRANGLER="$ROOT/node_modules/.bin/wrangler"
export CLOUDFLARE_API_TOKEN="$(cat ~/.jamogu-cf-token)"
LOG="$ROOT/upload-r2.log"
: > "$LOG"
cd "$ROOT/.r2-staging" || exit 1
total=$(find . -type f | wc -l | tr -d ' ')
echo "uploading $total files..." | tee -a "$LOG"

export WRANGLER
find . -type f | sed 's|^\./||' | xargs -P 8 -n 1 sh -c '
  k="$1"
  if "$WRANGLER" r2 object put "konfigurator-assets/$k" --file "$k" --remote >/dev/null 2>&1; then
    echo "OK $k"
  else
    echo "FAIL $k"
  fi
' _ >> "$LOG" 2>&1

ok=$(grep -c "^OK " "$LOG"); fail=$(grep -c "^FAIL " "$LOG")
echo "DONE uploaded=$ok failed=$fail total=$total" | tee -a "$LOG"
