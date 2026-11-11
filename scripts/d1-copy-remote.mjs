#!/usr/bin/env node
/**
 * Copy a D1 database into another account's database over the HTTP API.
 *
 * `wrangler d1 execute --file` sends the whole file as ONE query, which a real
 * panel dump (tens of MB) exceeds, and Time Travel can only fork inside the
 * same account. This script therefore:
 *
 *   1. reads a `wrangler d1 export` dump,
 *   2. splits it into complete statements with a quote-aware scanner (a value
 *      containing `;` or a newline must never split a statement),
 *   3. posts them in batches of ~100 KB (the API's practical ceiling), halving
 *      the batch and retrying when a batch is rejected, and
 *   4. prints table counts at the end so the copy can be verified.
 *
 * Usage:
 *   SRC_ACCOUNT=… TARGET_TOKEN=… TARGET_ACCOUNT=… TARGET_DB=… \
 *     node scripts/d1-copy-remote.mjs /tmp/panel-d1.sql
 *
 * Everything is idempotent-safe in the sense that it refuses to run against a
 * database that already has rows unless FORCE=1 (which deletes from the tables
 * the dump mentions first).
 */
import { readFileSync } from 'node:fs'

const dumpPath = process.argv[2]
if (!dumpPath) {
  console.error('usage: d1-copy-remote.mjs <dump.sql>')
  process.exit(2)
}
const targetToken = process.env.TARGET_TOKEN ?? ''
const targetAccount = process.env.TARGET_ACCOUNT ?? ''
const targetDb = process.env.TARGET_DB ?? ''
if (!targetToken || !targetAccount || !targetDb) {
  console.error('TARGET_TOKEN, TARGET_ACCOUNT and TARGET_DB are required')
  process.exit(2)
}

const API = 'https://api.cloudflare.com/client/v4'
const BATCH_BYTES = Number(process.env.BATCH_BYTES ?? 100_000)
const headers = { Authorization: `Bearer ${targetToken}`, 'Content-Type': 'application/json' }

/** Split SQL text into complete statements, ignoring `;` inside 'strings'. */
function splitStatements(sql) {
  const out = []
  let start = 0
  let inString = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inString) {
      if (ch === "'") {
        // '' is an escaped quote inside a literal, not the end of the string.
        if (sql[i + 1] === "'") i++
        else inString = false
      }
      continue
    }
    if (ch === "'") inString = true
    else if (ch === ';') {
      const stmt = sql.slice(start, i + 1).trim()
      if (stmt && stmt !== ';') out.push(stmt)
      start = i + 1
    }
  }
  const tail = sql.slice(start).trim()
  if (tail) out.push(tail)
  return out
}

async function query(sql) {
  const resp = await fetch(`${API}/accounts/${targetAccount}/d1/database/${targetDb}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || data.success === false) {
    const message = data.errors?.[0]?.message ?? `HTTP ${resp.status}`
    throw new Error(message)
  }
  return data.result
}

/** Send one batch, halving it on rejection so a too-large request can't stall the copy. */
async function sendBatch(statements) {
  const sql = `PRAGMA defer_foreign_keys=TRUE;\n${statements.join('\n')}`
  if (!statements.length) return 0
  try {
    await query(sql)
    return statements.length
  } catch (err) {
    if (statements.length === 1) throw err
    const half = Math.floor(statements.length / 2)
    const done = await sendBatch(statements.slice(0, half))
    return done + (await sendBatch(statements.slice(half)))
  }
}

const dump = readFileSync(dumpPath, 'utf8')
const statements = splitStatements(dump)
console.log(`dump: ${(dump.length / 1e6).toFixed(1)} MB · ${statements.length} statements`)

// Does the target already hold data? Re-running over a populated database would
// fail on primary keys halfway through, so it is refused unless FORCE=1.
if (process.env.FORCE === '1') {
  const tables = [...new Set(statements
    .map((s) => /^(?:CREATE TABLE (?:IF NOT EXISTS )?|INSERT INTO )"?(\w+)"?/i.exec(s)?.[1])
    .filter(Boolean)
    .map((t) => `"${t}"`))]
  console.log(`FORCE=1 — clearing ${tables.length} table(s) in the target`)
  for (const table of tables) await query(`DELETE FROM ${table}`).catch(() => null)
}

let batch = []
let bytes = 0
let sent = 0
for (const stmt of statements) {
  // The dump's own PRAGMA line is repeated per batch by sendBatch().
  if (/^PRAGMA/i.test(stmt)) continue
  batch.push(stmt)
  bytes += stmt.length + 1
  if (bytes >= BATCH_BYTES) {
    sent += await sendBatch(batch)
    process.stdout.write(`\r  ${sent}/${statements.length} statements sent`)
    batch = []
    bytes = 0
  }
}
if (batch.length) sent += await sendBatch(batch)
process.stdout.write(`\r  ${sent}/${statements.length} statements sent\n`)

const counts = await query(
  `SELECT (SELECT COUNT(*) FROM users) AS users,
          (SELECT COUNT(*) FROM deployments) AS deployments,
          (SELECT COUNT(*) FROM cf_tokens) AS cf_tokens,
          (SELECT COUNT(*) FROM bot_users) AS bot_users,
          (SELECT COUNT(*) FROM sessions) AS sessions`,
)
console.log('  target counts:', JSON.stringify(counts[0]?.results?.[0] ?? counts[0]))
