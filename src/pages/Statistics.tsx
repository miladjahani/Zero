import { useCallback, useEffect, useState } from 'react'
import { BarChart3, RotateCw, Cloud, ShieldCheck, TriangleAlert, Users2, Bot, Boxes } from 'lucide-react'
import { api } from '../lib/api'

interface AggRow { src?: string; m?: string; status?: string; d?: string; c: number }
interface FailureRow {
  id: string
  name: string
  worker_source: string
  method: string
  error_message: string | null
  created_at: string
  user_email: string | null
}
interface TopUserRow { email: string; role: string; c: number }
interface SiteStats {
  totals: { deployments: number; users: number; botUsers: number; members: number; deployed: number; failed: number }
  byStatus: AggRow[]
  bySource: AggRow[]
  byMethod: AggRow[]
  daily: AggRow[]
  topUsers: TopUserRow[]
  failures: FailureRow[]
  selfCheck: Record<string, number>
}

const SOURCE_TAGS: Record<string, string> = {
  custom: 'CFnew',
  nexus: 'NEXUS',
  zeus: 'ZEUS',
  miliconfigzeus: 'miliconfig zeus',
  nova: 'Nova',
  milios: 'Mili',
  miliconfigosv3: 'miliconfigOS v3',
  edgetunnel: 'edgetunnel',
  edgetunnel_kv: 'edgetunnel (KV)',
  github: 'مخزن گیت‌هاب',
}

function fa(n: number): string {
  return n.toLocaleString('fa-IR')
}

/** Days in fa-IR for the chart labels (tolerates aggregate rows without a day). */
function faDay(day?: string): string {
  if (!day) return ''
  try {
    return new Date(day).toLocaleDateString('fa-IR', { day: 'numeric', month: 'short' })
  } catch {
    return day
  }
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="card p-4 sm:p-5">
      <div className="mb-4">
        <h2 className="text-sm font-bold text-white">{title}</h2>
        {sub && <p className="eyebrow-muted mt-0.5">{sub}</p>}
      </div>
      {children}
    </div>
  )
}

