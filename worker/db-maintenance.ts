import type { Env } from './env'
import { dbRun } from './db'

/**
 * Housekeeping for the D1 database, run from the cron trigger.
 *
 * D1's free plan is metered on rows read *and* rows written. Unbounded tables
 * therefore cost twice: every extra row is another row scanned by the log
 * listing and the "active users" query, and cleaning it up later is itself a
 * write. Keeping the tables bounded here means the budget goes to the work the
 * owner actually asked for.
 *
 * Everything is best-effort: a database already at its cap simply skips a
 * round and the next one cleans up more.
 */
export interface MaintenanceSummary {
  activity_logs_deleted: number
  sessions_deleted: number
  bot_sessions_deleted: number
  deployments_remaining: number
  activity_logs_remaining: number
}

/** Activity log rows older than this are history nobody scrolls back to. */
const LOG_RETENTION_DAYS = 30
/** Hard ceiling so a busy bot cannot grow the table without bound. */
const LOG_MAX_ROWS = 20_000
/** A conversation session untouched this long is abandoned. */
const SESSION_RETENTION_DAYS = 7

async function count(env: Env, sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).first<{ c: number }>().catch(() => null)
  return Number(row?.c ?? 0) || 0
}

/**
 * Piggyback on ordinary requests when there is no cron trigger.
 *
 * A Pages deployment has no `scheduled` handler at all, so the pruning above
 * would only ever run when an admin pressed the button. This checks a timestamp
 * in `db_meta` (one indexed read) at most once per isolate and runs the
 * housekeeping at most once every `MAINTENANCE_INTERVAL_MS`, which keeps the
 * tables bounded without a per-request cost.
 */
const MAINTENANCE_INTERVAL_MS = 6 * 3600_000
let nextAttempt = 0

export async function maybeRunMaintenance(env: Env): Promise<void> {
  if (Date.now() < nextAttempt) return
  nextAttempt = Date.now() + MAINTENANCE_INTERVAL_MS
  const row = await env.DB.prepare("SELECT value FROM db_meta WHERE key = 'last_maintenance'")
    .first<{ value: string }>()
    .catch(() => null)
  if (row?.value && Date.now() - Date.parse(row.value) < MAINTENANCE_INTERVAL_MS) return
  const summary = await runDbMaintenance(env).catch(() => null)
  if (!summary) return
  if (summary.activity_logs_deleted || summary.sessions_deleted || summary.bot_sessions_deleted) {
    console.log('db maintenance (request-driven):', JSON.stringify(summary))
  }
  await dbRun(
    env,
    "INSERT INTO db_meta (key, value) VALUES ('last_maintenance', ?)\n     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [new Date().toISOString()],
  )
}

export async function runDbMaintenance(env: Env): Promise<MaintenanceSummary> {
  const summary: MaintenanceSummary = {
    activity_logs_deleted: 0,
    sessions_deleted: 0,
    bot_sessions_deleted: 0,
    deployments_remaining: 0,
    activity_logs_remaining: 0,
  }

  // 1. Age out old activity.
  const before = await count(env, 'SELECT COUNT(*) c FROM activity_logs')
  if (before > 0) {
    await dbRun(env, `DELETE FROM activity_logs WHERE created_at < datetime('now', ?)`, [
      `-${LOG_RETENTION_DAYS} days`,
    ])
    // 2. Trim to the newest LOG_MAX_ROWS, so a burst of joins cannot fill the
    //    table faster than the retention window empties it.
    await dbRun(
      env,
      `DELETE FROM activity_logs
        WHERE id NOT IN (SELECT id FROM activity_logs ORDER BY created_at DESC LIMIT ?)`,
      [LOG_MAX_ROWS],
    )
    const after = await count(env, 'SELECT COUNT(*) c FROM activity_logs')
    summary.activity_logs_deleted = Math.max(0, before - after)
    summary.activity_logs_remaining = after
  }

  // 3. Expired panel sessions and abandoned bot conversations.
  const sessionsBefore = await count(env, 'SELECT COUNT(*) c FROM sessions')
  if (sessionsBefore > 0) {
    await dbRun(env, `DELETE FROM sessions WHERE expires_at < ?`, [new Date().toISOString()])
    const sessionsAfter = await count(env, 'SELECT COUNT(*) c FROM sessions')
    summary.sessions_deleted = Math.max(0, sessionsBefore - sessionsAfter)
  }

  const botSessionsBefore = await count(env, 'SELECT COUNT(*) c FROM bot_sessions')
  if (botSessionsBefore > 0) {
    await dbRun(env, `DELETE FROM bot_sessions WHERE updated_at < datetime('now', ?)`, [
      `-${SESSION_RETENTION_DAYS} days`,
    ])
    const botSessionsAfter = await count(env, 'SELECT COUNT(*) c FROM bot_sessions')
    summary.bot_sessions_deleted = Math.max(0, botSessionsBefore - botSessionsAfter)
  }

  summary.deployments_remaining = await count(env, 'SELECT COUNT(*) c FROM deployments')
  return summary
}
