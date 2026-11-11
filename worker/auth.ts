import type { Env } from './env'
import { apiError, json, hashPassword, verifyPassword, createSession, getUserFromRequest, nowIso, genId, safeJsonParse, timingSafeEqualStr } from './util'
import { getActiveConfig, resolveTenant } from './telegram-core'

interface SignupBody { email?: string; password?: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Lightweight per-isolate brute-force protection for `/api/auth/login` when
// invoked from a real client IP (`CF-Connecting-IP`).
const loginRateMap = new Map<string, { count: number; resetAt: number }>()
const LOGIN_MAX_ATTEMPTS = 10
const LOGIN_WINDOW_MS = 5 * 60 * 1000

function checkLoginRateLimit(ip: string): boolean {
  if (!ip) return true
  const now = Date.now()
  if (loginRateMap.size > 500) {
    for (const [k, v] of loginRateMap) {
      if (v.resetAt <= now) loginRateMap.delete(k)
    }
  }
  const entry = loginRateMap.get(ip)
  if (!entry || entry.resetAt <= now) return true
  return entry.count < LOGIN_MAX_ATTEMPTS
}

function recordFailedLogin(ip: string): void {
  if (!ip) return
  const now = Date.now()
  const entry = loginRateMap.get(ip)
  if (!entry || entry.resetAt <= now) {
    loginRateMap.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
  } else {
    entry.count += 1
  }
}

function clearLoginRateLimit(ip: string): void {
  if (!ip) return
  loginRateMap.delete(ip)
}

export async function handleSignup(env: Env, request: Request): Promise<Response> {
  const body = safeJsonParse<SignupBody>(await request.text().catch(() => ''), {})
  const email = body.email?.trim().toLowerCase() ?? ''
  const password = body.password ?? ''
  if (!EMAIL_RE.test(email)) return apiError('ایمیل معتبر نیست')
  if (password.length < 6) return apiError('رمز عبور باید حداقل ۶ کاراکتر باشد')

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>()
  if (existing) return apiError('این ایمیل قبلاً ثبت شده است', 409)

  // The very first account becomes the platform admin.
  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>()
  const role = (count?.c ?? 0) === 0 ? 'admin' : 'user'

  const id = genId()
  await env.DB.prepare('INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, email, await hashPassword(password), role, nowIso())
    .run()

  const { token } = await createSession(env, id)
  return json({ token, user: await effectiveUser(env, { id, email, role }) })
}

export async function handleLogin(env: Env, request: Request): Promise<Response> {
  const clientIp = (request.headers.get('CF-Connecting-IP') ?? '').trim()
  if (clientIp && !checkLoginRateLimit(clientIp)) {
    return apiError('تعداد تلاش‌های ناموفق بیش از حد مجاز است. لطفاً ۵ دقیقه دیگر تلاش کنید.', 429)
  }

  const body = safeJsonParse<SignupBody>(await request.text().catch(() => ''), {})
  const email = body.email?.trim().toLowerCase() ?? ''
  const password = body.password ?? ''

  const row = await env.DB.prepare('SELECT id, email, password_hash, role FROM users WHERE email = ?').bind(email).first<{ id: string; email: string; password_hash: string; role: string }>()
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    recordFailedLogin(clientIp)
    return apiError('ایمیل یا رمز عبور اشتباه است', 401)
  }
  clearLoginRateLimit(clientIp)
  const { token } = await createSession(env, row.id)
  return json({ token, user: await effectiveUser(env, { id: row.id, email: row.email, role: row.role ?? 'user' }) })
}

export async function handleLogout(env: Env, request: Request): Promise<Response> {
  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  }
  return json({ success: true })
}

/** The configured owner email, normalised (emails are stored lowercased). */
function ownerEmail(env: Env): string {
  return (env.OWNER_EMAIL ?? '').trim().toLowerCase()
}

/**
 * Is this account the panel owner?
 *
 * The owner is the account named by `OWNER_EMAIL` (set in `[vars]` of
 * wrangler.toml, e.g. `milad201400@gmail.com`). Only the owner sees and manages
 * the deployer bot; every other panel user and every additional admin is kept
 * out of that section entirely.
 *
 * If no `OWNER_EMAIL` is configured — or that account has not signed up yet —
 * the installation's first account owns the panel, so the section can never end
 * up with nobody able to open it.
 */