export default function Statistics() {
  const [stats, setStats] = useState<SiteStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // The API wraps its payload in `data`. Accept a bare payload too: a panel
      // talking to an older Worker build used to answer without the wrapper, and
      // that mismatch is exactly what left this tab on "آماری موجود نیست".
      const res = await api<{ data?: SiteStats } & Partial<SiteStats>>('/admin/site-stats')
      const payload = res.data ?? (res.totals ? (res as SiteStats) : null)
      setStats(payload && payload.totals ? payload : null)
      setError(null)
    } catch (e) {
      setStats(null)
      setError(e instanceof Error ? e.message : 'خطا در دریافت آمار')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading && !stats) {
    return <div className="animate-pulse text-brand-400 text-sm py-16 text-center">در حال دریافت آمار…</div>
  }
  if (error || !stats) {
    return (
      <div className="card p-8 text-center space-y-3">
        <TriangleAlert className="w-8 h-8 text-error-400 mx-auto" />
        <p className="text-slate-400 text-sm">{error ?? 'آماری موجود نیست'}</p>
        <button onClick={load} className="btn-ghost text-sm">تلاش دوباره</button>
      </div>
    )
  }

  const t = stats.totals
  const successRate = t.deployments > 0 ? Math.round((t.deployed / (t.deployed + t.failed)) * 100) : null
  const dailyMax = Math.max(1, ...stats.daily.map((r) => r.c))
  const sourceMax = Math.max(1, ...stats.bySource.map((r) => r.c))
  const totalBySource = Math.max(1, stats.bySource.reduce((a, r) => a + r.c, 0))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-black/60 border border-brand-300/35 flex items-center justify-center shadow-[0_0_24px_-6px_rgba(var(--t-accent-rgb),0.5)]">
            <BarChart3 className="w-6 h-6 text-brand-300" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">آمار</h1>          <p className="eyebrow-muted mt-1">SITE OVERVIEW</p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="btn-ghost flex items-center gap-2 text-sm disabled:opacity-50"
        >
          <RotateCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          بروزرسانی
        </button>
      </div>

      {/* KPI cards — the primary deployment overview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { icon: Boxes, label: 'کل استقرارها', value: fa(t.deployments), tone: 'text-white' },
          { icon: ShieldCheck, label: 'مستقر و سالم', value: fa(t.deployed), tone: 'text-brand-300' },
          { icon: TriangleAlert, label: 'ناموفق', value: fa(t.failed), tone: 'text-error-400' },
          { icon: Users2, label: 'کاربران پنل', value: fa(t.users), tone: 'text-white' },
        ].map((k) => (
          <div key={k.label} className="card p-4">
            <k.icon className={`w-5 h-5 ${k.tone}`} />
            <p className={`text-2xl font-bold mt-2 ${k.tone}`}>{k.value}</p>
            <p className="text-xs text-slate-500 mt-1">{k.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2">
          <Card title="استقرارهای ۱۴ روز اخیر" sub="DAILY DEPLOYMENTS">
            {stats.daily.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">استقراری در این بازه ثبت نشده</p>
            ) : (
              <div className="flex items-end gap-1.5 h-36" dir="ltr">
                {stats.daily.map((r, i) => (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1 group min-w-0">
                    <div className="w-full flex items-end justify-center">
                      <div
                        className="w-full max-w-8 rounded-t-md bg-gradient-to-t from-brand-500/40 to-brand-300 transition-all group-hover:from-brand-500 group-hover:to-brand-200"
                        title={`${fa(r.c)} استقرار — ${faDay(r.d)}`}
                        style={{ height: `${Math.max(6, (r.c / dailyMax) * 100)}%` }}
                      />
                    </div>
                    <span className="text-[9px] text-slate-600 rotate-45 origin-top-left whitespace-nowrap">{faDay(r.d)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Card title="وضعیت سلف‌چک" sub="SELF-CHECK — DEPLOYED ONLY">
          <div className="space-y-2.5">
            {[
              { key: 'passed', label: 'سالم (پاس داد)', tone: 'bg-brand-400' },
              { key: 'failed', label: 'پاس نداد', tone: 'bg-error-400' },
              { key: 'none', label: 'بدون بررسی', tone: 'bg-slate-500' },
            ].map((s) => {
              const c = stats.selfCheck[s.key] ?? 0
              const total = Math.max(1, Object.values(stats.selfCheck).reduce((a, b) => a + b, 0))
              return (
                <div key={s.key}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="flex items-center gap-2 text-slate-300">
                      <span className={`w-2 h-2 rounded-full ${s.tone}`} />{s.label}
                    </span>
                    <span className="text-slate-400 font-mono">{fa(c)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                    <div className={`h-full rounded-full ${s.tone}`} style={{ width: `${(c / total) * 100}%` }} />
                  </div>
                </div>
              )
            })}
            {successRate !== null && (
              <p className="text-[11px] text-slate-500 pt-1">
                نرخ موفقیت کلی: <span className="text-brand-300 font-bold">{fa(successRate)}٪</span>
              </p>
            )}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title="کدام ورکر/پنل بیشتر استقرار یافته" sub="BY SOURCE">
          {stats.bySource.length === 0 ? (
            <p className="text-xs text-slate-500 py-4 text-center">هنوز استقراری نیست</p>
          ) : (
            <div className="space-y-3">
              {stats.bySource.map((r, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-slate-300 flex items-center gap-2">
                      <Cloud className="w-3.5 h-3.5 text-slate-500" />
                      {SOURCE_TAGS[r.src ?? ''] ?? r.src}
                    </span>
                    <span className="text-slate-500 font-mono">
                      {fa(r.c)} · {fa(Math.round((r.c / totalBySource) * 100))}٪
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-l from-brand-500/70 to-brand-300"
                      style={{ width: `${Math.max(4, (r.c / sourceMax) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="space-y-3">
          <Card title="محیط اجرا" sub="BY METHOD">
            <div className="flex flex-wrap gap-2">
              {stats.byMethod.map((r, i) => (
                <span
                  key={i}
                  className="text-xs px-3 py-1.5 rounded-full bg-slate-800/70 border border-slate-700 text-slate-300"
                >
                  {r.m === 'pages' ? 'صفحات (Pages)' : r.m === 'workers' ? 'CF Workers' : r.m} · {fa(r.c)}
                </span>
              ))}
              {stats.byMethod.length === 0 && <p className="text-xs text-slate-500">داده‌ای نیست</p>}
            </div>
          </Card>
          <div className="card p-4 sm:p-5">
            <div className="flex items-center gap-2 mb-3">
              <Bot className="w-4 h-4 text-brand-300" />
              <h2 className="text-sm font-bold text-white">ربات تلگرام</h2>
            </div>
            <p className="text-xs text-slate-400">
              <span className="text-white font-bold text-lg">{fa(t.botUsers)}</span> کاربرِ ربات ثبت شده
            </p>
            <div className="flex items-center gap-2 mt-3">
              <Boxes className="w-4 h-4 text-brand-300" />
              <p className="text-xs text-slate-400">
                <span className="text-white font-bold text-lg">{fa(t.members)}</span> کاربر ورکر (members)
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title="پرکارترین کاربران" sub="TOP DEPLOYERS">
          {stats.topUsers.length === 0 ? (
            <p className="text-xs text-slate-500 py-4 text-center">داده‌ای نیست</p>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {stats.topUsers.map((u, i) => (
                <div key={i} className="flex items-center justify-between py-2.5 gap-3">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="w-6 h-6 rounded-lg bg-black/50 border border-white/10 flex items-center justify-center text-[10px] text-brand-200 font-bold shrink-0">
                      {u.email?.[0]?.toUpperCase() ?? '?'}
                    </span>
                    <span className="text-sm text-slate-200 truncate" dir="ltr">{u.email}</span>
                    {u.role === 'admin' && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-500/15 text-brand-300 border border-brand-500/30 shrink-0">ادمین</span>
                    )}
                  </div>
                  <span className="text-xs text-slate-500 font-mono shrink-0">{fa(u.c)} ورکر</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="آخرین استقرارهای ناموفق" sub="RECENT FAILURES">
          {stats.failures.length === 0 ? (
            <p className="text-xs text-brand-300 py-4 text-center">هیچ استقرار ناموفقی ثبت نشده ✓</p>
          ) : (
            <div className="divide-y divide-slate-800/70 max-h-80 overflow-y-auto">
              {stats.failures.map((f) => (
                <div key={f.id} className="py-2.5 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-slate-200 truncate">{f.name}</span>
                    <span className="text-[10px] text-slate-600 shrink-0">
                      {SOURCE_TAGS[f.worker_source] ?? f.worker_source} · {f.method === 'pages' ? 'Pages' : 'Workers'}
                    </span>
                  </div>
                  <p className="text-[11px] text-error-400/90 truncate" title={f.error_message ?? ''}>
                    {f.error_message ?? '—'} <span className="text-slate-600" dir="ltr">· {f.user_email ?? ''}</span>
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
