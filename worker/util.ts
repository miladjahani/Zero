import type { Env } from './env'
import { dbRun, dbRunCritical } from './db'

// ── Small helpers ──────────────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing side-channel attacks on
 * password hashes, HMAC signatures, and webhook secrets.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const enc = new TextEncoder()
  const aBytes = enc.encode(a)
  const bBytes = enc.encode(b)
  const len = Math.max(aBytes.length, bBytes.length)
  let diff = aBytes.length ^ bBytes.length
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0)
  }
  return diff === 0
}

/**
 * Pure-JS RFC 1321 MD5 fallback for runtimes where `crypto.subtle.digest('MD5')`
 * is unavailable (e.g. strict W3C WebCrypto or Node.js WebCrypto).
 */
function md5PureJsHex(input: string): string {
  const utf8 = new TextEncoder().encode(input)
  const bitLen = utf8.length * 8
  const padLen = ((utf8.length + 8) >>> 6 << 4) + 16
  const words = new Int32Array(padLen)
  for (let i = 0; i < utf8.length; i++) {
    words[i >> 2] |= utf8[i] << ((i & 3) * 8)
  }
  words[utf8.length >> 2] |= 0x80 << ((utf8.length & 3) * 8)
  words[padLen - 2] = bitLen & 0xffffffff
  words[padLen - 1] = Math.floor(bitLen / 0x100000000)

  const K = new Int32Array(64)
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0
  }
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]

  let a0 = 0x67452301 | 0
  let b0 = 0xefcdab89 | 0
  let c0 = 0x98badcfe | 0
  let d0 = 0x10325476 | 0

  for (let i = 0; i < padLen; i += 16) {
    let A = a0, B = b0, C = c0, D = d0
    for (let j = 0; j < 64; j++) {
      let F = 0, g = 0
      if (j < 16) { F = (B & C) | (~B & D); g = j }
      else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16 }
      else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16 }
      else { F = C ^ (B | ~D); g = (7 * j) % 16 }
      const temp = D
      D = C
      C = B
      const sum = (A + F + K[j] + words[i + g]) | 0
      const rot = (sum << S[j]) | (sum >>> (32 - S[j]))
      B = (B + rot) | 0
      A = temp
    }
    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }

  const out = new Uint8Array(16)
  const view = new DataView(out.buffer)
  view.setInt32(0, a0, true)
  view.setInt32(4, b0, true)
  view.setInt32(8, c0, true)
  view.setInt32(12, d0, true)
  return Array.from(out).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The double-MD5 token edgetunnel uses for its `/sub?token=` link.
 *
 * edgetunnel (cmliu) computes `MD5MD5(host + userID)` where `MD5MD5` hashes
 * once, takes the hex substring `[7,27)` and hashes that again. It also folds
 * the token to lowercase. Reproducing it here is what lets the panel hand the
 * user a sub link that actually returns nodes instead of the origin 404 page
 * (the `/sub` path without a valid `token` falls through to the upstream).
 */
export async function md5Hex(text: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return md5PureJsHex(text)
  }
}

export async function edgetunnelSubToken(host: string, userId: string): Promise<string> {
  const first = await md5Hex(host + userId)
  return (await md5Hex(first.slice(7, 27))).toLowerCase()
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  })
}

export function apiError(error: string, status = 400): Response {
  return json({ error }, status)
}

export function genId(): string {
  return crypto.randomUUID()
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

// ── Password hashing (PBKDF2 via WebCrypto — no native deps on Workers) ────
// 60,000 iterations meets NIST SP 800-63B while staying well inside the
// Cloudflare Workers Free-tier 10ms cold-start CPU ceiling (100,000 iterations
// sits at the hard runtime ceiling and can trigger Error 1101 on cold start).
// Existing 100,000-iteration hashes continue to verify via `iterText`.
const PBKDF2_ITERATIONS = 60_000

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function b64decode(text: string): Uint8Array {
  const bin = atob(text)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key,
    256,
  )
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS)
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(bits)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored || typeof stored !== 'string') return false
  const [scheme, iterText, saltB64, hashB64] = stored.split('$')
  if (scheme !== 'pbkdf2' || !saltB64 || !hashB64) return false
  const iterations = Math.min(100_000, Math.max(1_000, Number(iterText) || PBKDF2_ITERATIONS))
  try {
    const bits = await pbkdf2(password, b64decode(saltB64), iterations)
    return timingSafeEqualStr(b64encode(bits), hashB64)
  } catch {
    return false
  }
}

// ── Sessions ───────────────────────────────────────────────────────────────

const SESSION_DAYS = 30

export interface UserRow {
  id: string
  email: string
  role: string
  max_deployments: number
}

export async function createSession(env: Env, userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = genId() + genId()
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString()
  // Signing in is the one write a user is actively waiting on: retry a transient
  // limit blip and, if it really is the daily cap, say so instead of showing
  // `D1_ERROR` in the login form.
  await dbRunCritical(env, 'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [
    token,
    userId,
    expiresAt,
  ])
  return { token, expiresAt }
}

export async function getUserFromRequest(env: Env, request: Request): Promise<UserRow | null> {
  const header = request.headers.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return null
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.max_deployments FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
  )
    .bind(token, nowIso())
    .first<UserRow>()
  return row ?? null
}

export async function logActivity(
  env: Env,
  userId: string,
  action: string,
  entityType = 'general',
  entityName: string | null = null,
  details?: Record<string, unknown>,
): Promise<void> {
  // Best-effort by design: a log line losing one row is preferable to the
  // action itself failing once D1's daily row-write budget is spent.
  await dbRun(
    env,
    'INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [genId(), userId, action, entityType, entityName, details ? JSON.stringify(details) : null, nowIso()],
  )
}
