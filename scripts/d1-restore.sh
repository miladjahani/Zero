#!/bin/sh
# Restore the panel's D1 database from an off-site snapshot.
#
# This is the "move the panel to another Cloudflare account without losing the
# admin and user data" path (see .github/workflows/d1-backup.yml, which writes a
# full SQL dump to the `d1-backups` branch every day):
#
#   1. download the newest snapshot and restore it into the target account
#   2. put the printed database_id into wrangler.toml (or your deploy config)
#   3. deploy, then sign in with the SAME admin email/password as before
#
# The dump contains the panel's secrets (password hashes, Cloudflare tokens, the
# bot token), so keep it on the private repo / a private machine only.
#
# usage: sh ./scripts/d1-restore.sh <snapshot.sql> [database-name]
#        default database name: miliconfigpro-v1 (the name the panel expects)
#
# The target database must be empty. If the panel already ran on it (so
# `ensureSchema` created the tables), the script refuses to touch them unless you
# pass FORCE=1, which drops every existing table before importing.
set -eu

DUMP="${1:-}"
DB_NAME="${2:-miliconfigpro-v1}"

if [ -z "${DUMP}" ] || [ ! -f "${DUMP}" ]; then
  echo "usage: sh ./scripts/d1-restore.sh <snapshot.sql> [database-name]" >&2
  echo "" >&2
  echo "Fetch the newest snapshot first, e.g.:" >&2
  echo "  git fetch origin d1-backups && git show origin/d1-backups:backups/d1-\$(date -u +%F).sql > /tmp/d1.sql" >&2
  echo "  gh api 'repos/<owner>/<repo>/contents/backups?ref=d1-backups' --jq '.[].name'" >&2
  exit 2
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "⚠ CLOUDFLARE_API_TOKEN is not set — wrangler will use its own logged-in session." >&2
fi

echo "── target account ──"
npx --yes wrangler@4 whoami 2>/dev/null | sed -n '2p;3p' || true

# ── Resolve or create the database in the target account ───────────────────
echo "── resolving D1 database '${DB_NAME}' ──"
DB_ID=$(npx --yes wrangler@4 d1 list --json 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(s);
    const arr = Array.isArray(parsed) ? parsed : parsed.result || [];
    const m = arr.find((x) => x.name === process.argv[1] || x.database_name === process.argv[1]);
    console.log(m ? m.uuid || m.database_id || "" : "");
  } catch { console.log(""); }
})' "${DB_NAME}") || DB_ID=""

if [ -z "${DB_ID}" ]; then
  echo "not found — creating '${DB_NAME}'..."
  CREATE_OUT=$(npx --yes wrangler@4 d1 create "${DB_NAME}" 2>&1) || true
  DB_ID=$(printf '%s' "${CREATE_OUT:-}" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n 1 || true)
fi

if [ -z "${DB_ID}" ]; then
  echo "✗ could not resolve or create the database '${DB_NAME}'." >&2
  echo "  Check that the account in CLOUDFLARE_ACCOUNT_ID (or your wrangler login) can manage D1." >&2
  exit 1
fi
echo "✓ database_id: ${DB_ID}"

# ── Guard: the dumps create real tables, so the target must start empty ────
# Deploying the panel first (or opening it once) runs `ensureSchema`, which is
# what usually happens — in that case the table already exists and a plain
# import would fail halfway. Wiping a populated database is destructive, so it
# only happens with FORCE=1.
existing_tables() {
  # Newest table first: our schema creates every parent (users, deployments) before
  # the tables that reference it, so dropping in reverse creation order never
  # removes a table another DROP still depends on (which D1 rejects with
  # "no such table: main.users").
  npx --yes wrangler@4 d1 execute "${DB_NAME}" --remote -y --command \
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid DESC" \
    2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const i = s.indexOf("[");
    const rows = JSON.parse(s.slice(i))[0].results || [];
    console.log(rows.map((r) => r.name).join(" "));
  } catch { console.log(""); }
})' || true
}

TABLES=$(existing_tables)
if [ -n "${TABLES}" ]; then
  if [ "${FORCE:-0}" != "1" ]; then
    echo "✗ '${DB_NAME}' already has tables ($(printf '%s' "${TABLES}" | wc -w | tr -d ' ') of them)." >&2
    echo "  Restoring the snapshot replaces them — re-run with FORCE=1 if you are sure" >&2
    echo "  this database may be wiped (a fresh account needs no flag):" >&2
    echo "    FORCE=1 sh ./scripts/d1-restore.sh ${DUMP} ${DB_NAME}" >&2
    exit 1
  fi
  echo "── FORCE=1: dropping the $(printf '%s' "${TABLES}" | wc -w | tr -d ' ') existing table(s) ──"
  RESET_SQL="/tmp/d1-restore-drop-$$.sql"
  printf 'PRAGMA defer_foreign_keys=TRUE;\n' > "${RESET_SQL}"
  for t in ${TABLES}; do printf 'DROP TABLE IF EXISTS "%s";\n' "${t}" >> "${RESET_SQL}"; done
  npx --yes wrangler@4 d1 execute "${DB_NAME}" --remote --file="${RESET_SQL}" -y >/dev/null
  rm -f "${RESET_SQL}"
  echo "✓ existing tables dropped"
fi

# ── Import the snapshot ────────────────────────────────────────────────────
# `wrangler d1 execute --file` runs the dump's statements in order; the dumps
# start with `PRAGMA defer_foreign_keys=TRUE` so parent/child order never
# matters and every row lands.
echo "── importing snapshot ($(wc -c < "${DUMP}" | tr -d ' ') bytes) ──"
npx --yes wrangler@4 d1 execute "${DB_NAME}" --remote --file="${DUMP}" -y >/dev/null
echo "✓ snapshot imported"

# ── Prove the admin account came across ────────────────────────────────────
echo "── restored row counts ──"
npx --yes wrangler@4 d1 execute "${DB_NAME}" --remote -y --command \
  "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM cf_tokens) AS cf_tokens, (SELECT COUNT(*) FROM deployments) AS deployments, (SELECT COUNT(*) FROM app_settings) AS app_settings" \
  2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const start = s.indexOf("[");
    const rows = JSON.parse(s.slice(start))[0].results[0];
    console.log("  " + Object.entries(rows).map(([k, v]) => `${k}=${v}`).join("  "));
    if (!rows.users) { console.log("  ✗ no users restored — check the snapshot file"); process.exit(1); }
  } catch { console.log("  (could not read the count output; verify manually)"); }
})' || true

cat <<EOF

── next steps ──
1. deploy — scripts/deploy.sh resolves the database by name in the current
   account, so nothing has to be edited; to pin this exact id instead:
     D1_DATABASE_ID="${DB_ID}" sh ./scripts/deploy.sh
   (wrangler.toml deliberately carries no hardcoded database_id)
2. sign in with the SAME admin email/password as before — the users table came
   across, so nothing has to be re-created.
3. point the daily backup at the new account: update CLOUDFLARE_ACCOUNT_ID (and
   CLOUDFLARE_API_TOKEN) in the repository's Actions secrets, otherwise the
   off-site snapshots keep coming from the old account.
EOF
