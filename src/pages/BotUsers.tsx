import { useEffect, useState, useCallback } from 'react'
import { api } from '../lib/api'
import type { BotUser } from '../lib/types'
import {
  Users,
  Loader2,
  Search,
  UserCheck,
  UserX,
  Trash2,
  TrendingUp,
  Send,
  Megaphone,
  Check,
  Boxes,
  KeyRound,
  CheckSquare,
  Square,
  X,
} from 'lucide-react'

export default function BotUsers() {
  const [users, setUsers] = useState<BotUser[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'active' | 'blocked'>('all')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({})
  const [savedQuotaId, setSavedQuotaId] = useState<string | null>(null)

  // Broadcast / Direct message state
  const [showBroadcast, setShowBroadcast] = useState(false)
  const [broadcastTarget, setBroadcastTarget] = useState<'active' | 'all' | 'selected'>('active')
  const [broadcastText, setBroadcastText] = useState('')
  const [buttonText, setButtonText] = useState('')
  const [buttonUrl, setButtonUrl] = useState('')
  const [sending, setSending] = useState(false)
  const [broadcastResult, setBroadcastResult] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: BotUser[] }>('/bot-users')
      setUsers(data ?? [])
    } catch {
      setUsers([])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleToggle = async (user: BotUser) => {
    try {
      await api(`/bot-users/${user.id}`, { method: 'PATCH', body: { is_active: !user.is_active } })
    } catch {
      /* ignore */
    }
    load()
  }

  const handleQuotaSave = async (user: BotUser) => {
    const val = Number(quotaDraft[user.id] ?? user.max_deployments ?? 10)
    if (!Number.isFinite(val) || val < 1) return
    try {
      await api(`/bot-users/${user.id}`, { method: 'PATCH', body: { max_deployments: val } })
      setSavedQuotaId(user.id)
      setTimeout(() => setSavedQuotaId(null), 1500)
      load()
    } catch {
      /* ignore */
    }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`«${name}» از لیست کاربران ربات حذف شود؟\nفضای استقرار، توکن‌ها و استقرارهای او پاک نمی‌شوند.`)) return
    try {
      await api(`/bot-users/${id}`, { method: 'DELETE' })
    } catch {
      /* ignore */
    }
    load()
  }

  const toggleSelectUser = (telegramId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(telegramId)) next.delete(telegramId)
      else next.add(telegramId)
      return next
    })
  }

  const openDirectMessage = (user: BotUser) => {
    setSelectedIds(new Set([user.telegram_id]))
    setBroadcastTarget('selected')
    setBroadcastResult(null)
    setShowBroadcast(true)
  }

  const handleSendBroadcast = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!broadcastText.trim()) return
    setSending(true)
    setBroadcastResult(null)
    try {
      const res = await api<{ data: { total: number; sent: number; failed: number } }>('/bot-users/broadcast', {
        method: 'POST',
        body: {
          message: broadcastText.trim(),
          target: broadcastTarget,
          telegram_ids: broadcastTarget === 'selected' ? Array.from(selectedIds) : undefined,
          button_text: buttonText.trim() || undefined,
          button_url: buttonUrl.trim() || undefined,
        },
      })
      const d = res.data
      setBroadcastResult({
        type: 'ok',
        text: `✅ پیام با موفقیت برای ${d.sent.toLocaleString('fa-IR')} از ${d.total.toLocaleString('fa-IR')} کاربر ارسال شد${d.failed > 0 ? ` (${d.failed.toLocaleString('fa-IR')} ناموفق/بلاک‌شده)` : ''}.`,
      })
      setBroadcastText('')
    } catch (err) {
      setBroadcastResult({
        type: 'err',
        text: err instanceof Error ? err.message : 'خطا در ارسال پیام',
      })
    } finally {
      setSending(false)
    }
  }

  const filtered = users.filter((u) => {
    const matchSearch =
      !search ||
      u.username?.toLowerCase().includes(search.toLowerCase()) ||
      u.first_name?.toLowerCase().includes(search.toLowerCase()) ||
      u.telegram_id.includes(search)
    const matchFilter = filter === 'all' ? true : filter === 'active' ? u.is_active : !u.is_active
    return matchSearch && matchFilter
  })

  const selectAllFiltered = () => {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map((u) => u.telegram_id)))
    }
  }

  const stats = {
    total: users.length,
    active: users.filter((u) => u.is_active).length,
    blocked: users.filter((u) => !u.is_active).length,
    totalWorkers: users.reduce((acc, u) => acc + (u.deployments_count ?? 0), 0),
    today: users.filter((u) => {
      const d = new Date(u.created_at)
      const today = new Date()
      return d.toDateString() === today.toDateString()
    }).length,
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-brand-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">مدیریت پیشرفته کاربران ربات</h1>
          <p className="text-slate-300 text-sm mt-1">
            ارسال پیام همگانی یا تکی، کنترل سهمیه ورکرها، مشاهده آمار استقرار و مدیریت دسترسی کاربران تلگرام
          </p>
        </div>
        <button
          onClick={() => {
            setBroadcastTarget(selectedIds.size > 0 ? 'selected' : 'active')
            setBroadcastResult(null)
            setShowBroadcast((p) => !p)
          }}
          className="btn-primary flex items-center justify-center gap-2 text-sm shrink-0"
        >
          <Megaphone className="w-4 h-4" />
          {showBroadcast ? 'بستن پنل پیام‌رسان' : 'ارسال پیام به کاربران ربات'}
        </button>
      </div>

      {/* Broadcast / Direct Message Panel */}
      {showBroadcast && (
        <form onSubmit={handleSendBroadcast} className="glass-card p-5 space-y-4 border-brand-400/40 animate-fade-in">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-brand-500/15 border border-brand-400/35">
                <Megaphone className="w-5 h-5 text-brand-300" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">ارسال پیام در ربات تلگرام</h2>
                <p className="text-xs text-slate-300">پیام شما مستقیماً از طریق ربات برای کاربران انتخاب‌شده ارسال می‌شود</p>
              </div>
            </div>
            <button type="button" onClick={() => setShowBroadcast(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              { id: 'active' as const, label: `همه کاربران فعال (${stats.active.toLocaleString('fa-IR')})` },
              { id: 'all' as const, label: `کل کاربران (${stats.total.toLocaleString('fa-IR')})` },
              { id: 'selected' as const, label: `کاربران انتخاب‌شده (${selectedIds.size.toLocaleString('fa-IR')})` },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setBroadcastTarget(t.id)}
                className={`px-3.5 py-2 rounded-xl text-xs font-bold transition-all border ${
                  broadcastTarget === t.id
                    ? 'bg-brand-500/20 border-brand-400 text-brand-200'
                    : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-200 mb-1.5">متن پیام (پشتیبانی از تگ‌های HTML مانند &lt;b&gt; و &lt;code&gt;)</label>
            <textarea
              rows={4}
              value={broadcastText}
              onChange={(e) => setBroadcastText(e.target.value)}
              placeholder="متن اطلاعیه، آپدیت پنل یا پیام اختصاصی خود را بنویسید..."
              className="input-field text-sm leading-6"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">متن دکمه شیشه‌ای زیر پیام (اختیاری)</label>
              <input
                type="text"
                value={buttonText}
                onChange={(e) => setButtonText(e.target.value)}
                placeholder="مثلاً: 🚀 ورود به مینی‌اپ"
                className="input-field text-xs py-2.5"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">لینک دکمه شیشه‌ای (اختیاری)</label>
              <input
                type="url"
                dir="ltr"
                value={buttonUrl}
                onChange={(e) => setButtonUrl(e.target.value)}
                placeholder="https://t.me/..."
                className="input-field text-xs py-2.5"
              />
            </div>
          </div>

          {broadcastResult && (
            <div
              className={`p-3 rounded-xl text-xs font-bold border ${
                broadcastResult.type === 'ok'
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                  : 'bg-error-500/15 border-error-500/40 text-error-300'
              }`}
            >
              {broadcastResult.text}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="submit"
              disabled={sending || !broadcastText.trim() || (broadcastTarget === 'selected' && selectedIds.size === 0)}
              className="btn-primary flex items-center gap-2 text-xs"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {sending ? 'در حال ارسال...' : 'ارسال فوری پیام'}
            </button>
          </div>
        </form>
      )}

      {/* KPI Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="stat-card p-4">
          <div className="p-2 rounded-xl bg-blue-500/15 inline-block mb-2">
            <Users className="w-5 h-5 text-blue-300" />
          </div>
          <p className="text-2xl font-bold text-white">{stats.total.toLocaleString('fa-IR')}</p>
          <p className="text-xs text-slate-300 mt-1">کل کاربران ربات</p>
        </div>
        <div className="stat-card p-4">
          <div className="p-2 rounded-xl bg-emerald-500/15 inline-block mb-2">
            <UserCheck className="w-5 h-5 text-emerald-300" />
          </div>
          <p className="text-2xl font-bold text-white">{stats.active.toLocaleString('fa-IR')}</p>
          <p className="text-xs text-slate-300 mt-1">کاربران فعال</p>
        </div>
        <div className="stat-card p-4">
          <div className="p-2 rounded-xl bg-error-500/15 inline-block mb-2">
            <UserX className="w-5 h-5 text-error-400" />
          </div>
          <p className="text-2xl font-bold text-white">{stats.blocked.toLocaleString('fa-IR')}</p>
          <p className="text-xs text-slate-300 mt-1">مسدود شده</p>
        </div>
        <div className="stat-card p-4">
          <div className="p-2 rounded-xl bg-brand-500/15 inline-block mb-2">
            <Boxes className="w-5 h-5 text-brand-300" />
          </div>
          <p className="text-2xl font-bold text-white">{stats.totalWorkers.toLocaleString('fa-IR')}</p>
          <p className="text-xs text-slate-300 mt-1">کل ورکرهای کاربران</p>
        </div>
        <div className="stat-card p-4 col-span-2 lg:col-span-1">
          <div className="p-2 rounded-xl bg-brand-500/15 inline-block mb-2">
            <TrendingUp className="w-5 h-5 text-brand-300" />
          </div>
          <p className="text-2xl font-bold text-white">{stats.today.toLocaleString('fa-IR')}</p>
          <p className="text-xs text-slate-300 mt-1">ورود جدید امروز</p>
        </div>
      </div>

      {/* Filters */}
      <div className="glass-card p-4">
        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="جستجو بر اساس نام، یوزرنیم یا آیدی عددی تلگرام..."
              className="input-field pr-11 text-sm"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            {(['all', 'active', 'blocked'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-2.5 rounded-xl text-xs font-bold transition-all border ${
                  filter === f
                    ? 'bg-brand-500/20 border-brand-400 text-brand-200'
                    : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:text-white'
                }`}
              >
                {f === 'all' ? 'همه' : f === 'active' ? 'فعال' : 'مسدود'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Users table */}
      {filtered.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <Users className="w-12 h-12 text-slate-500 mx-auto mb-4" />
          <p className="text-slate-300 font-medium">{users.length === 0 ? 'هنوز کاربری به ربات نپیوسته است' : 'کاربری با این مشخصات یافت نشد'}</p>
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800/70 text-right">
                  <th className="px-3 py-3 text-xs font-bold text-slate-300 w-10">
                    <button
                      type="button"
                      onClick={selectAllFiltered}
                      className="p-1 rounded-lg text-slate-300 hover:text-white"
                      title="انتخاب همه"
                    >
                      {selectedIds.size === filtered.length && filtered.length > 0 ? (
                        <CheckSquare className="w-4 h-4 text-brand-300" />
                      ) : (
                        <Square className="w-4 h-4" />
                      )}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-xs font-bold text-slate-300">کاربر</th>
                  <th className="px-4 py-3 text-xs font-bold text-slate-300 hidden sm:table-cell">آیدی تلگرام</th>
                  <th className="px-4 py-3 text-xs font-bold text-slate-300">ورکرها / توکن</th>
                  <th className="px-4 py-3 text-xs font-bold text-slate-300">سقف مجاز</th>
                  <th className="px-4 py-3 text-xs font-bold text-slate-300 hidden md:table-cell">آخرین فعالیت</th>
                  <th className="px-4 py-3 text-xs font-bold text-slate-300">وضعیت</th>
                  <th className="px-4 py-3 text-xs font-bold text-slate-300">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => {
                  const isSelected = selectedIds.has(user.telegram_id)
                  return (
                    <tr key={user.id} className="border-b border-slate-800/40 hover:bg-slate-800/35 transition-colors">
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          onClick={() => toggleSelectUser(user.telegram_id)}
                          className="p-1 rounded-lg text-slate-300 hover:text-white"
                        >
                          {isSelected ? <CheckSquare className="w-4 h-4 text-brand-300" /> : <Square className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-brand-200 font-bold text-sm shrink-0 bg-brand-500/15 border border-brand-400/35">
                            {(user.first_name ?? user.username ?? '?')[0]?.toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm text-white font-bold truncate">
                              {user.first_name} {user.last_name}
                            </p>
                            {user.username && (
                              <p className="text-xs text-slate-300 truncate" dir="ltr">
                                @{user.username}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <code className="text-xs text-slate-200 font-mono" dir="ltr">
                          {user.telegram_id}
                        </code>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-brand-500/15 text-brand-200 font-bold">
                            <Boxes className="w-3.5 h-3.5" />
                            {(user.deployments_count ?? 0).toLocaleString('fa-IR')}
                          </span>
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 text-slate-200 font-medium">
                            <KeyRound className="w-3.5 h-3.5 text-slate-400" />
                            {(user.tokens_count ?? 0).toLocaleString('fa-IR')}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={1}
                            max={1000}
                            value={quotaDraft[user.id] ?? String(user.max_deployments ?? 10)}
                            onChange={(e) => setQuotaDraft((d) => ({ ...d, [user.id]: e.target.value }))}
                            className="input-field w-16 py-1 px-2 text-center text-xs"
                            title="سقف استقرار ورکر برای این کاربر"
                          />
                          <button
                            type="button"
                            onClick={() => handleQuotaSave(user)}
                            className="p-1.5 rounded-lg bg-brand-500/15 border border-brand-400/35 text-brand-200 hover:bg-brand-500/25"
                            title="ذخیره سقف استقرار"
                          >
                            <Check className={`w-3.5 h-3.5 ${savedQuotaId === user.id ? 'text-emerald-400' : ''}`} />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <span className="text-xs text-slate-300">
                          {user.last_activity ? new Date(user.last_activity).toLocaleString('fa-IR') : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`badge ${user.is_active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-error-500/15 text-error-300'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? 'bg-emerald-400' : 'bg-error-400'}`} />
                          {user.is_active ? 'فعال' : 'مسدود'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openDirectMessage(user)}
                            title="ارسال پیام مستقیم در ربات"
                            className="p-2 rounded-lg text-brand-300 hover:bg-brand-500/15 transition-colors"
                          >
                            <Send className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggle(user)}
                            title={user.is_active ? 'مسدود کردن دسترسی' : 'رفع مسدودی'}
                            className="p-2 rounded-lg text-slate-300 hover:bg-slate-700/60 hover:text-white transition-colors"
                          >
                            {user.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(user.id, user.first_name ?? user.username ?? 'کاربر')}
                            title="حذف از لیست"
                            className="p-2 rounded-lg text-slate-300 hover:bg-error-500/15 hover:text-error-300 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
