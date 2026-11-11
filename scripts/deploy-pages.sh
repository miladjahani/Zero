#!/bin/sh
# Deploy the panel to Cloudflare Pages, the way edgetunnel does it.
#
# edgetunnel ships a repo-root `_worker.js` and you deploy it as a Pages
# project, then attach the bindings in the dashboard. This script does both
# halves in one shot:
#
#   1. create the Pages project if it does not exist yet;
#   2. attach the D1 binding (`DB`) and the non-secret env vars — the manual
#      "Settings → Bindings" step from the README, done through the API;
#   3. build `pages-dist/` (static panel + bundled `_worker.js`);
#   4. upload it with `wrangler pages deploy`.
#
# Requires CLOUDFLARE_API_TOKEN with "Cloudflare Pages: Edit" (and Account
# settings: Read for the project list).
set -eu

ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
TOKEN="${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
# v5 ships as its own Pages project; override with PAGES_PROJECT for any other.
PROJECT="${PAGES_PROJECT:-miliconfigpro}"
DB_NAME="${D1_DATABASE_NAME:-miliconfigpro-v1}"
# Pages project settings are account-scoped too: resolve the database by name
# in the CURRENT account (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN) instead
# of trusting a hardcoded UUID — a stale id makes every binding PATCH fail.
# Override with D1_DATABASE_ID if you know the exact id.
DB_ID="${D1_DATABASE_ID:-$(curl -sS "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database?per_page=500" \
  -H "Authorization: Bearer ${TOKEN}" | DB_NAME="$DB_NAME" python3 -c '
import json, os, sys
try:
    res = json.load(sys.stdin).get("result") or []
except Exception:
    res = []
name = os.environ["DB_NAME"]
m = next((d for d in res if d.get("name") == name), None)
print(m["uuid"] if m else "")
' 2>/dev/null || true)}"

if [ -z "$DB_ID" ]; then
  echo "✗ D1 database '${DB_NAME}' not found in account ${ACCOUNT}." >&2
  echo "  Create it first:  npx wrangler d1 create ${DB_NAME}" >&2
  echo "  …or pass its id explicitly:  D1_DATABASE_ID=<id> sh ./scripts/deploy-pages.sh" >&2
  exit 1
fi
echo "✓ D1 '${DB_NAME}' → ${DB_ID}"
OWNER_EMAIL="milad201400@gmail.com"
BRANCH="main"

api() { # api METHOD PATH [BODY]
  method="$1"; path="$2"; body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}" \
      -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -X "$method" "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}" \
      -H "Authorization: Bearer ${TOKEN}"
  fi
}

echo "── project ${PROJECT} ──"
exists=$(api GET "/pages/projects/${PROJECT}" | python3 -c 'import sys,json;print("yes" if json.load(sys.stdin).get("success") else "no")' 2>/dev/null || echo no)
if [ "$exists" != "yes" ]; then
  echo "not found — creating..."
  api POST "/pages/projects" "{\"name\":\"${PROJECT}\",\"production_branch\":\"${BRANCH}\"}" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print("✓ created" if d.get("success") else "✗ create failed: %s" % d.get("errors"))' || true
fi

echo "── bindings (D1 ${DB_NAME} → env.DB) ──"
api PATCH "/pages/projects/${PROJECT}" "$(python3 - "$DB_ID" "$OWNER_EMAIL" <<'PY'
import json, sys
db_id, owner = sys.argv[1], sys.argv[2]
print(json.dumps({
    "deployment_configs": {
        "production": {
            "d1_databases": {"DB": {"id": db_id}},
            "env_vars": {"OWNER_EMAIL": {"value": owner}, "PANEL_URL": {"value": ""}},
        },
        "preview": {
            "d1_databases": {"DB": {"id": db_id}},
            "env_vars": {"OWNER_EMAIL": {"value": owner}, "PANEL_URL": {"value": ""}},
        },
    }
}))
PY
)" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("✓ bindings attached" if d.get("success") else "✗ binding failed: %s" % d.get("errors"))'

echo "── building ──"
sh ./scripts/build-pages.sh

echo "── uploading ──"
npx wrangler pages deploy pages-dist \
  --project-name "$PROJECT" --branch "$BRANCH" --commit-dirty=true
