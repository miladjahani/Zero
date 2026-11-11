import type { Env } from './env'
import { dbRun, staleBefore } from './db'
import { genId, nowIso, safeJsonParse } from './util'

/**
 * How stale a conversational "last seen" stamp may get before it is rewritten.
 * Ten minutes keeps the owner's "active users" figure meaningful while cutting
 * the writes that used to happen on every single update.
 */
const TOUCH_MINUTES = 10

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram core — Bot API client, config resolution, access control,
//  conversation sessions and owner notifications.
//
//  The screen/UI layer lives in worker/telegram-ui.ts and the HTTP entry point
//  in worker/telegram.ts. Keeping them apart keeps every file small enough to
//  edit surgically.
// ══════════════════════════════════════════════════════════════════════════════

export interface TgUser { id: number; username?: string; first_name?: string; last_name?: string }
export interface TgMessage { message_id: number; chat: { id: number }; from?: TgUser; text?: string }
export interface TgCallbackQuery {
  id: string
  data?: string
  from?: TgUser
  message?: { message_id?: number; chat?: { id?: number } }
}
export interface TgUpdate { message?: TgMessage; callback_query?: TgCallbackQuery }

export interface BotConfigRow {
  id: string
  user_id: string
  bot_token: string
  is_active: number
  welcome_message: string
  chat_id?: string | null
  bot_username?: string | null
  /** Legacy one-time claim code — the public deployer bot has no owner gate. */
  claim_code?: string | null
}

export interface BotSession { state: string; data: Record<string, unknown> }

/** A Telegram user of the public deployer bot — their own isolated space. */
export interface BotTenant {
  id: string
  telegram_id: string
  /** Synthetic, sign-in-less panel account that owns this space's data. */
  user_id: string
  /** The tenant's unique route token (also the personal deep-link payload). */
  access_token: string
  username?: string | null
  first_name?: string | null
  /** Last time this tenant was seen; throttled, so it is often minutes old. */
  last_seen_at?: string | null
}

/** Deployments a bot tenant may run (the panel owner can't be reached to ask). */
export const BOT_TENANT_QUOTA = 10

/**
 * Telegram's own button styles (Bot API 9.4+): `success` (green), `danger`
 * (red) and `primary` (blue). There is no arbitrary colour — the client picks
 * the shade for its current theme, which is exactly what keeps the buttons
 * looking native (and readable in both light and dark).
 */
export type TgButtonStyle = 'success' | 'danger' | 'primary'

export interface TgButton {
  text: string
  callback_data?: string
  url?: string
  /** Omitted = the client's default. Older clients simply ignore the field. */
  style?: TgButtonStyle
}
export interface TgKeyboard { inline_keyboard: TgButton[][] }
export interface Screen { text: string; keyboard?: TgKeyboard }

export interface ScreenCtx {
  env: Env
  cfg: BotConfigRow
  chatId: number | string
  telegramId: string
  /**
   * Owner of the data this screen may touch: the Telegram user's own isolated
   * space (bot_tenants.user_id) — never a panel account, never another user.
   */
  userId: string
  /** The caller's tenant row — their unique token and identity. */
  tenant?: BotTenant | null
  /** Bot @username, for building the personal deep link. */
  botUsername?: string | null
  /** Panel origin — used for links back into the web app. */
  origin: string
}

export interface TgEnvelope<T> { ok: boolean; result?: T; description?: string }

// ── Bot API client ───────────────────────────────────────────────────────────

export async function tg<T = unknown>(token: string, method: string, body: Record<string, unknown>): Promise<TgEnvelope<T>> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await resp.json()) as TgEnvelope<T>
  } catch {
    return { ok: false }
  }
}

export async function sendMsg(token: string, chatId: string | number, text: string, keyboard?: object): Promise<number | null> {
  const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }
  if (keyboard) body.reply_markup = keyboard
  const res = await tg<{ message_id?: number }>(token, 'sendMessage', body)
  return res.result?.message_id ?? null
}

