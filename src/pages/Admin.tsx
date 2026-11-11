import { useCallback, useEffect, useState } from 'react'
import {
  Shield,
  Check,
  Search,
  Users,
  Boxes,
  Bot,
  Megaphone,
  Send,
  Trash2,
  Loader2,
  KeyRound,
  X,
  Database,
} from 'lucide-react'
import { api, downloadApi } from '../lib/api'
import type { AdminUser } from '../lib/types'

export default function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'web' | 'bot' | 'admin'>('all')

  // Broadcast modal state inside Admin panel
  const [showBroadcast, setShowBroadcast] = useState(false)
  const [broadcastMessage, setBroadcastMessage] = useState('')
  const [buttonText, setButtonText] = useState('')
  const [buttonUrl, setButtonUrl] = useState('')
  const [targetTelegramId, setTargetTelegramId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [broadcastNotice, setBroadcastNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: AdminUser[] }>('/admin/users')
      setUsers(data ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در دریافت کاربران')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const patch = async (id: string, body: { role?: string; max_deployments?: number }) => {
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', body })
      await load()
      setSaved(id)
      setTimeout(() => setSaved(null), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ذخیره')
    }
  }

  const handleDeleteUser = async (u: AdminUser) => {
    if (!confirm(`آیا از حذف کامل حساب «${u.email}» و تمام داده‌های آن مطمئن هستید؟`)) return
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در حذف کاربر')
    }
  }

  const handleBroadcast = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!broadcastMessage.trim()) return
    setSending(true)
    setBroadcastNotice(null)
    try {
      const res = await api<{ data: { total: number; sent: number; failed: number } }>('/admin/broadcast', {
        method: 'POST',
        body: {
          message: broadcastMessage.trim(),
          target: targetTelegramId ? 'selected' : 'active',
          telegram_ids: targetTelegramId ? [targetTelegramId] : undefined,
          button_text: buttonText.trim() || undefined,
          button_url: buttonUrl.trim() || undefined,
        },
      })
      setBroadcastNotice({
        ok: true,
        text: `✅ پیام برای ${res.data.sent.toLocaleString('fa-IR')} از ${res.data.total.toLocaleString('fa-IR')} کاربر در ربات تلگرام ارسال شد.`,
      })
      setBroadcastMessage('')
    } catch (err) {
      setBroadcastNotice({
        ok: false,
        text: err instanceof Error ? err.message : 'خطا در ارسال پیام',
      })
    } finally {
      setSending(false)
    }
  }

  const isBotAccount = (u: AdminUser) => !!u.telegram_id || u.email.endsWith('@telegram.local')

  const filtered = users.filter((u) => {
    const q = search.trim().toLowerCase()
    const matchSearch =
      !q ||
      u.email.toLowerCase().includes(q) ||
      (u.telegram_id ?? '').includes(q) ||
      (u.telegram_username ?? '').toLowerCase().includes(q) ||
      (u.telegram_first_name ?? '').toLowerCase().includes(q)
    const matchFilter =
      filter === 'all'
        ? true
        : filter === 'admin'
          ? u.role === 'admin'
          : filter === 'bot'
            ? isBotAccount(u)
            : !isBotAccount(u)
    return matchSearch && matchFilter
  })

  const totals = {
    all: users.length,
    admins: users.filter((u) => u.role === 'admin').length,
    botUsers: users.filter(isBotAccount).length,
    deployments: users.reduce((acc, u) => acc + Number(u.deployments ?? 0), 0),
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-80">
        <Loader2 className="w-8 h-8 animate-spin text-brand-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-brand-500/15 border border-brand-400/40 flex items-center justify-center shadow-[0_0_24px_-6px_rgba(var(--t-accent-rgb),0.5)]">
            <Shield className="w-6 h-6 text-brand-300" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">مدیریت جامع کاربران و سهمیه‌ها</h1>
            <p className="eyebrow-muted mt-1">ADMIN CONTROL CENTER &amp; BOT BROADCAST</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => downloadApi('/admin/backup', `miliconfig-admin-full-backup-${new Date().toISOString().slice(0, 10)}.json`)}
            className="btn-secondary flex items-center gap-2 text-xs sm:text-sm"
            title="دانلود بکاپ کامل کل سیستم و تمام کاربران"
          >
            <Database className="w-4 h-4" />
            بکاپ کامل کل سیستم
          </button>
          <button
            type="button"
            onClick={() => {
              setTargetTelegramId(null)
              setBroadcastNotice(null)
              setShowBroadcast((p) => !p)
            }}
            className="btn-primary flex items-center gap-2 text-xs sm:text-sm"
          >
            <Megaphone className="w-4 h-4" />
            {showBroadcast ? 'بستن پنل پیام همگانی' : 'ارسال پیام همگانی در ربات'}
          </button>
        </div>
      </div>

      {/* Broadcast Box */}
      {showBroadcast && (
        <form onSubmit={handleBroadcast} className="glass-card p-5 space-y-4 border-brand-400/40 animate-fade-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-brand-500/15 border border-brand-400/35">
                <Megaphone className="w-5 h-5 text-brand-300" />
              </div>
              <div>
                <h2 className="text-sm sm:text-base font-bold text-white">
                  {targetTelegramId ? `ارسال پیام مستقیم به کاربر (${targetTelegramId})` : 'ارسال پیام همگانی به تمام کاربران ربات تلگرام'}
                </h2>
                <p className="text-xs text-slate-300">پیام از طریق ربات تلگرام برای کاربران ارسال می‌شود</p>
              </div>
            </div>
            <button type="button" onClick={() => setShowBroadcast(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>

          <textarea
            rows={3}
            value={broadcastMessage}
            onChange={(e) => setBroadcastMessage(e.target.value)}
            placeholder="متن پیام یا اطلاعیه خود را وارد کنید..."
            className="input-field text-sm leading-6"
            required
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              value={buttonText}
              onChange={(e) => setButtonText(e.target.value)}
              placeholder="متن دکمه زیر پیام (اختیاری)"
              className="input-field text-xs py-2.5"
            />
            <input
              type="url"
              dir="ltr"
              value={buttonUrl}
              onChange={(e) => setButtonUrl(e.target.value)}
              placeholder="https://... لینک دکمه (اختیاری)"
              className="input-field text-xs py-2.5"
            />
          </div>

          {broadcastNotice && (
            <div
              className={`p-3 rounded-xl text-xs font-bold border ${
                broadcastNotice.ok
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-error-500/15 border-error-500/40 text-error-300'
              }`}
            >
              {broadcastNotice.text}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            {targetTelegramId ? (
              <button
                type="button"
                onClick={() => setTargetTelegramId(null)}
                className="text-xs text-brand-300 hover:underline"
              >
                تغییر به ارسال همگانی برای همه کاربران
              </button>
            ) : (
              <span />
            )}
            <button type="submit" disabled={sending || !broadcastMessage.trim()} className="btn-primary flex items-center gap-2 text-xs">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {sending ? 'در حال ارسال...' : 'ارسال در ربات'}
            </button>
          </div>
        </form>
      )}

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="card p-4">
          <Users className="w-5 h-5 text-brand-300" />
          <p className="text-2xl font-bold text-white mt-2">{totals.all.toLocaleString('fa-IR')}</p>
          <p className="text-xs text-slate-300 mt-1">کل حساب‌های کاربری</p>
        </div>
        <div className="card p-4">
          <Bot className="w-5 h-5 text-brand-300" />
          <p className="text-2xl font-bold text-white mt-2">{totals.botUsers.toLocaleString('fa-IR')}</p>
          <p className="text-xs text-slate-300 mt-1">فضاهای کاربران ربات</p>
        </div>
        <div className="card p-4">
          <Shield className="w-5 h-5 text-emerald-400" />
          <p className="text-2xl font-bold text-white mt-2">{totals.admins.toLocaleString('fa-IR')}</p>
          <p className="text-xs text-slate-300 mt-1">مدیران پنل (Admin)</p>
        </div>
        <div className="card p-4">
          <Boxes className="w-5 h-5 text-brand-300" />
          <p className="text-2xl font-bold text-white mt-2">{totals.deployments.toLocaleString('fa-IR')}</p>
          <p className="text-xs text-slate-300 mt-1">مجموع ورکرهای ثبت‌شده</p>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="glass-card p-4 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="جستجو بر اساس ایمیل، آیدی تلگرام یا نام کاربر..."
            className="input-field pr-10 text-sm py-2.5"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[
            { id: 'all' as const, label: 'همه' },
            { id: 'web' as const, label: 'کاربران وب' },
            { id: 'bot' as const, label: 'کاربران ربات' },
            { id: 'admin' as const, label: 'ادمین‌ها' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition-all ${
                filter === tab.id
                  ? 'bg-brand-500/20 border-brand-400 text-brand-200'
                  : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="p-3.5 rounded-2xl bg-error-500/15 border border-error-500/35 text-xs font-bold text-error-300">
          {error}
        </div>
      )}

      <div className="card divide-y divide-slate-800/80">
        {filtered.map((u) => {
          const botLinked = isBotAccount(u)
          return (
            <div key={u.id} className="p-4 flex items-center justify-between gap-4 flex-wrap hover:bg-slate-800/25 transition-colors">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-white font-bold truncate" dir="ltr">
                    {u.telegram_first_name ? `${u.telegram_first_name} (${u.email})` : u.email}
                  </p>
                  {botLinked && (
                    <span className="px-2 py-0.5 rounded-md bg-brand-500/15 border border-brand-400/30 text-[11px] font-bold text-brand-200">
                      ربات تلگرام {u.telegram_username ? `@${u.telegram_username}` : u.telegram_id ? `#${u.telegram_id}` : ''}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-wrap text-xs text-slate-300 mt-1.5">
                  <span className="inline-flex items-center gap-1 font-medium">
                    <Boxes className="w-3.5 h-3.5 text-brand-300" />
                    {Number(u.deployments ?? 0).toLocaleString('fa-IR')} ورکر کل
                  </span>
                  {u.deployed_count !== undefined && (
                    <span className="text-emerald-300 font-medium">
                      • {Number(u.deployed_count).toLocaleString('fa-IR')} سالم
                    </span>
                  )}
                  {u.failed_count !== undefined && Number(u.failed_count) > 0 && (
                    <span className="text-error-300 font-medium">
                      • {Number(u.failed_count).toLocaleString('fa-IR')} ناموفق
                    </span>
                  )}
                  {u.tokens_count !== undefined && (
                    <span className="inline-flex items-center gap-1 text-slate-300">
                      <KeyRound className="w-3 h-3 text-slate-400" />
                      {Number(u.tokens_count).toLocaleString('fa-IR')} توکن
                    </span>
                  )}
                  <span>• عضویت {new Date(u.created_at).toLocaleDateString('fa-IR')}</span>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {u.telegram_id && (
                  <button
                    type="button"
                    onClick={() => {
                      setTargetTelegramId(u.telegram_id ?? null)
                      setBroadcastNotice(null)
                      setShowBroadcast(true)
                    }}
                    title="ارسال پیام مستقیم در ربات تلگرام"
                    className="p-2 rounded-xl bg-brand-500/15 border border-brand-400/35 text-brand-200 hover:bg-brand-500/25 transition"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                )}

                {/* Role toggle */}
                <button
                  type="button"
                  onClick={() => patch(u.id, { role: u.role === 'admin' ? 'user' : 'admin' })}
                  className={`text-xs px-3 py-1.5 rounded-xl font-bold transition border ${
                    u.role === 'admin'
                      ? 'bg-brand-500/20 text-brand-200 border-brand-400/50'
                      : 'bg-slate-800/80 text-slate-200 border-slate-700 hover:border-brand-400/40'
                  }`}
                >
                  {u.role === 'admin' ? 'ادمین' : 'کاربر'}
                </button>

                {/* Quota */}
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={quotaDraft[u.id] ?? String(u.max_deployments)}
                    onChange={(e) => setQuotaDraft((d) => ({ ...d, [u.id]: e.target.value }))}
                    className="input-field w-20 py-1.5 px-2 text-center text-xs font-bold"
                    title="سقف تعداد ورکر"
                  />
                  <button
                    type="button"
                    onClick={() => patch(u.id, { max_deployments: Number(quotaDraft[u.id] ?? u.max_deployments) })}
                    className="p-2 rounded-xl bg-brand-500/15 border border-brand-400/35 text-brand-200 hover:bg-brand-500/25"
                    title="ذخیره سقف"
                  >
                    <Check className={`w-4 h-4 ${saved === u.id ? 'text-emerald-400' : ''}`} />
                  </button>
                </div>

                {/* Delete user */}
                <button
                  type="button"
                  onClick={() => handleDeleteUser(u)}
                  title="حذف حساب کاربر"
                  className="p-2 rounded-xl bg-error-500/10 border border-error-500/25 text-error-300 hover:bg-error-500/20 transition"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          )
        })}
        {filtered.length === 0 && !error && (
          <p className="text-sm text-slate-300 font-medium text-center py-10">کاربری با این مشخصات یافت نشد</p>
        )}
      </div>
    </div>
  )
}
