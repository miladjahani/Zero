#!/bin/sh
# Build the panel for Cloudflare **Pages** (the edgetunnel-style deployment).
#
# edgetunnel deploys as a Pages project whose root holds a single `_worker.js`:
# Pages "advanced mode" gives that file every request and the worker serves the
# static UI itself through `env.ASSETS.fetch()`. This script reproduces exactly
# that layout:
#
#   pages-dist/
#     index.html, assets/**   ← the Vite build (panel UI)
#     _worker.js              ← the API worker, bundled to one file
#
# scripts/deploy-pages.sh creates the project, attaches the D1 binding and the
# env vars (the dashboard step the edgetunnel README asks for), then uploads it.
set -eu

OUT="pages-dist"

echo "── building frontend ──"
npx vite build

echo "── assembling ${OUT} ──"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R dist/. "$OUT"/

echo "── bundling worker → ${OUT}/_worker.js ──"
npx esbuild worker/index.ts \
  --bundle --format=esm --platform=browser --target=es2022 \
  --external:cloudflare:sockets \
  --outfile="$OUT/_worker.js" \
  --log-level=warning

test -s "$OUT/_worker.js" || { echo "✗ _worker.js was not produced" >&2; exit 1; }
echo "✓ $(du -h "$OUT/_worker.js" | cut -f1) _worker.js ($(find "$OUT" -type f | wc -l) files total)"