/** Render a screen into an existing message when possible, else send a new one. */
export async function renderScreen(
  token: string,
  chatId: string | number,
  messageId: number | null,
  screen: Screen,
): Promise<number | null> {
  if (messageId) {
    const res = await tg<{ message_id?: number }>(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: screen.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(screen.keyboard ? { reply_markup: screen.keyboard } : {}),
    })
    if (res.ok) return messageId
    // 400 "message is not modified" just means the screen already shows this
    // content — nothing to do. Anything else falls back to a fresh message.
    if ((res.description ?? '').toLowerCase().includes('not modified')) return messageId
  }
  return await sendMsg(token, chatId, screen.text, screen.keyboard)
}

export function answerCb(token: string, id: string, text?: string): Promise<TgEnvelope<unknown>> {
  return tg(token, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) })
}

/**
 * Where the panel UI lives.
 *
 * By default the SPA is served by this same Worker, so the request origin *is*
 * the panel. When the panel is hosted on a different domain, set `PANEL_URL`
 * and every link back into the app — including the bot's "باز کردن پنل" menu
 * button — points there instead. The webhook URL deliberately keeps the
 * Worker's own origin, because Telegram must reach the Worker itself.
 */
export function panelAppUrl(env: Env, origin: string): string {
  const override = (env.PANEL_URL ?? '').trim().replace(/\/+$/, '')
  return override || origin
}

/** Register the bot's command list, profile texts and menu button. */
export async function syncBotProfile(token: string, webAppUrl: string): Promise<void> {
  await tg(token, 'setMyCommands', {
    commands: [
      { command: 'start', description: 'شروع و ساخت فضای اختصاصی شما' },
      { command: 'deploy', description: 'استقرار ورکر یا پنل (Railway/Render)' },
      { command: 'workers', description: 'ورکرهای خودتان' },
      { command: 'panels', description: 'پنل‌های آمادهٔ استقرار' },
      { command: 'servers', description: 'پنل‌های Railway و Render شما' },
      { command: 'tokens', description: 'توکن‌های شما (Cloudflare/Railway/Render)' },
      { command: 'profile', description: 'توکن و لینک اختصاصی شما' },
      { command: 'recover', description: 'بازیابی و رفع فوری خطای ۱۱۰۱ ورکرها' },
      { command: 'update', description: 'به‌روزرسانی ورکرها به آخرین نسخه مخزن' },
      { command: 'quickstart', description: 'شروع سریع' },
      { command: 'menu', description: 'نمایش منو' },
      { command: 'help', description: 'راهنما' },
    ],
  })
  await tg(token, 'setMyDescription', {
    description:
      'ربات عمومی استقرار — ورکر کلودفلر بسازید یا پنل را روی Railway/Render بالا بیاورید. هر کاربر فضای اختصاصی خودش (توکن و لینک یکتا) را دارد و استقرارها با توکن خودِ او انجام می‌شود.',
  })
  await tg(token, 'setMyShortDescription', { short_description: 'استقرار ورکر و پنل، با توکن خودتان.' })
  await tg(token, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'باز کردن پنل', web_app: { url: webAppUrl } },
  })
}

// ── Config + sessions ────────────────────────────────────────────────────────

const CONFIG_COLUMNS = 'id, user_id, bot_token, bot_username, is_active, welcome_message, chat_id, claim_code'

export async function getActiveConfig(env: Env): Promise<BotConfigRow | null> {
  return env.DB.prepare(`SELECT ${CONFIG_COLUMNS} FROM bot_config WHERE is_active = 1 ORDER BY created_at LIMIT 1`)
    .first<BotConfigRow>()
}

/** How many bots are live right now — 0 or 1 means "a single-bot install". */
export async function activeBotCount(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM bot_config WHERE is_active = 1').first<{ c: number }>()
  return row?.c ?? 0
}

/**
 * Resolve which bot_config an incoming update belongs to.
 *
 * Every panel user runs **their own bot with their own tokens**, so routing must
 * be exact: Telegram echoes back the secret_token registered via setWebhook in
 * the X-Telegram-Bot-Api-Secret-Token header, and that secret maps to exactly one
 * bot_config row.
 *
 * The old code fell back to "the first active row" whenever the secret did not
 * match, which meant a second user's traffic could be served by the first user's
 * row — reading (and deploying with) *their* Cloudflare token. Now:
 *   • a matching secret wins, and
 *   • a header that matches nothing is dropped (the row is inactive/deleted), and
 *   • the legacy no-secret fallback only applies when the install genuinely runs
 *     a single bot (count == 1), so single-bot setups keep working.
 */
