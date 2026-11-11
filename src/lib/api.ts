// Every read and write in this app goes to the panel's own Worker API (`/api/*`),
// which is the D1-backed backend (`worker/index.ts`). The Supabase client this
// module used to route some tables through is gone: it split the panel into two
// half-populated databases — the SPA showed empty token/deployment/bot lists
// while the Worker (and the Telegram bot) worked off D1.

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const TOKEN_KEY = 'miliconfig_token'
export function getToken(): string | null { return localStorage.getItem(TOKEN_KEY) }
export function setToken(token: string): void { localStorage.setItem(TOKEN_KEY, token) }
export function clearToken(): void { localStorage.removeItem(TOKEN_KEY) }

/**
 * Base path of the Worker API.
 *
 * The panel ships *with* its Worker (Cloudflare Pages advanced mode and Workers
 * static assets both serve `worker/index.ts` next to the SPA), so the default
 * relative `/api` is what production uses. `VITE_API_BASE` only exists for the
 * odd split-hosting setup.
 */
export const API_BASE = String(import.meta.env.VITE_API_BASE ?? '/api').replace(/\/$/, '')

interface ApiOptions {
  method?: string
  body?: unknown
}

function authHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** One API call. Non-2xx answers are thrown as `ApiError` with the server's Persian message. */
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  let resp: Response
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      method,
      headers: authHeaders(options.body !== undefined),
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    })
  } catch {
    throw new ApiError('خطا در اتصال به سرور', 0)
  }
  const text = await resp.text().catch(() => '')
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
  if (!resp.ok) {
    const msg = (parsed as { error?: string } | null)?.error ?? `خطای سرور (${resp.status})`
    throw new ApiError(msg, resp.status)
  }
  return parsed as T
}

export async function apiRaw(path: string): Promise<Response> {
  return fetch(`${API_BASE}${path}`, { headers: authHeaders(false) })
}

/** Build a full URL for an API path (used for subscription links). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}

export async function downloadApi(path: string, fallbackName = 'download.json'): Promise<void> {
  const resp = await fetch(`${API_BASE}${path}`, { headers: authHeaders(false) })
  if (!resp.ok) throw new ApiError(`خطای سرور (${resp.status})`, resp.status)
  const disposition = resp.headers.get('Content-Disposition') ?? ''
  const name = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? fallbackName
  const url = URL.createObjectURL(await resp.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
