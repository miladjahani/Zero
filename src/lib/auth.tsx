import { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react'
import { api, clearToken, getToken, setToken } from './api'

/**
 * Panel accounts live in the panel's own D1 database (`users` table), the same
 * one the Telegram bot and the deployer use. This used to authenticate against
 * Supabase, which meant a valid Supabase session could never be seen by the
 * Worker: every `/api/*` call answered 401, `is_owner` was always false and the
 * owner-only sections stayed hidden.
 */
export interface User {
  id: string
  email: string
  role?: string
  is_owner?: boolean
}

interface AuthContextType {
  user: User | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signUp: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signIn: async () => ({ error: 'not implemented' }),
  signUp: async () => ({ error: 'not implemented' }),
  signOut: async () => {},
})

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

// ── Telegram Mini App ───────────────────────────────────────────────────────

interface TelegramWebApp {
  initData?: string
  ready?: () => void
  expand?: () => void
}

/** Set when the user signs out *inside* Telegram, so we don't silently log them
 *  back in as their bot tenant on the next open. */
const TG_OPTOUT_KEY = 'miliconfig_tg_optout'

function telegramWebApp(): TelegramWebApp | undefined {
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Restore the session from the stored token (an expired one is dropped).
  // Inside the Telegram Mini App there is no stored token on first open: the
  // bot sends `initData`, the server verifies its signature against the bot
  // token and hands back a normal panel session for that Telegram account.
  useEffect(() => {
    let alive = true
    const tg = telegramWebApp()
    try { tg?.ready?.(); tg?.expand?.() } catch { /* not in Telegram */ }

    const restore = async () => {
      if (getToken()) {
        try {
          const res = await api<{ user: User }>('/auth/me')
          if (res?.user?.id) {
            if (alive) setUser(res.user)
            return
          }
          clearToken()
        } catch {
          clearToken()
        }
      }
      if (tg?.initData && localStorage.getItem(TG_OPTOUT_KEY) !== '1') {
        try {
          const res = await api<{ token: string; user: User }>('/auth/telegram', {
            method: 'POST',
            body: { initData: tg.initData },
          })
          if (res?.token) {
            setToken(res.token)
            if (alive) setUser(res.user)
          }
        } catch { /* stay signed out and show the login form */ }
      }
    }

    restore().finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      const res = await api<{ token: string; user: User }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      })
      if (!res?.token) return { error: 'ورود ناموفق بود' }
      localStorage.removeItem(TG_OPTOUT_KEY)
      setToken(res.token)
      setUser(res.user)
      return { error: null }
    } catch (e) {
      return { error: message(e, 'ورود ناموفق بود') }
    }
  }, [])

  const signUp = useCallback(async (email: string, password: string) => {
    try {
      const res = await api<{ token: string; user: User }>('/auth/signup', {
        method: 'POST',
        body: { email, password },
      })
      if (!res?.token) return { error: 'ساخت حساب ناموفق بود' }
      setToken(res.token)
      setUser(res.user)
      return { error: null }
    } catch (e) {
      return { error: message(e, 'ساخت حساب ناموفق بود') }
    }
  }, [])

  const signOut = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }) } catch { /* session already gone */ }
    clearToken()
    // In the Mini App, remembering "signed out" matters: otherwise the next
    // open would auto-login the same Telegram account again.
    localStorage.setItem(TG_OPTOUT_KEY, '1')
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
