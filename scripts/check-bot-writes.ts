/**
 * How many D1 rows does one bot update write?
 *
 * Run: bun scripts/check-bot-writes.ts
 *
 * The bot used to touch `bot_tenants.last_seen_at`, `bot_users.last_activity`
 * and upsert `bot_sessions` on *every* update, plus an activity row for a new
 * user. On a busy bot that is what drained D1's daily row-write allowance. This
 * harness drives the real functions (`resolveTenant`, `trackUser`,
 * `saveSession`) against a fake database and counts the writes, so the
 * reduction is a number rather than a claim.
 */
import { resolveTenant, saveSession, trackUser } from '../worker/telegram-core'
import type { Env } from '../worker/env'

const USER_ID = 'user-1'
const TG_ID = '555000111'

interface FakeRow {
  id: string
  user_id: string
  telegram_id: string
  access_token: string
  username: string | null
  first_name: string | null
  last_name: string | null
  last_seen_at: string | null
  last_activity: string | null
  state: string
  data: string
  updated_at: string
}

function fakeDb(row: FakeRow) {
  const log: string[] = []
  const db = {
    prepare(sql: string) {
      const statement = {
        params: [] as unknown[],
        bind(...params: unknown[]) {
          statement.params = params
          return statement
        },
        async first() {
          log.push(`read:${sql.split('\n')[0].trim().slice(0, 40)}`)
          if (/FROM bot_tenants/.test(sql)) {
            return {
              id: row.id,
              telegram_id: row.telegram_id,
              user_id: row.user_id,
              access_token: row.access_token,
              username: row.username,
              first_name: row.first_name,
              last_seen_at: row.last_seen_at,
            }
          }
          if (/FROM bot_users/.test(sql)) return { ...row }
          if (/FROM bot_sessions/.test(sql)) return { state: row.state, data: row.data, updated_at: row.updated_at }
          return null
        },
        async all() {
          return { results: [] }
        },
        async run() {
          log.push(`write:${sql.split('\n')[0].trim().slice(0, 40)}`)
          return { success: true }
        },
      }
      return statement
    },
  }
  return { db: db as unknown as Env['DB'], log }
}

const fresh = new Date().toISOString()
const stale = new Date(Date.now() - 60 * 60_000).toISOString()

async function main(): Promise<void> {
  let failures = 0
  const report = (label: string, writes: number, expected: number) => {
    const ok = writes === expected
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${writes} write(s)${ok ? '' : ` — expected ${expected}`}`)
    if (!ok) failures += 1
  }

  // 1. A returning user tapping a button, profile unchanged and stamps fresh.
  const a = fakeDb({
    id: 'tenant-1',
    user_id: USER_ID,
    telegram_id: TG_ID,
    access_token: 'mz-abc',
    username: 'ali',
    first_name: 'علی',
    last_name: null,
    last_seen_at: fresh,
    last_activity: fresh,
    state: 'main',
    data: '{}',
    updated_at: fresh,
  })
  const env = { DB: a.db } as Env
  const tenant = await resolveTenant(env, TG_ID, { username: 'ali', firstName: 'علی' })
  await trackUser(env, { user_id: USER_ID } as never, TG_ID, 'ali', 'علی', null)
  await saveSession(env, tenant.user_id, TG_ID, { state: 'main', data: {} })
  report('fresh stamps, unchanged profile and screen', a.log.filter((l) => l.startsWith('write:')).length, 0)

  // 2. Same tap, but the stamps are an hour old: exactly the throttled columns.
  const b = fakeDb({
    id: 'tenant-1',
    user_id: USER_ID,
    telegram_id: TG_ID,
    access_token: 'mz-abc',
    username: 'ali',
    first_name: 'علی',
    last_name: null,
    last_seen_at: stale,
    last_activity: stale,
    state: 'main',
    data: '{}',
    updated_at: stale,
  })
  const env2 = { DB: b.db } as Env
  const tenant2 = await resolveTenant(env2, TG_ID, { username: 'ali', firstName: 'علی' })
  await trackUser(env2, { user_id: USER_ID } as never, TG_ID, 'ali', 'علی', null)
  await saveSession(env2, tenant2.user_id, TG_ID, { state: 'main', data: {} })
  // One refresh round: tenant stamp, bot_users stamp and the session's
  // `updated_at`. That is the 10-minute tick, not a per-update cost.
  const refreshes = b.log.filter((l) => l.startsWith('write:')).length
  report('stale stamps cost one refresh round (tenant + user + session stamp)', refreshes, 3)

  // 3. The user actually moves to another screen: the session is saved.
  const c = fakeDb({
    id: 'tenant-1',
    user_id: USER_ID,
    telegram_id: TG_ID,
    access_token: 'mz-abc',
    username: 'ali',
    first_name: 'علی',
    last_name: null,
    last_seen_at: fresh,
    last_activity: fresh,
    state: 'main',
    data: '{}',
    updated_at: fresh,
  })
  await saveSession({ DB: c.db } as Env, USER_ID, TG_ID, { state: 'tokens', data: { page: 2 } })
  report('a changed screen is written once', c.log.filter((l) => l.startsWith('write:')).length, 1)

  console.log(failures === 0 ? '\nBot write-count checks passed.' : `\n${failures} check(s) failed.`)
  if (failures) process.exit(1)
}

await main()