export async function isOwner(env: Env, userId: string): Promise<boolean> {
  const email = ownerEmail(env)
  if (email) {
    const owner = await env.DB.prepare('SELECT id FROM users WHERE lower(email) = ? LIMIT 1')
      .bind(email)
      .first<{ id: string }>()
    if (owner) return owner.id === userId
  }
  const first = await env.DB.prepare('SELECT id FROM users ORDER BY created_at, id LIMIT 1').first<{ id: string }>()
  return !!first && first.id === userId
}

/**
 * Add the derived ownership/admin facts to a user row.
 */
async function effectiveUser<T extends { id: string; role?: string | null }>(env: Env, user: T) {
  const owner = await isOwner(env, user.id)
  if (!owner) return { ...user, role: user.role ?? 'user', is_owner: false }
  if ((user.role ?? '') !== 'admin') {
    await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind('admin', user.id).run().catch(() => null)
  }
  return { ...user, role: 'admin', is_owner: true }
}

export async function handleMe(env: Env, request: Request): Promise<Response> {
  const user = await getUserFromRequest(env, request)
  if (!user) return apiError('نشست منقضی شده است', 401)
  return json({ user: await effectiveUser(env, user) })
}

// ── Telegram Mini App login ─────────────────────────────────────────────────

/** Profile object Telegram puts inside `initData.user`. */
interface TgWebAppUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
}

/** How old an `initData` payload may be before we refuse it. */
const TG_INIT_MAX_AGE_SECONDS = 24 * 3600

/** Same cleaning the panel applies to pasted tokens (Telegram rejects any stray char). */
function cleanBotToken(raw: string): string {
  return raw
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\s]/g, '')
    .replace(/^bot/i, '')
    .trim()
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacSha256(key: string | Uint8Array, message: string): Promise<ArrayBuffer> {
  const raw = typeof key === 'string' ? new TextEncoder().encode(key) : key
  const cryptoKey = await crypto.subtle.importKey('raw', raw as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
}

/**
 * Validate `Telegram.WebApp.initData` exactly as Telegram documents it:
 * `secret = HMAC_SHA256(key="WebAppData", message=bot_token)` and
 * `hash = HMAC_SHA256(key=secret, message=data_check_string)`.
 */
async function verifyInitData(
  initData: string,
  botToken: string,
): Promise<{ ok: true; user: TgWebAppUser } | { ok: false; error: string }> {
  const params = new URLSearchParams(initData)
  const hash = (params.get('hash') ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, error: 'initData نامعتبر است' }
  params.delete('hash')
  const dataCheck = [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = await hmacSha256('WebAppData', botToken)
  const expected = toHex(await hmacSha256(new Uint8Array(secret), dataCheck))
  if (!timingSafeEqualStr(expected, hash)) return { ok: false, error: 'امضای initData معتبر نیست' }
  const authDate = Number(params.get('auth_date') ?? 0)
  const age = Math.abs(Date.now() / 1000 - authDate)
  if (!authDate || age > TG_INIT_MAX_AGE_SECONDS) return { ok: false, error: 'initData منقضی شده است' }
  const profile = safeJsonParse<TgWebAppUser | null>(params.get('user') ?? '', null)
  if (!profile?.id) return { ok: false, error: 'کاربر تلگرام در initData نیست' }
  return { ok: true, user: profile }
}

/**
 * Sign a panel session from a Telegram Mini App open.
 */
export async function handleTelegramLogin(env: Env, request: Request): Promise<Response> {
  const body = safeJsonParse<{ initData?: string }>(await request.text().catch(() => ''), {})
  const initData = (body.initData ?? '').trim()
  if (!initData) return apiError('initData ارسال نشده است')

  const cfg = await getActiveConfig(env)
  if (!cfg) return apiError('ربات پنل هنوز پیکربندی نشده است', 404)

  const check = await verifyInitData(initData, cleanBotToken(cfg.bot_token))
  if (!check.ok) return apiError(check.error, 401)

  const telegramId = String(check.user.id)
  let ownerTelegramId = String(cfg.chat_id ?? '')
  if (!ownerTelegramId) {
    const saved = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind('owner_telegram_id')
      .first<{ value: string }>()
    ownerTelegramId = String(saved?.value ?? '')
  }
  const isOwnerChat = ownerTelegramId !== '' && ownerTelegramId === telegramId
  const userId = isOwnerChat
    ? cfg.user_id
    : (await resolveTenant(env, telegramId, {
        username: check.user.username ?? null,
        firstName: check.user.first_name ?? null,
      })).user_id

  const row = await env.DB.prepare('SELECT id, email, role FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string; email: string; role: string | null }>()
  if (!row) return apiError('حساب پنل پیدا نشد', 404)

  const { token } = await createSession(env, row.id)
  return json({ token, user: await effectiveUser(env, row) })
}
