#!/usr/bin/env bash
# Runs ON the droplet. Resolves migrate/out/manifest.tsv (old-path -> clean R2 key)
# against the actual storage files (handling the wrong-folder/alt-root/missing cases),
# and copies everything into a clean staging tree at /tmp/r2 ready for R2 upload.
#
# Usage: scp migrate/out/manifest.tsv droplet:/tmp/manifest.tsv ; ssh droplet 'bash -s' < migrate/reorg.sh
set -euo pipefail
S=/var/www/laravel-konfigurator-2024/storage/app/public
OUT=/tmp/r2
rm -rf "$OUT" /tmp/MISSING.txt
mkdir -p "$OUT"

resolve() {  # $1 = old path (may carry a leading storage/)
  local p="${1#storage/}"
  for c in "$S/$p" "$S/${p/images\//thumbnails\/}" "$S/${p/thumbnails\//images\/}"; do
    [ -f "$c" ] && { echo "$c"; return; }
  done
  find "$S" -name "$(basename "$p")" -type f 2>/dev/null | head -1
}

resolved=0 missing=0
while IFS=$'\t' read -r old new; do
  [ -z "${new:-}" ] && continue
  case "$old" in \#*) continue;; esac
  src=$(resolve "$old")
  if [ -n "$src" ] && [ -f "$src" ]; then
    mkdir -p "$OUT/$(dirname "$new")"; cp "$src" "$OUT/$new"; resolved=$((resolved+1))
  else
    echo "$old -> $new" >> /tmp/MISSING.txt; missing=$((missing+1))
  fi
done < /tmp/manifest.tsv

# whole-folder rules (assets not in the DB): door parts + frame + glass + sideglass
for d in "$S"/images/doors/*/; do code=$(basename "$d"); mkdir -p "$OUT/doors/$code"; cp "$d"*.png "$OUT/doors/$code/" 2>/dev/null || true; done
mkdir -p "$OUT/frame" "$OUT/glass" "$OUT/sideglass"
cp "$S"/images/frame/*     "$OUT/frame/"     2>/dev/null || true
cp "$S"/images/glass/*     "$OUT/glass/"     2>/dev/null || true
cp "$S"/images/sideglass/* "$OUT/sideglass/" 2>/dev/null || true

echo "resolved=$resolved missing=$missing (missing = bad-data codes + deleted files, see /tmp/MISSING.txt)"
du -sh "$OUT"; echo "files: $(find "$OUT" -type f | wc -l)"

# --- Upload to R2 ---
# PROD (fast, needs CF R2 S3 creds via `rclone config` remote named r2):
#   rclone copy /tmp/r2 r2:konfigurator-assets --transfers 32
# LOCAL dev: pull /tmp/r2 down, then loop `wrangler r2 object put ... --local` (slow).
