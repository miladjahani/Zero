import { NavLink, useNavigate, Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { api, downloadApi } from '../lib/api'
import LiveGuide from './LiveGuide'
import OnboardingModals from './OnboardingModals'
import {
  LayoutDashboard,
  KeyRound,
  Users,
  UsersRound,
  Bot,
  ScrollText,
  LogOut,
  Cloud,
  Menu,
  X,
  UserPlus,
  Zap,
  Shield,
  BookOpen,
  ChevronLeft,
  BarChart3,
  Palette,
  Sparkles,
  Check,
  Database,
  Download,
  Upload,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface NavItem { to: string; label: string; icon: typeof LayoutDashboard; end?: boolean; guide?: string }

interface ThemePreset {
  id: string
  name: string
  subtitle: string
  bg: string
  card: string
  accent: string
  accent2: string
}

const THEME_PRESETS: ThemePreset[] = [
  { id: 'zedsecure', name: 'پیش‌فرض ZedSecure', subtitle: 'بنتو بنفش تیره و صورتی', bg: '#09080f', card: '#181426', accent: '#c4b5fd', accent2: '#f472b6' },
  { id: 'aurora', name: 'Aurora', subtitle: 'شفق قطبی فیروزه‌ای', bg: '#051010', card: '#0d2424', accent: '#2dd4bf', accent2: '#818cf8' },
  { id: 'neon', name: 'Neon Lime', subtitle: 'سبز فسفری نکسوس', bg: '#0a0f0b', card: '#121d15', accent: '#c6f45b', accent2: '#4ade80' },
  { id: 'tokyo', name: 'Tokyo', subtitle: 'سرمه‌ای سایبرپانک', bg: '#070b14', card: '#111a2e', accent: '#7aa2f7', accent2: '#bb9af7' },
  { id: 'solar', name: 'Solar', subtitle: 'طلایی خورشیدی گرم', bg: '#110d05', card: '#211909', accent: '#facc15', accent2: '#fb923c' },
  { id: 'ember', name: 'Ember', subtitle: 'نارنجی آتشین', bg: '#120906', card: '#24120c', accent: '#fb923c', accent2: '#f43f5e' },
  { id: 'moss', name: 'Moss', subtitle: 'زمردی جنگلی', bg: '#05110b', card: '#0c2418', accent: '#34d399', accent2: '#10b981' },
  { id: 'clay', name: 'Clay', subtitle: 'سفالی گرم و مدرن', bg: '#110b09', card: '#221613', accent: '#e07a5f', accent2: '#f2cc8f' },
  { id: 'light', name: 'Light', subtitle: 'روشن و مینیمال روزانه', bg: '#f4f6fb', card: '#ffffff', accent: '#4f46e5', accent2: '#0ea5e9' },
]

const baseNavItems: NavItem[] = [
  { to: '/', label: 'داشبورد', icon: LayoutDashboard, end: true, guide: 'nav-dashboard' },
  { to: '/tokens', label: 'توکن‌ها', icon: KeyRound, guide: 'nav-tokens' },
  { to: '/deploy', label: 'استقرار جدید', icon: UserPlus, guide: 'nav-deploy' },
  { to: '/deployments', label: 'ورکرها و پنل', icon: Cloud, guide: 'nav-deployments' },
  { to: '/optimizer', label: 'بهینه‌ساز', icon: Zap, guide: 'nav-optimizer' },
  { to: '/members', label: 'کاربران ورکر', icon: UsersRound, guide: 'nav-members' },
  { to: '/bot-config', label: 'ربات تلگرام', icon: Bot, guide: 'nav-bot-config' },
  { to: '/bot-users', label: 'کاربران ربات', icon: Users, guide: 'nav-bot-users' },
  { to: '/logs', label: 'لاگ‌ها', icon: ScrollText, guide: 'nav-logs' },
  { to: '/guide', label: 'راهنما', icon: BookOpen, guide: 'nav-guide' },
]

const adminNavItems: NavItem[] = [
  { to: '/stats', label: 'آمار', icon: BarChart3, guide: 'nav-stats' },
  { to: '/admin', label: 'مدیریت کاربران', icon: Shield, guide: 'nav-admin' },
]

function faIndex(n: number): string {
  const digits = '۰۱۲۳۴۵۶۷۸۹'
  return String(n + 1).padStart(2, '0').replace(/\d/g, (d) => digits[Number(d)])
}

function BrandMark({ size = 'md' }: { size?: 'md' | 'sm' }) {
  const box = size === 'sm' ? 'w-8 h-8 rounded-lg' : 'w-11 h-11 rounded-2xl'
  return (
    <img
      src="/icon.svg"
      alt=""
      aria-hidden="true"
      className={`${box} shrink-0 object-cover border`}
      style={{
        borderColor: 'rgba(var(--t-accent-rgb), 0.4)',
        boxShadow: '0 0 24px -6px rgba(var(--t-accent-rgb), 0.5)',
      }}
    />
  )
}

function LiveChip({ label = 'زنده' }: { label?: string }) {
  return (
    <span className="chip-live">
      <span
        className="w-1.5 h-1.5 rounded-full animate-pulse-dot"
        style={{ backgroundColor: 'var(--t-accent)' }}
      />
      {label}
    </span>
  )
}

/**
 * Interactive Background FX Canvas that automatically syncs its palette with
 * the active theme (`THEME_PRESETS`) and can be switched On or Off with one tap.
 */
function ThemeBackgroundFx({ enabled, themeId }: { enabled: boolean; themeId: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!enabled) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const preset = THEME_PRESETS.find((t) => t.id === themeId) ?? THEME_PRESETS[0]
    let width = (canvas.width = window.innerWidth)
    let height = (canvas.height = window.innerHeight)

    const onResize = () => {
      width = canvas.width = window.innerWidth
      height = canvas.height = window.innerHeight
    }
    window.addEventListener('resize', onResize)

    const count = Math.min(36, Math.max(18, Math.floor(width / 48)))
    const nodes = Array.from({ length: count }, (_, i) => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.45,
      vy: (Math.random() - 0.5) * 0.45,
      r: 1.5 + (i % 3) * 0.9,
      alt: i % 2 === 0,
    }))

    let raf = 0
    const render = () => {
      ctx.clearRect(0, 0, width, height)
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[i]
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0 || p.x > width) p.vx *= -1
        if (p.y < 0 || p.y > height) p.vy *= -1

        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = p.alt ? preset.accent : preset.accent2
        ctx.globalAlpha = themeId === 'light' ? 0.25 : 0.38
        ctx.fill()

        for (let j = i + 1; j < nodes.length; j++) {
          const q = nodes[j]
          const dx = p.x - q.x
          const dy = p.y - q.y
          const dist = Math.hypot(dx, dy)
          if (dist < 140) {
            ctx.beginPath()
            ctx.moveTo(p.x, p.y)
            ctx.lineTo(q.x, q.y)
            ctx.strokeStyle = preset.accent
            ctx.globalAlpha = (1 - dist / 140) * (themeId === 'light' ? 0.08 : 0.12)
            ctx.lineWidth = 1
            ctx.stroke()
          }
        }
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [enabled, themeId])

  if (!enabled) return null
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 pointer-events-none z-0"
    />
  )
}