export async function resolveConfig(env: Env, request: Request): Promise<BotConfigRow | null> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
  if (secret) {
    return env.DB.prepare(
      `SELECT ${CONFIG_COLUMNS} FROM bot_config WHERE webhook_secret = ? AND is_active = 1 LIMIT 1`,
    ).bind(secret).first<BotConfigRow>()
  }
  // No secret header: only a single-bot install may still be routed by default.
  if ((await activeBotCount(env)) !== 1) return null
  return getActiveConfig(env)
}

/** Best-effort delete of a chat message (used to wipe pasted secrets). */
export async function deleteMsg(token: string, chatId: string | number, messageId: number): Promise<void> {
  await tg(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => null)
}

/** Strip invisible Unicode and whitespace that copy-paste injects into secrets. */
export function sanitizeSecret(raw: string): string {
  return raw
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\s]/g, '')
    .trim()
}

export async function saveOwnerChat(env: Env, cfg: BotConfigRow, chatId: number | string): Promise<void> {
  if (String(cfg.chat_id ?? '') === String(chatId)) return
  await env.DB.prepare('UPDATE bot_config SET chat_id = ?, updated_at = ? WHERE id = ?')
    .bind(String(chatId), nowIso(), cfg.id)
    .run()
  cfg.chat_id = String(chatId)
}

// ── Public-bot tenants ───────────────────────────────────────────────────────
//
// The bot is a standalone deployment tool, open to everyone: it is NOT tied to a
// panel account, so there is no owner/admin gate and no claim code. Every
// Telegram user gets their own space — a unique access token (their personal
// route/identity) plus an isolated, sign-in-less owner record for tokens and
// deployments. One user can never see or deploy with another user's token.

const TENANT_COLUMNS = 'id, telegram_id, user_id, access_token, username, first_name, last_seen_at'

/** Personal tokens look like `mz-xxxxxxxxxxxx`. */
function newTenantToken(): string {
  return `mz-${genId().replace(/-/g, '').slice(0, 12)}`
}

/** Tenant by their unique token (deep links, `/start <token>`). */
export async function tenantByToken(env: Env, token: string): Promise<BotTenant | null> {
  return env.DB.prepare(`SELECT ${TENANT_COLUMNS} FROM bot_tenants WHERE access_token = ? LIMIT 1`)
    .bind(token.trim())
    .first<BotTenant>()
}

/**
 * Resolve (or provision) the space of the Telegram user behind an update.
 * The synthetic account is never given a usable password — it exists purely so
 * the existing deploy engine, quota and token tables can hold this user's data.
 */
