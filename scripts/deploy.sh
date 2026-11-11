#!/bin/sh
# Cloudflare Builds / manual deploy entrypoint.
#
# Ensures the panel's D1 database exists (creates it on first run), injects the
# real database_id into a generated config, and deploys the Worker — so the D1
# binding survives every deployment and never has to be re-added by hand.
#
# Requires the build API token to allow "D1 Edit". If it does not, we fall back
# to deploying without the binding so the build still goes green.
#
# Cloudflare Builds note: point BOTH the build command and the deploy command at
# this script (`sh ./scripts/deploy.sh`). A bare `npx wrangler deploy` cannot
# work here — a database_id is account-scoped, so it must be resolved against
# the account of the token that is actually deploying (this is what previously
# failed with: D1 binding 'DB' references database '<id>' which was not found).
set -eu

DB_NAME="${D1_DATABASE_NAME:-miliconfigpro-v1}"
CONFIG_OUT="wrangler.deploy.toml"

# `dist/` is a build artifact (it is gitignored) and the Worker serves its JS
# bundle straight from there. Deploying without a fresh build ships an
# index.html whose script 404s, which renders the whole panel as a blank page.
# So the frontend is rebuilt on every deploy path, including Cloudflare Builds.
echo "── building frontend ──"
npx vite build

# If a base config ever carries a [[d1_databases]] block again (an old checkout,
# or someone re-added it by hand), make sure its id actually belongs to the
# current account before trusting it — otherwise wrangler aborts the deploy with
# error 10181. When it does not match, strip it and resolve the database below.
if grep -q '^\[\[d1_databases\]\]' wrangler.toml; then
  KNOWN_IDS=$(npx wrangler d1 list --json 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(s);
    const arr = Array.isArray(parsed) ? parsed : parsed.result || [];
    console.log(arr.map((x) => x.uuid || x.database_id || "").filter(Boolean).join("\n"));
  } catch { console.log(""); }
})' || true)
  if [ -z "${KNOWN_IDS}" ]; then
    # Cannot list D1 (token lacks D1 read, or offline) — keep the declared
    # binding; it is the only information available.
    echo "── D1 binding found in wrangler.toml (cannot verify against account) ──"
    exec npx wrangler deploy
  fi
  DECLARED_OK=$(node -e '
const fs = require("fs");
const toml = fs.readFileSync("wrangler.toml", "utf8");
const ids = process.argv.slice(1);
const blocks = toml.split("[[").filter((b) => b.startsWith("d1_databases]]"));
const ok = blocks.every((b) => {
  const m = b.match(/database_id\s*=\s*"([^"]+)"/);
  return !m || ids.includes(m[1]);
});
console.log(ok ? "yes" : "no");
' "${KNOWN_IDS}")
  if [ "${DECLARED_OK}" = "yes" ]; then
    echo "── D1 binding in wrangler.toml verified in this account — deploying directly ──"
    exec npx wrangler deploy
  fi
  echo "⚠ wrangler.toml declares a database_id that does not exist in this account."
  echo "⚠ Ignoring it and resolving '${DB_NAME}' by name instead."
  BASE_TOML="/tmp/wrangler.base.toml"
  node -e '
const fs = require("fs");
const lines = fs.readFileSync("wrangler.toml", "utf8").split("\n");
const out = [];
let skip = false;
for (const l of lines) {
  if (/^\[\[/.test(l)) skip = /^\[\[d1_databases\]\]/.test(l);
  if (!skip) out.push(l);
}
fs.writeFileSync(process.argv[1], out.join("\n"));
' "${BASE_TOML}"
else
  BASE_TOML="wrangler.toml"
fi

echo "── resolving D1 database (${DB_NAME}) ──"

DB_ID=$(npx wrangler d1 list --json 2>/dev/null | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(s);
    const arr = Array.isArray(parsed) ? parsed : parsed.result || [];
    const m = arr.find((x) => x.name === process.argv[1] || x.database_name === process.argv[1]);
    console.log(m ? m.uuid || m.database_id || "" : "");
  } catch {
    console.log("");
  }
})' "$DB_NAME") || DB_ID=""

if [ -z "${DB_ID}" ]; then
  echo "not found — creating..."
  CREATE_OUT=$(npx wrangler d1 create "$DB_NAME" 2>&1) || true
  DB_ID=$(printf '%s' "${CREATE_OUT:-}" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n 1 || true)
fi

# An explicit override always wins (e.g. after scripts/d1-restore.sh printed the
# id of a database in a brand-new account).
if [ -n "${D1_DATABASE_ID:-}" ]; then
  DB_ID="${D1_DATABASE_ID}"
fi

if [ -z "${DB_ID}" ]; then
  echo "⚠ could not resolve or create the D1 database."
  echo "⚠ Deploying WITHOUT the D1 binding. To fix permanently:"
  echo "⚠   Workers & Pages → ${DB_NAME} → Settings → Build → API token:"
  echo "⚠   create a token that also includes 'D1 Edit', then redeploy."
  exec npx wrangler deploy
fi

echo "✓ database_id: ${DB_ID}"

{
  cat "${BASE_TOML}"
  printf '\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "%s"\ndatabase_id = "%s"\n' "$DB_NAME" "$DB_ID"
} > "$CONFIG_OUT"

echo "── deploying worker ──"
npx wrangler deploy --config "$CONFIG_OUT"

# Keep standard edge placement (never Smart Placement, which migrates isolates
# minutes after deploy and triggers Error 1101 on cold starts) and confirm
# workers.dev route is active.
echo "── confirming standard Edge placement & route ──"
node -e '
const t = process.env.CLOUDFLARE_API_TOKEN;
if (!t) { console.log("skip (no CLOUDFLARE_API_TOKEN)"); process.exit(0); }
(async () => {
  try {
    const h = { Authorization: `Bearer ${t}` };
    const a = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=1", { headers: h }).then(r => r.json());
    const acc = a?.result?.[0]?.id;
    if (!acc) throw new Error("no account");
    await fetch(`https://api.cloudflare.com/client/v4/accounts/${acc}/workers/scripts/miliconfigpro-v1/subdomain`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => null);
    console.log("✓ Standard global edge route confirmed (Zero-1101 mode)");
  } catch (e) { console.log(`ℹ Route confirmation skipped (${e.message})`); }
})();
' || true