/** Custom Desktop Mouse Cursor + Spring Ring */
function CustomCursor() {
  const dotRef = useRef<HTMLDivElement | null>(null)
  const ringRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      return
    }
    document.body.classList.add('custom-cursor-ready')
    let mx = -100, my = -100
    let rx = -100, ry = -100
    let raf = 0

    const onMove = (e: MouseEvent) => {
      mx = e.clientX
      my = e.clientY
      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${mx - 4}px, ${my - 4}px, 0)`
      }
      const target = e.target as HTMLElement | null
      const interactive = !!target?.closest('a, button, select, input, textarea, [role="button"]')
      if (ringRef.current) {
        ringRef.current.classList.toggle('is-hover', interactive)
      }
    }

    const tick = () => {
      rx += (mx - rx) * 0.22
      ry += (my - ry) * 0.22
      if (ringRef.current) {
        const size = ringRef.current.classList.contains('is-hover') ? 23 : 16
        ringRef.current.style.transform = `translate3d(${rx - size}px, ${ry - size}px, 0)`
      }
      raf = requestAnimationFrame(tick)
    }

    window.addEventListener('mousemove', onMove, { passive: true })
    raf = requestAnimationFrame(tick)
    return () => {
      document.body.classList.remove('custom-cursor-ready')
      window.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <>
      <div ref={dotRef} className="mili-cursor-dot hidden lg:block" />
      <div ref={ringRef} className="mili-cursor-ring hidden lg:block" />
    </>
  )
}

/** Modal / Drawer for selecting one of the 9 Android Material You / Bento themes + toggling Background FX */
function ThemeStudioModal({
  open,
  onClose,
  themeId,
  onSelectTheme,
  bgFx,
  onToggleBgFx,
}: {
  open: boolean
  onClose: () => void
  themeId: string
  onSelectTheme: (id: string) => void
  bgFx: boolean
  onToggleBgFx: () => void
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in" onClick={onClose}>
      <div
        className="glass-card w-full max-w-2xl p-6 max-h-[88vh] overflow-y-auto space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b pb-4" style={{ borderColor: 'var(--t-line)' }}>
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-2xl flex items-center justify-center"
              style={{ background: 'rgba(var(--t-accent-rgb), 0.14)', color: 'var(--t-accent)' }}
            >
              <Palette className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">تم‌های آماده و ظاهر برنامه</h2>
              <p className="text-xs text-slate-400">یک قالب کامل انتخاب کنید؛ رنگ‌ها، چیدمان کارت‌ها، دکمه‌ها، موس و افکت پس‌زمینه هماهنگ می‌شوند.</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" title="بستن">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Single On/Off Background FX toggle synced with theme */}
        <div
          className="flex items-center justify-between p-4 rounded-2xl border"
          style={{ background: 'var(--t-surface)', borderColor: 'var(--t-line)' }}
        >
          <div className="flex items-center gap-3">
            <Sparkles className="w-5 h-5" style={{ color: 'var(--t-accent)' }} />
            <div>
              <p className="text-sm font-bold text-white">افکت زنده پس‌زمینه (هماهنگ با تم)</p>
              <p className="text-xs text-slate-400">ذرات نوری و شبکه پس‌زمینه متناسب با رنگ تم انتخابی شما</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onToggleBgFx}
            className="px-4 py-2 rounded-full text-xs font-bold transition-all"
            style={{
              background: bgFx ? 'var(--t-accent)' : 'rgba(255,255,255,0.06)',
              color: bgFx ? 'var(--t-btn-text)' : 'var(--t-text)',
              border: '1px solid var(--t-line-strong)',
            }}
          >
            {bgFx ? 'روشن ✓' : 'خاموش'}
          </button>
        </div>

        {/* Curated Android Material You / Bento Theme Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
          {THEME_PRESETS.map((t) => {
            const active = t.id === themeId
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelectTheme(t.id)}
                className="group text-right p-3.5 rounded-3xl border transition-all duration-200 flex flex-col gap-2.5 relative"
                style={{
                  background: t.bg,
                  borderColor: active ? t.accent : 'rgba(255,255,255,0.1)',
                  boxShadow: active ? `0 0 0 2px ${t.accent}44, 0 12px 28px -10px ${t.accent}55` : 'none',
                }}
              >
                {/* Android phone preview illustration matching user screenshots */}
                <div
                  className="w-full rounded-2xl p-3 flex flex-col items-center gap-2 border"
                  style={{ background: t.card, borderColor: `${t.accent}28` }}
                >
                  <div
                    className="w-9 h-9 rounded-full shadow-md"
                    style={{ background: `linear-gradient(135deg, ${t.accent}, ${t.accent2})` }}
                  />
                  <div className="grid grid-cols-2 gap-1.5 w-full">
                    <div className="h-5 rounded-lg flex items-center justify-center" style={{ background: `${t.accent}22` }}>
                      <div className="w-3.5 h-1 rounded-full" style={{ background: t.accent }} />
                    </div>
                    <div className="h-5 rounded-lg flex items-center justify-center" style={{ background: `${t.accent2}22` }}>
                      <div className="w-3.5 h-1 rounded-full" style={{ background: t.accent2 }} />
                    </div>
                  </div>
                  <div className="w-full h-3.5 rounded-full" style={{ background: t.accent }} />
                </div>

                <div className="flex items-center justify-between w-full px-1">
                  <div>
                    <p className="text-xs font-bold" style={{ color: t.id === 'light' ? '#0f172a' : '#ffffff' }}>
                      {t.name}
                    </p>
                    <p className="text-[10px] opacity-75" style={{ color: t.id === 'light' ? '#475569' : '#94a3b8' }}>
                      {t.subtitle}
                    </p>
                  </div>
                  {active && (
                    <span
                      className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                      style={{ background: t.accent, color: t.id === 'light' ? '#fff' : '#09080f' }}
                    >
                      <Check className="w-3 h-3" />
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}


/** Modal for User & Admin Backup and Restore opened from the header Backup button */
function BackupCenterModal({
  open,
  onClose,
  isAdmin,
}: {
  open: boolean
  onClose: () => void
  isAdmin: boolean
}) {
  const [userMode, setUserMode] = useState<'merge' | 'replace'>('merge')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const userFileRef = useRef<HTMLInputElement | null>(null)
  const adminFileRef = useRef<HTMLInputElement | null>(null)

  if (!open) return null

  const handleDownloadUserBackup = async () => {
    setBusy(true)
    setNotice(null)
    try {
      await downloadApi('/backup', `miliconfig-user-backup-${new Date().toISOString().slice(0, 10)}.json`)
      setNotice({ ok: true, text: 'فایل بکاپ کامل اطلاعات شما دانلود شد.' })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : 'خطا در دانلود بکاپ' })
    } finally {
      setBusy(false)
    }
  }

  const handleRestoreUserBackup = async () => {
    const file = userFileRef.current?.files?.[0]
    if (!file) {
      setNotice({ ok: false, text: 'لطفاً ابتدا فایل JSON بکاپ خود را انتخاب کنید.' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const raw = await file.text()
      const parsed = JSON.parse(raw)
      const res = await api<{
        tokens_added?: number
        deployments_added?: number
        members_added?: number
        groups_added?: number
        injectors_added?: number
      }>('/backup', {
        method: 'POST',
        body: { ...parsed, mode: userMode },
      })
      setNotice({
        ok: true,
        text: `بازیابی انجام شد: ${res.deployments_added ?? 0} ورکر، ${res.tokens_added ?? 0} توکن، ${res.members_added ?? 0} کاربر ورکر و ${res.groups_added ?? 0} گروه ساب بازیابی شدند.`,
      })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : 'خطا در بازیابی فایل بکاپ' })
    } finally {
      setBusy(false)
    }
  }

  const handleDownloadAdminBackup = async () => {
    setBusy(true)
    setNotice(null)
    try {
      await downloadApi('/admin/backup', `miliconfig-admin-full-backup-${new Date().toISOString().slice(0, 10)}.json`)
      setNotice({ ok: true, text: 'بکاپ جامع کل سیستم و تمام کاربران (ویژه ادمین) دانلود شد.' })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : 'خطا در دانلود بکاپ ادمین' })
    } finally {
      setBusy(false)
    }
  }

  const handleRestoreAdminBackup = async () => {
    const file = adminFileRef.current?.files?.[0]
    if (!file) {
      setNotice({ ok: false, text: 'لطفاً ابتدا فایل JSON بکاپ جامع ادمین را انتخاب کنید.' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const raw = await file.text()
      const parsed = JSON.parse(raw)
      const res = await api<{ message?: string }>('/admin/backup', {
        method: 'POST',
        body: parsed,
      })
      setNotice({
        ok: true,
        text: res.message || 'بکاپ جامع ادمین با موفقیت در دیتابیس بازیابی شد.',
      })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : 'خطا در بازیابی بکاپ ادمین' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/75 backdrop-blur-md animate-fade-in" onClick={onClose}>
      <div
        className="glass-card w-full max-w-xl p-4 sm:p-6 max-h-[86vh] overflow-y-auto space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: 'var(--t-line)' }}>
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-2xl flex items-center justify-center"
              style={{ background: 'rgba(var(--t-accent-rgb), 0.14)', color: 'var(--t-accent)' }}
            >
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-white">مرکز بکاپ و بازیابی اطلاعات</h2>
              <p className="text-[11px] text-slate-400">پشتیبان‌گیری و بازیابی آنی برای کاربران و ادمین</p>
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost p-2" title="بستن">
            <X className="w-4 h-4" />
          </button>
        </div>

        {notice && (
          <div
            className={`p-3 rounded-xl text-xs font-bold border ${
              notice.ok
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : 'bg-error-500/15 border-error-500/40 text-error-300'
            }`}
          >
            {notice.text}
          </div>
        )}

        {/* 1. User Backup & Restore */}
        <div className="p-3.5 sm:p-4 rounded-2xl border space-y-3" style={{ background: 'var(--t-surface)', borderColor: 'var(--t-line)' }}>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <h3 className="text-xs sm:text-sm font-bold text-white">۱. بکاپ کامل اطلاعات من (ویژه کاربر)</h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                شامل تمام ورکرها و پنل‌های مستقرشده، لینک‌های ساب، توکن‌های کلادفلر، کاربران ورکر، گروه‌های ساب و تزریق‌کننده‌ها
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={handleDownloadUserBackup}
              className="btn-primary flex items-center gap-1.5 text-xs py-2 px-3.5"
            >
              <Download className="w-3.5 h-3.5" />
              دانلود بکاپ من (JSON)
            </button>
          </div>

          <div className="pt-2 border-t space-y-2.5" style={{ borderColor: 'var(--t-line)' }}>
            <p className="text-[11px] font-bold text-slate-300">بازیابی اطلاعات من از فایل بکاپ:</p>
            <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
              <input
                ref={userFileRef}
                type="file"
                accept=".json,application/json"
                className="input-field text-xs py-1.5 flex-1"
              />
              <select
                value={userMode}
                onChange={(e) => setUserMode(e.target.value as 'merge' | 'replace')}
                className="input-field text-xs py-1.5 sm:w-44"
              >
                <option value="merge">ادغام با داده‌های فعلی</option>
                <option value="replace">جایگزینی کامل</option>
              </select>
              <button
                type="button"
                disabled={busy}
                onClick={handleRestoreUserBackup}
                className="btn-secondary flex items-center justify-center gap-1.5 text-xs py-2 px-3.5 shrink-0"
              >
                <Upload className="w-3.5 h-3.5" />
                بازیابی بکاپ
              </button>
            </div>
          </div>
        </div>

        {/* 2. Full Admin Backup & Restore */}
        {isAdmin && (
          <div className="p-3.5 sm:p-4 rounded-2xl border space-y-3" style={{ background: 'rgba(var(--t-accent-rgb), 0.06)', borderColor: 'var(--t-line-strong)' }}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <h3 className="text-xs sm:text-sm font-bold text-white flex items-center gap-1.5">
                  <Shield className="w-4 h-4" style={{ color: 'var(--t-accent)' }} />
                  ۲. بکاپ جامع کل سیستم (ویژه ادمین)
                </h3>
                <p className="text-[11px] text-slate-300 mt-0.5">
                  شامل تمامی کاربران وب و ربات تلگرام، تمام ورکرها و پنل‌ها، توکن‌ها، تنظیمات ربات تلگرام و کل جداول دیتابیس D1
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={handleDownloadAdminBackup}
                className="btn-primary flex items-center gap-1.5 text-xs py-2 px-3.5"
              >
                <Download className="w-3.5 h-3.5" />
                دانلود بکاپ کامل ادمین (JSON)
              </button>
            </div>

            <div className="pt-2 border-t space-y-2.5" style={{ borderColor: 'var(--t-line)' }}>
              <p className="text-[11px] font-bold text-slate-300">بازیابی کل دیتابیس از فایل بکاپ جامع ادمین:</p>
              <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                <input
                  ref={adminFileRef}
                  type="file"
                  accept=".json,application/json"
                  className="input-field text-xs py-1.5 flex-1"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleRestoreAdminBackup}
                  className="btn-secondary flex items-center justify-center gap-1.5 text-xs py-2 px-3.5 shrink-0"
                >
                  <Upload className="w-3.5 h-3.5" />
                  بازیابی کل سیستم
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TopStrip({
  onOpenTheme,
  onOpenBackup,
  bgFx,
  onToggleBgFx,
  activeThemeName,
}: {
  onOpenTheme: () => void
  onOpenBackup: () => void
  bgFx: boolean
  onToggleBgFx: () => void
  activeThemeName: string
}) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const time = now.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const date = now.toLocaleDateString('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <div
      className="hidden lg:flex items-center justify-between gap-4 px-8 py-3.5 border-b backdrop-blur-xl sticky top-0 z-20"
      style={{ background: 'var(--t-card)', borderColor: 'var(--t-line)' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="eyebrow">REAL-TIME NETWORK CONTROL</span>
        <span className="hairline w-16 xl:w-28" />
        <LiveChip />
        <span className="chip">سیستم آنلاین است</span>
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        <button
          type="button"
          onClick={onOpenBackup}
          className="chip-live hover:opacity-90 transition-opacity cursor-pointer"
          title="بکاپ و بازیابی اطلاعات"
        >
          <Database className="w-3.5 h-3.5" />
          <span>بکاپ و بازیابی</span>
        </button>
        <button
          type="button"
          onClick={onToggleBgFx}
          className="chip hover:opacity-90 transition-opacity cursor-pointer"
          title="خاموش یا روشن کردن افکت پس‌زمینه"
        >
          <Sparkles className="w-3.5 h-3.5" style={{ color: bgFx ? 'var(--t-accent)' : 'var(--t-muted)' }} />
          <span>افکت: {bgFx ? 'روشن' : 'خاموش'}</span>
        </button>
        <button
          type="button"
          onClick={onOpenTheme}
          className="chip-live hover:opacity-90 transition-opacity cursor-pointer"
          title="تغییر قالب و تم برنامه"
        >
          <Palette className="w-3.5 h-3.5" />
          <span>قالب: {activeThemeName}</span>
        </button>
        <span className="font-mono text-sm text-slate-200 tabular-nums ms-2" dir="ltr">{time}</span>
        <span className="text-xs text-slate-500">{date}</span>
      </div>
    </div>
  )
}

export default function Layout() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [themeModalOpen, setThemeModalOpen] = useState(false)
  const [backupModalOpen, setBackupModalOpen] = useState(false)
  const [themeId, setThemeId] = useState<string>(() => {
    try {
      return localStorage.getItem('mili_app_theme') || 'zedsecure'
    } catch {
      return 'zedsecure'
    }
  })
  const [bgFx, setBgFx] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('mili_app_bgfx')
      return saved === null ? true : saved === '1'
    } catch {
      return true
    }
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeId)
    try {
      localStorage.setItem('mili_app_theme', themeId)
    } catch { /* ignore */ }
  }, [themeId])

  const handleToggleBgFx = () => {
    setBgFx((prev) => {
      const next = !prev
      try {
        localStorage.setItem('mili_app_bgfx', next ? '1' : '0')
      } catch { /* ignore */ }
      return next
    })
  }

  const activeTheme = THEME_PRESETS.find((t) => t.id === themeId) ?? THEME_PRESETS[0]

  const visibleNav = baseNavItems.filter((item) => user?.is_owner || (item.to !== '/bot-config' && item.to !== '/bot-users'))
  const navItems = user?.role === 'admin' ? [...visibleNav, ...adminNavItems] : visibleNav

  const handleSignOut = async () => {
    await signOut()
    navigate('/auth')
  }

  return (
    <LiveGuide>
      <OnboardingModals />
      <CustomCursor />
      <ThemeStudioModal
        open={themeModalOpen}
        onClose={() => setThemeModalOpen(false)}
        themeId={themeId}
        onSelectTheme={(id) => setThemeId(id)}
        bgFx={bgFx}
        onToggleBgFx={handleToggleBgFx}
      />
      <BackupCenterModal
        open={backupModalOpen}
        onClose={() => setBackupModalOpen(false)}
        isAdmin={user?.role === 'admin' || !!user?.is_owner}
      />
      <div className="min-h-screen bg-grid relative">
        <div className="fixed inset-0 bg-radial-glow pointer-events-none" />
        <ThemeBackgroundFx enabled={bgFx} themeId={themeId} />

        {/* Mobile header */}
        <div
          className="lg:hidden fixed top-0 left-0 right-0 z-40 backdrop-blur-xl border-b px-4 py-3 flex items-center justify-between"
          style={{ background: 'var(--t-card)', borderColor: 'var(--t-line)' }}
        >
          <div className="flex items-center gap-2.5">
            <BrandMark size="sm" />
            <div className="leading-tight">
              <span className="block font-bold text-white text-sm">miliconfig</span>
              <span className="eyebrow-muted">CONTROL CENTER</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setBackupModalOpen(true)}
              className="p-2 rounded-xl border text-slate-300"
              style={{ background: 'rgba(var(--t-accent-rgb), 0.14)', borderColor: 'var(--t-line-strong)', color: 'var(--t-accent)' }}
              title="بکاپ و بازیابی اطلاعات"
            >
              <Database className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleToggleBgFx}
              className="p-2 rounded-xl border text-slate-300"
              style={{ background: 'rgba(var(--t-accent-rgb), 0.08)', borderColor: 'var(--t-line)' }}
              title="افکت پس‌زمینه"
            >
              <Sparkles className="w-4 h-4" style={{ color: bgFx ? 'var(--t-accent)' : 'var(--t-muted)' }} />
            </button>
            <button
              type="button"
              onClick={() => setThemeModalOpen(true)}
              className="p-2 rounded-xl border text-slate-300"
              style={{ background: 'rgba(var(--t-accent-rgb), 0.12)', borderColor: 'var(--t-line-strong)', color: 'var(--t-accent)' }}
              title="قالب‌ها و تم"
            >
              <Palette className="w-4 h-4" />
            </button>
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 rounded-xl border text-slate-300"
              style={{ background: 'rgba(255,255,255,0.04)', borderColor: 'var(--t-line)' }}
            >
              {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Sidebar / rail */}
        <aside className={`fixed top-0 right-0 bottom-0 w-72 z-30 transition-transform duration-300 lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : 'translate-x-full'}`}>
          <div
            className="h-full backdrop-blur-xl border-l flex flex-col"
            style={{ background: 'var(--t-card)', borderColor: 'var(--t-line)' }}
          >
            {/* Logo */}
            <div className="p-5 border-b" style={{ borderColor: 'var(--t-line)' }}>
              <div className="flex items-center gap-3">
                <BrandMark />
                <div className="min-w-0">
                  <h1 className="text-lg font-bold text-white leading-tight">miliconfig</h1>
                  <p className="eyebrow">CONTROL CENTER</p>
                </div>
                <div className="ms-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setBackupModalOpen(true)}
                    className="chip cursor-pointer"
                    title="بکاپ و بازیابی"
                  >
                    <Database className="w-3.5 h-3.5" style={{ color: 'var(--t-accent)' }} />
                    بکاپ
                  </button>
                  <button
                    type="button"
                    onClick={() => setThemeModalOpen(true)}
                    className="chip-live cursor-pointer"
                    title="انتخاب قالب آماده"
                  >
                    <Palette className="w-3.5 h-3.5" />
                    تم
                  </button>
                </div>
              </div>
            </div>

            {/* Nav — numbered control rail */}
            <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
              {navItems.map((item, i) => {
                const Icon = item.icon
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    data-guide={item.guide}
                    onClick={() => setSidebarOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2.5 rounded-2xl transition-all duration-200 group border ${
                        isActive
                          ? 'text-white shadow-sm'
                          : 'border-transparent text-slate-400 hover:text-white hover:bg-white/[0.04]'
                      }`
                    }
                    style={({ isActive }) =>
                      isActive
                        ? {
                            background: 'rgba(var(--t-accent-rgb), 0.13)',
                            borderColor: 'var(--t-line-strong)',
                            color: 'var(--t-accent)',
                          }
                        : undefined
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          className="font-mono text-[10px] w-5 shrink-0"
                          style={{ color: isActive ? 'var(--t-accent)' : 'var(--t-muted)' }}
                        >
                          {faIndex(i)}
                        </span>
                        <Icon className="w-[18px] h-[18px] shrink-0" style={isActive ? { color: 'var(--t-accent)' } : undefined} />
                        <span className="font-medium text-sm truncate">{item.label}</span>
                        <ChevronLeft className={`w-4 h-4 ms-auto shrink-0 transition-opacity ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'}`} />
                      </>
                    )}
                  </NavLink>
                )
              })}
            </nav>

            {/* Account */}
            <div className="p-4 border-t" style={{ borderColor: 'var(--t-line)' }}>
              <div className="flex items-center gap-3 mb-3 px-2">
                <div
                  className="w-9 h-9 rounded-xl border flex items-center justify-center font-bold text-sm"
                  style={{
                    background: 'rgba(var(--t-accent-rgb), 0.12)',
                    borderColor: 'var(--t-line-strong)',
                    color: 'var(--t-accent)',
                  }}
                >
                  {user?.email?.[0]?.toUpperCase() ?? 'U'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white font-medium truncate">{user?.email}</p>
                  <p className="eyebrow-muted">{user?.role === 'admin' ? 'ADMIN' : 'ACCOUNT'}</p>
                </div>
              </div>
              <button
                onClick={handleSignOut}
                data-guide="signout"
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-2xl bg-white/[0.03] border text-slate-300 hover:border-error-500/40 hover:text-error-400 transition-all duration-200 text-sm font-medium"
                style={{ borderColor: 'var(--t-line)' }}
              >
                <LogOut className="w-4 h-4" />
                خروج از حساب
              </button>
            </div>
          </div>
        </aside>

        {/* Mobile overlay */}
        {sidebarOpen && <div className="lg:hidden fixed inset-0 bg-black/60 z-20" onClick={() => setSidebarOpen(false)} />}

        {/* Main content */}
        <main className="lg:mr-72 min-h-screen pt-16 lg:pt-0 relative z-10">
          <TopStrip
            onOpenTheme={() => setThemeModalOpen(true)}
            onOpenBackup={() => setBackupModalOpen(true)}
            bgFx={bgFx}
            onToggleBgFx={handleToggleBgFx}
            activeThemeName={activeTheme.name}
          />
          <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto animate-fade-in">
            <Outlet />
          </div>
        </main>
      </div>
    </LiveGuide>
  )
}