export async function resolveTenant(
  env: Env,
  telegramId: string,
  profile: { username?: string | null; firstName?: string | null },
): Promise<BotTenant> {
  const existing = await env.DB.prepare(`SELECT ${TENANT_COLUMNS} FROM bot_tenants WHERE telegram_id = ?`)
    .bind(telegramId)
    .first<BotTenant>()
  if (existing) {
    // Refreshing the display name is a convenience, never a precondition for
    // answering: this used to be an unguarded write on *every* update, so a D1
    // write hiccup (the daily row-write cap, a transient 429) threw here and the
    // whole update was dropped before any screen was rendered — the bot simply
    // went silent for that user.
    //
    // It is also throttled now: `last_seen_at` only moves when it is older than
    // the touch window (a name change always lands), so a user tapping through
    // screens no longer writes a row per tap. That per-tap write was the single
    // biggest consumer of D1's daily row-write allowance.
    const profileChanged =
      (profile.username ?? null) !== (existing.username ?? null) ||
      (profile.firstName ?? null) !== (existing.first_name ?? null)
    const stampStale = !existing.last_seen_at || existing.last_seen_at < staleBefore(TOUCH_MINUTES)
    if (profileChanged || stampStale) {
      await dbRun(
        env,
        'UPDATE bot_tenants SET username = COALESCE(?, username), first_name = COALESCE(?, first_name), last_seen_at = ? WHERE id = ?',
        [profile.username ?? null, profile.firstName ?? null, nowIso(), existing.id],
      ).catch(() => null)
    }
    return existing
  }

  const userId = genId()
  const tenant: BotTenant = {
    id: genId(),
    telegram_id: telegramId,
    user_id: userId,
    access_token: newTenantToken(),
    username: profile.username ?? null,
    first_name: profile.firstName ?? null,
  }
  // Provisioning must be idempotent. Telegram delivers an update again when it
  // considers the webhook slow, and a user tapping two buttons produces two
  // updates at once — two plain INSERTs for the same new user raced on the
  // unique `users.email` / `bot_tenants.telegram_id` index and the loser threw,
  // which dropped that update entirely. A first-time user could therefore see
  // nothing at all (or be left half-provisioned for good when the process died
  // between the two inserts, because every later attempt hit the same unique
  // email). Both inserts are now conflict-tolerant and the row is re-read, so
  // whichever request wins, everyone converges on the same space.
  await env.DB.prepare(
    "INSERT INTO users (id, email, password_hash, role, max_deployments, created_at) VALUES (?, ?, 'telegram-tenant', 'user', ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(userId, `tg-${telegramId}@bot.local`, BOT_TENANT_QUOTA, nowIso())
    .run()
    // A previous half-finished attempt may already own this email — reuse it
    // instead of failing forever on the same unique index.
  const ownerRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(`tg-${telegramId}@bot.local`)
    .first<{ id: string }>()
  if (ownerRow?.id) tenant.user_id = ownerRow.id

  await env.DB.prepare(
    'INSERT INTO bot_tenants (id, telegram_id, user_id, access_token, username, first_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  )
    .bind(tenant.id, tenant.telegram_id, tenant.user_id, tenant.access_token, tenant.username, tenant.first_name, nowIso(), nowIso())
    .run()
    .catch(() => null)
  const created = await env.DB.prepare(`SELECT ${TENANT_COLUMNS} FROM bot_tenants WHERE telegram_id = ?`)
    .bind(telegramId)
    .first<BotTenant>()
    .catch(() => null)
  return created ?? tenant
}

const sessionKey = (userId: string, telegramId: string) => `${userId}:${telegramId}`

export async function loadSession(env: Env, userId: string, telegramId: string): Promise<BotSession | null> {
  const row = await env.DB.prepare('SELECT state, data FROM bot_sessions WHERE id = ?')
    .bind(sessionKey(userId, telegramId))
    .first<{ state: string; data: string }>()
  if (!row) return null
  return { state: row.state, data: safeJsonParse<Record<string, unknown>>(row.data, {}) }
}

export async function saveSession(env: Env, userId: string, telegramId: string, session: BotSession): Promise<void> {
  // `ON CONFLICT ... DO UPDATE` always writes, so compare the serialised state
  // with what is stored and skip the write when the screen did not change —
  // re-rendering a menu used to be a row write per tap.
  const id = sessionKey(userId, telegramId)
  const data = JSON.stringify(session.data)
  const current = await env.DB.prepare('SELECT state, data, updated_at FROM bot_sessions WHERE id = ?')
    .bind(id)
    .first<{ state: string; data: string; updated_at: string | null }>()
    .catch(() => null)
  if (current && current.state === session.state && current.data === data) {
    // Refresh `updated_at` occasionally so the cleanup job can tell idle
    // sessions from live ones — but store nothing at all when it is fresh.
    if (!current.updated_at || current.updated_at < staleBefore(TOUCH_MINUTES)) {
      await dbRun(env, 'UPDATE bot_sessions SET updated_at = ? WHERE id = ?', [nowIso(), id])
    }
    return
  }
  await dbRun(
    env,
    `INSERT INTO bot_sessions (id, user_id, telegram_id, state, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
    [id, userId, telegramId, session.state, data, nowIso()],
  )
}

export async function clearSession(env: Env, userId: string, telegramId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM bot_sessions WHERE id = ?').bind(sessionKey(userId, telegramId)).run()
}

export async function trackUser(env: Env, cfg: BotConfigRow, tgId: string, username: string | null, firstName: string | null, lastName: string | null): Promise<void> {
  const existing = await env.DB.prepare('SELECT id, last_activity, username, first_name, last_name FROM bot_users WHERE user_id = ? AND telegram_id = ?')
    .bind(cfg.user_id, tgId)
    .first<{ id: string; last_activity: string | null; username: string | null; first_name: string | null; last_name: string | null }>()
  if (existing) {
    // Only write when something actually changed or the stamp is stale. The
    // panel reads `last_activity` to show "active users", so a 10-minute
    // resolution is plenty — and it turns a write per update into ~one per user
    // per ten minutes.
    const changed =
      (username ?? null) !== (existing.username ?? null) ||
      (firstName ?? null) !== (existing.first_name ?? null) ||
      (lastName ?? null) !== (existing.last_name ?? null)
    const stale = !existing.last_activity || existing.last_activity < staleBefore(TOUCH_MINUTES)
    if (changed || stale) {
      await dbRun(env, 'UPDATE bot_users SET last_activity = ?, username = ?, first_name = ?, last_name = ? WHERE id = ?', [
        nowIso(),
        username,
        firstName,
        lastName,
        existing.id,
      ])
    }
    return
  }
  await env.DB.prepare(
    `INSERT INTO bot_users (id, user_id, telegram_id, username, first_name, last_name, is_active, is_admin, created_at, last_activity)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(genId(), cfg.user_id, tgId, username, firstName, lastName, nowIso(), nowIso())
    .run()
  await dbRun(env, 'INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    genId(),
    cfg.user_id,
    'bot_user_joined',
    'bot',
    username ? `@${username}` : firstName,
    nowIso(),
  ])
}

/**
 * Has the panel owner closed this Telegram user's access?
 *
 * The deployer bot is open to everyone, so `bot_users.is_active` is the only
 * control the owner keeps: blocking a user stops their updates from being
 * processed at all (no deploys, no token writes) until they are unblocked.
 */
export async function isBotUserBlocked(env: Env, ownerUserId: string, telegramId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT is_active FROM bot_users WHERE user_id = ? AND telegram_id = ?')
    .bind(ownerUserId, telegramId)
    .first<{ is_active: number }>()
  return !!row && !row.is_active
}

// ── Forced channel membership ────────────────────────────────────────────────

/** Channel every user must join before the bot unlocks (without the `@`). */
export const FORCE_JOIN_CHANNEL = 'miliconfig'
/** Public link to that channel. */
export const FORCE_JOIN_URL = `https://t.me/${FORCE_JOIN_CHANNEL}`
/** Callback payload of the gate's "I joined" button. */
export const FORCE_JOIN_CALLBACK = 'join:check'

/**
 * Is this Telegram user a member of the required channel?
 *
 * Telegram only answers `getChatMember` when the bot is an **administrator of
 * the channel**; without that right the API returns an error. Such an error is
 * treated as "member" (fail open) so a misconfigured bot can never lock every
 * user out — enforcement simply resumes once the bot is promoted to admin.
 * Only an explicit `left`/`kicked` status blocks.
 */
const memberCache = new Map<string, number>()
const MEMBER_CACHE_TTL_MS = 120_000

export async function isChannelMember(token: string, telegramId: string, forceRefresh = false): Promise<boolean> {
  const cacheKey = `${token.slice(-10)}:${telegramId}`
  const now = Date.now()
  if (!forceRefresh) {
    const exp = memberCache.get(cacheKey)
    if (exp && exp > now) return true
  }
  const res = await tg<{ status?: string; is_member?: boolean }>(token, 'getChatMember', {
    chat_id: `@${FORCE_JOIN_CHANNEL}`,
    user_id: Number(telegramId),
  })
  if (!res.ok) {
    console.warn(`force-join: getChatMember failed (${res.description ?? 'unknown'}) — is the bot an admin of @${FORCE_JOIN_CHANNEL}?`)
    return true
  }
  const status = res.result?.status ?? ''
  const ok =
    status === 'creator' ||
    status === 'administrator' ||
    status === 'member' ||
    (status === 'restricted' && res.result?.is_member !== false)
  if (ok) {
    if (memberCache.size > 1000) memberCache.clear()
    memberCache.set(cacheKey, now + MEMBER_CACHE_TTL_MS)
  } else {
    memberCache.delete(cacheKey)
  }
  return ok
}

/**
 * Where a deployment's result notification should go.
 *
 * A panel account's own deployments notify its bot owner chat. Deployments made
 * from the public bot belong to a Telegram tenant instead — those must be sent
 * back to *that user*, never to the bot owner's chat.
 */
export async function ownerChat(env: Env, userId: string): Promise<{ bot_token: string; chat_id: string } | null> {
  const cfg = await env.DB.prepare('SELECT bot_token, chat_id FROM bot_config WHERE user_id = ? AND is_active = 1 LIMIT 1')
    .bind(userId)
    .first<{ bot_token: string; chat_id: string | null }>()
  if (cfg?.chat_id) return { bot_token: cfg.bot_token, chat_id: cfg.chat_id }
  const tenant = await env.DB.prepare(
    `SELECT bc.bot_token AS bot_token, bt.telegram_id AS telegram_id FROM bot_tenants bt
     JOIN bot_config bc ON bc.is_active = 1
     WHERE bt.user_id = ? ORDER BY bt.created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<{ bot_token: string; telegram_id: string }>()
  if (tenant?.bot_token) return { bot_token: tenant.bot_token, chat_id: tenant.telegram_id }
  return null
}

/** Active bot token + an explicit chat — used for the chat that asked for the work. */
async function chatTarget(env: Env, chatId: string): Promise<{ bot_token: string; chat_id: string } | null> {
  const cfg = await env.DB.prepare('SELECT bot_token FROM bot_config WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1')
    .first<{ bot_token: string }>()
  return cfg?.bot_token ? { bot_token: cfg.bot_token, chat_id: chatId } : null
}

export const faDate = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fa-IR')
  } catch {
    return iso.slice(0, 10)
  }
}

export const STATUS_ICON: Record<string, string> = { deployed: '✅', failed: '❌', deploying: '⏳', pending: '⏳' }
export const statusIcon = (s: string) => STATUS_ICON[s] ?? '•'

const NO_DEPLOY_SUB_SOURCES = new Set(['milios', 'miliconfigosv3', 'zeus', 'miliconfigzeus', 'nova', 'github'])
export const subUrlOf = (d: { worker_url: string | null; sub_url?: string | null; custom_path: string | null; uuid: string | null; worker_source?: string | null }) => {
  if (d.sub_url) return d.sub_url
  if (d.worker_source && NO_DEPLOY_SUB_SOURCES.has(d.worker_source)) return null
  if (!d.worker_url) return null
  const base = d.worker_url.replace(/\/+$/, '')
  const slug = (d.custom_path || d.uuid || '').replace(/^\/+|\/+$/g, '')
  if (!slug) return null
  if (d.worker_source === 'custom' || d.worker_source === 'nexus') return `${base}/${slug}/sub`
  return `${base}/${slug}`
}

// ── Owner notifications (never allowed to break a deployment) ────────────────

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']
export function toFaNum(n: number | string): string {
  return String(n).replace(/\d/g, (d) => FA_DIGITS[Number(d)] ?? d)
}

/** Visual animated filling progress bar for Telegram bot screens. */
export function renderProgressBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  const filled = Math.round(clamped / 10)
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled)
  return `<code>[${bar}] ${toFaNum(clamped)}٪</code>`
}

/** Smart Error Alert analyzer (اخطار خطای هوشمند) for Telegram deployments. */
export function diagnoseDeployError(error: string | null | undefined): string {
  const raw = (error ?? '').toLowerCase()
  if (!raw) return 'بررسی اتصال اینترنت و صحت دسترسی‌های توکن Cloudflare توصیه می‌شود.'
  if (raw.includes('invalid cloudflare token') || raw.includes('authentication') || raw.includes('10000') || raw.includes('9109')) {
    return '🔑 <b>علت:</b> توکن Cloudflare معتبر نیست یا منقضی شده است.\n💡 <b>راه‌حل:</b> در داشبورد کلودفلر از الگوی <code>Edit Cloudflare Workers</code> یک توکن جدید با دسترسی به Account Settings، Workers Scripts، KV و D1 بسازید.'
  }
  if (raw.includes('kv') || raw.includes('namespace')) {
    return '🗄 <b>علت:</b> توکن فعلی دسترسی ساخت یا ویرایش Workers KV Storage را ندارد یا سقف KV پر شده است.\n💡 <b>راه‌حل:</b> به توکن خود مجوز <code>Account → Workers KV Storage → Edit</code> بدهید.'
  }
  if (raw.includes('d1') || raw.includes('database')) {
    return '🛢 <b>علت:</b> توکن فعلی دسترسی <code>D1:Edit</code> ندارد یا سقف ۱۰ دیتابیس رایگان کلودفلر پر شده است.\n💡 <b>راه‌حل:</b> در داشبورد Cloudflare یک دیتابیس قدیمی بلااستفاده را حذف کنید یا مجوز D1 Edit را به توکن اضافه نمایید.'
  }
  if (raw.includes('1101') || raw.includes('cpu') || raw.includes(' startup')) {
    return '⚡ <b>علت:</b> محدودیت پردازش اولیه یا غیرفعال بودن سرویس Workers در حساب کلودفلر.\n💡 <b>راه‌حل:</b> یک‌بار وارد داشبورد Cloudflare → بخش Workers & Pages شوید تا زیرساخت حساب فعال شود، سپس دکمهٔ «تلاش مجدد» را بزنید.'
  }
  if (raw.includes('fetch worker source') || raw.includes('github') || raw.includes('404')) {
    return '🌐 <b>علت:</b> آدرس فایل سورس در گیت‌هاب پیدا نشد یا مخزن خصوصی است.\n💡 <b>راه‌حل:</b> از منابع آمادهٔ پنل (CFnew، NEXUS، Mili، ZEUS) استفاده کنید یا لینک مستقیم فایل تک‌ماژول `.js` را وارد نمایید.'
  }
  if (raw.includes('سقف') || raw.includes('quota') || raw.includes('limit')) {
    return '📊 <b>علت:</b> به سقف مجاز تعداد ورکرهای حساب خود رسیده‌اید.\n💡 <b>راه‌حل:</b> یکی از ورکرهای قدیمی را از بخش «📋 ورکرها» حذف کنید یا از مدیر پنل افزایش سهمیه بخواهید.'
  }
  return '🛠 <b>راه‌حل پیشنهادی:</b> از بخش «🔑 توکن‌ها» صحت توکن خود را بررسی کرده و با دکمهٔ «♻️ بازیابی» یا «🔁 تلاش دوباره» استقرار را تکرار کنید.'
}

export async function notifyDeploymentProgress(
  env: Env,
  opts: {
    userId: string
    workerName: string
    percent: number
    stage: string
    detail?: string
    chatId?: string | null
    botToken?: string | null
    messageId?: number | null
  },
): Promise<void> {
  try {
    const target = opts.botToken && opts.chatId
      ? { bot_token: opts.botToken, chat_id: opts.chatId }
      : (opts.chatId ? await chatTarget(env, opts.chatId) : null) ?? (await ownerChat(env, opts.userId))
    if (!target || !opts.messageId) return
    const text =
      `⏳ <b>در حال استقرار هوشمند ورکر...</b>\n\n` +
      `📦 ورکر: <code>${opts.workerName}</code>\n` +
      `${renderProgressBar(opts.percent)}\n\n` +
      `🔹 <b>وضعیت فعلی:</b> ${opts.stage}` +
      (opts.detail ? `\nℹ️ <i>${opts.detail}</i>` : '')
    await tg(target.bot_token, 'editMessageText', {
      chat_id: target.chat_id,
      message_id: opts.messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  } catch {
    // progress updates are best-effort
  }
}

export async function notifyDeployment(
  env: Env,
  userId: string,
  workerName: string,
  status: 'deployed' | 'failed',
  workerUrl: string | null,
  panelUrl: string | null,
  error?: string | null,
  chatId?: string | null,
  opts?: { subUrl?: string | null; botToken?: string | null; messageId?: number | null; sourceName?: string | null },
): Promise<void> {
  try {
    const target = (opts?.botToken && chatId ? { bot_token: opts.botToken, chat_id: chatId } : null)
      ?? (chatId ? await chatTarget(env, chatId) : null)
      ?? (await ownerChat(env, userId))
    if (!target) return
    const ok = status === 'deployed'
    const subUrl = opts?.subUrl ?? null
    let msg: string
    if (ok) {
      msg =
        `✅ <b>استقرار با موفقیت کامل شد!</b>\n` +
        `${renderProgressBar(100)}\n\n` +
        `📦 <b>نام ورکر:</b> <code>${workerName}</code>` +
        (opts?.sourceName ? `\n🧬 <b>هسته:</b> ${opts.sourceName}` : '') +
        (workerUrl ? `\n\n🌐 <b>لینک مستقیم ورکر:</b>\n<code>${workerUrl}</code>` : '') +
        (panelUrl ? `\n\n🔐 <b>آدرس پنل مدیریت:</b>\n<code>${panelUrl}</code>` : '') +
        (subUrl ? `\n\n📡 <b>لینک اشتراک (Sub):</b>\n<code>${subUrl}</code>` : '')
    } else {
      const smartAdvice = diagnoseDeployError(error)
      msg =
        `❌ <b>استقرار متوقف شد (اخطار خطای هوشمند)</b>\n\n` +
        `📦 <b>نام ورکر:</b> <code>${workerName}</code>` +
        (error ? `\n⚠️ <b>پیام خطا:</b> <code>${error}</code>` : '') +
        `\n\n🧠 <b>تحلیل هوشمند:</b>\n${smartAdvice}`
    }
    const rows: TgButton[][] = []
    if (ok && workerUrl) {
      rows.push([
        { text: '🔗 باز کردن ورکر', url: workerUrl, style: 'primary' },
        ...(panelUrl ? [{ text: '🔐 ورود به پنل', url: panelUrl, style: 'success' as const }] : []),
      ])
      if (subUrl) {
        rows.push([{ text: '📡 باز کردن لینک ساب', url: subUrl }])
      }
    } else if (!ok) {
      rows.push([
        { text: '🔁 تلاش مجدد استقرار', callback_data: 'dpl:start', style: 'primary' },
        { text: '🔑 بررسی توکن‌ها', callback_data: 'n:tokens' },
      ])
      rows.push([{ text: '♻️ بازیابی خودکار ورکرها', callback_data: 'n:recover' }])
    }
    rows.push([{ text: '📋 ورکرهای من', callback_data: 'l:workers:0' }, { text: '👤 فضای من', callback_data: 'n:profile' }])
    if (opts?.messageId) {
      const edited = await tg(target.bot_token, 'editMessageText', {
        chat_id: target.chat_id,
        message_id: opts.messageId,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: rows },
      })
      if (edited.ok) return
    }
    await sendMsg(target.bot_token, target.chat_id, msg, { inline_keyboard: rows })
  } catch {
    // notifications must never break deployments
  }
}

export async function notifyQuotaLevel(env: Env, userId: string, memberName: string, workerName: string, level: 1 | 2 | 3, detail: string): Promise<void> {
  try {
    const target = await ownerChat(env, userId)
    if (!target) return
    const head = level === 3 ? '⛔ سهمی تمام شد'
      : level === 2 ? '🟠 سهمی رو به اتمام (۹۰٪)'
      : '🟡 مصرف بالا (۸۰٪)'
    await sendMsg(target.bot_token, target.chat_id, `${head}\n\n👤 ${memberName} · 📦 ${workerName}\n${detail}`, {
      inline_keyboard: [[{ text: '👥 کاربران ساب', callback_data: 'l:members:0' }, { text: '🏠 منو', callback_data: 'n:menu' }]],
    })
  } catch {
    // ignore
  }
}

export async function notifyOptimizer(env: Env, userId: string, jobName: string, alive: number, total: number, subUrl: string | null): Promise<void> {
  try {
    const target = await ownerChat(env, userId)
    if (!target) return
    const msg = `⚡ <b>بهینه‌سازی کامل شد</b>\n\n📋 ${jobName}\n🟢 سالم: ${alive} از ${total}${subUrl ? `\n\n🔗 <code>${subUrl}</code>` : ''}`
    await sendMsg(target.bot_token, target.chat_id, msg, {
      inline_keyboard: [[{ text: '⚡ ساب‌های بهینه', callback_data: 'l:optimizer:0' }, { text: '🏠 منو', callback_data: 'n:menu' }]],
    })
  } catch {
    // ignore
  }
}
