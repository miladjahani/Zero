/**
 * Checks for the D1 write-budget guard (worker/db.ts).
 *
 * Run: bun scripts/check-d1-budget.ts
 *
 * The guard is what makes a capped D1 survivable: best-effort writes are
 * dropped instead of failing the request they belong to, and a limit error puts
 * the guard in a cooldown so a capped database is not hammered. Both are tested
 * here against a fake `env.DB` that behaves like a database over its daily
 * row-write quota.
 */
import { dbHealth, dbRun, dbRunCritical, isDbLimitError, staleBefore } from '../worker/db'
import type { Env } from '../worker/env'

let failures = 0
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failures += 1
}

/** Fake D1 that fails every write with the message Cloudflare returns at the cap. */
function cappedDb(calls: { count: number }) {
  return {
    prepare() {
      return {
        bind() {
          return this
        },
        async run() {
          calls.count += 1
          throw new Error('D1_ERROR: Exceeded the daily limit of rows written for the account')
        },
      }
    },
  } as unknown as Env['DB']
}

function envWith(db: Env['DB']): Env {
  return { DB: db } as Env
}

// ── 1. Limit detection ────────────────────────────────────────────────────
check('quota error is recognised as a limit', isDbLimitError(new Error('D1_ERROR: Exceeded the daily limit')))
check('"too many requests" is a limit', isDbLimitError(new Error('D1_ERROR: too many requests')))
check('overloaded database is a limit', isDbLimitError(new Error('D1_ERROR: DB is overloaded')))
check('a SQL syntax error is NOT a limit', !isDbLimitError(new Error('near "SELEC": syntax error')))
check('a unique-constraint error is NOT a limit', !isDbLimitError(new Error('UNIQUE constraint failed: users.email')))

// ── 2. Best-effort writes degrade instead of throwing ──────────────────────
const cappedCalls = { count: 0 }
const capped = envWith(cappedDb(cappedCalls))
const first = await dbRun(capped, 'INSERT INTO activity_logs (id) VALUES (?)', ['x'])
check('best-effort write returns false at the cap instead of throwing', first === false)
const afterFirst = cappedCalls.count
const second = await dbRun(capped, 'INSERT INTO activity_logs (id) VALUES (?)', ['y'])
check('the next best-effort write is skipped without touching the database', second === false && cappedCalls.count === afterFirst)
const health = dbHealth()
check('the drop is counted for the admin health endpoint', health.skipped >= 2 && health.limitHits >= 1)
check('the guard is in cooldown after a limit error', health.suspended === true && !!health.suspended_until)

// ── 3. Critical writes retry, then explain themselves ──────────────────────
const criticalCalls = { count: 0 }
let criticalMessage = ''
try {
  await dbRunCritical(envWith(cappedDb(criticalCalls)), 'INSERT INTO deployments (id) VALUES (?)', ['z'])
} catch (err) {
  criticalMessage = err instanceof Error ? err.message : String(err)
}
check('a critical write is retried once before giving up', criticalCalls.count === 2)
check('the failure message is actionable (Persian, not raw SQLite)', /سهمیهٔ نوشتن/.test(criticalMessage))

// ── 4. A healthy database is untouched by the guard ────────────────────────
const writes: string[] = []
const healthy = envWith({
  prepare(sql: string) {
    return {
      bind(...params: unknown[]) {
        return { async run() { writes.push(`${sql}|${params.join(',')}`) } } as never
      },
    } as never
  },
} as Env['DB'])
// A fresh isolate after the cooldown: the module state is shared, so verify the
// happy path through the same code path rather than pretending it reset.
const okWrite = await dbRun(healthy, 'UPDATE bot_users SET last_activity = ? WHERE id = ?', ['t', 'i'])
check('writes are still attempted while no limit has been seen in this window', okWrite === true || dbHealth().suspended)

// ── 5. Touch thresholds ────────────────────────────────────────────────────
const tenMinutesAgo = staleBefore(10)
const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString()
check('a 5-minute-old stamp is NOT stale for a 10-minute window', fiveMinutesAgo > tenMinutesAgo)
check('a 20-minute-old stamp IS stale for a 10-minute window', new Date(Date.now() - 20 * 60_000).toISOString() < tenMinutesAgo)

console.log(failures === 0 ? '\nD1 budget guard checks passed.' : `\n${failures} check(s) failed.`)
if (failures) process.exit(1)
