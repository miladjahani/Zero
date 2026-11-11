import type { Env } from './env'

/**
 * D1 write budget guard.
 *
 * The free plan allows a fixed number of rows *written* per day (100k at the
 * time of writing) and the panel genuinely exhausted it: a bulk import plus
 * per-update bookkeeping (`bot_tenants.last_seen_at`, `bot_users.last_activity`,
 * a row of `activity_logs` per tap) burned the whole budget in a few hours, at
 * which point *every* write — including the ones a user is waiting on — failed
 * with `D1_ERROR` and the UI showed a raw SQL error.
 *
 * So writes are split in two:
 *
 *   • `dbRun`            — best-effort. Bookkeeping, log lines, "last seen"
 *                          stamps. When the day's budget runs out these are
 *                          silently dropped (and counted) instead of failing the
 *                          request they belong to.
 *   • `dbRunCritical`    — the row the user asked to write. Retried once, then
 *                          surfaced as a readable error so the UI can say
 *                          "سهمیهٔ نوشتن D1 تمام شده" instead of SQLite noise.
 *
 * Once a limit error is seen, `dbRun` stops trying for a while: hammering a
 * capped database only spends quota on failed calls. The cooldown is short
 * enough that a reset (the daily budget resets at 00:00 UTC) is picked up.
 */

const COOLDOWN_MS = 5 * 60_000

let suspendedUntil = 0
const counters = {
  writes: 0,
  skipped: 0,
  limitHits: 0,
  lastLimitAt: null as string | null,
  lastLimitMessage: null as string | null,
  criticalFailures: 0,
}

/** Do these error words mean "D1 is out of budget / overloaded" rather than "your SQL is wrong"? */
export function isDbLimitError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (!message) return false
  return (
    message.includes('exceeded') ||
    message.includes('too many requests') ||
    message.includes('daily limit') ||
    message.includes('rate limit') ||
    message.includes('overloaded') ||
    message.includes('d1_error: 429') ||
    message.includes('database is locked')
  )
}

function noteLimit(err: unknown): void {
  counters.limitHits += 1
  counters.lastLimitAt = new Date().toISOString()
  counters.lastLimitMessage = err instanceof Error ? err.message : String(err ?? '')
  suspendedUntil = Date.now() + COOLDOWN_MS
  console.warn('D1 write budget exhausted, pausing best-effort writes:', counters.lastLimitMessage)
}

/**
 * Run a statement whose failure must not fail the request (bookkeeping writes).
 * Returns `true` when it was written, `false` when it was skipped or dropped.
 */
export async function dbRun(
  env: Env,
  sql: string,
  params: unknown[] = [],
): Promise<boolean> {
  if (Date.now() < suspendedUntil) {
    counters.skipped += 1
    return false
  }
  try {
    await env.DB.prepare(sql).bind(...params).run()
    counters.writes += 1
    return true
  } catch (err) {
    if (isDbLimitError(err)) {
      counters.skipped += 1
      noteLimit(err)
      return false
    }
    throw err
  }
}

/**
 * Run a statement the user is waiting on. One retry (a transient 429 is
 * common), then a readable error. Never retried more: a capped database will
 * keep refusing until the budget resets.
 */
export async function dbRunCritical(env: Env, sql: string, params: unknown[] = []): Promise<void> {
  try {
    await env.DB.prepare(sql).bind(...params).run()
    counters.writes += 1
  } catch (err) {
    if (!isDbLimitError(err)) throw err
    noteLimit(err)
    await new Promise((resolve) => setTimeout(resolve, 250))
    try {
      await env.DB.prepare(sql).bind(...params).run()
      counters.writes += 1
      return
    } catch (retryErr) {
      if (!isDbLimitError(retryErr)) throw retryErr
      counters.criticalFailures += 1
      throw new Error(
        'سهمیهٔ نوشتن روزانهٔ D1 تمام شده — نوشتن در این دیتابیس تا ریست شدن سهمیه (نیمه‌شب UTC) ممکن نیست. ' +
          'برای برداشتن این سقف، پلن Workers Paid را روی حساب فعال کنید.',
      )
    }
  }
}

/** Snapshot for `GET /api/admin/db-health`. */
export function dbHealth() {
  return {
    ...counters,
    suspended: Date.now() < suspendedUntil,
    suspended_until: Date.now() < suspendedUntil ? new Date(suspendedUntil).toISOString() : null,
  }
}

// ── Write throttling ───────────────────────────────────────────────────────
//
// "Last seen" style columns were being written on *every* bot update. Compare
// and skip when the stored value is fresh: one conditional UPDATE with a
// timestamp guard costs a read and writes nothing at all, where the old
// unconditional UPDATE wrote a row per keystroke.

/** ISO timestamp used as the "older than this is stale" threshold. */
export function staleBefore(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}
