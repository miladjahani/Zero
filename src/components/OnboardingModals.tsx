import { useEffect, useState } from 'react'
import { Rocket, KeyRound, Sparkles, Gift, ClipboardList, X, ArrowLeft } from 'lucide-react'

/**
 * Two staged welcome windows after signing in:
 *
 *   1. «مسیر استقرار» — a compact walkthrough of how to get a worker deployed
 *      (token → wizard → live link), because most sign-ups stall right there.
 *   2. Changelog — the recent updates of the panel, shown as soon as the first
 *      window is closed so the two never compete for attention.
 *
 * Both are per-session (sessionStorage): they appear on every fresh entry but
 * never twice inside the same open tab.
 */
const QUIZ_SESSION_KEY = 'mcf-onboard-seen-v9'

const CHANGELOG: { version: string; date: string; items: string[] }[] = [
  {
    version: 'v9',
    date: 'امروز',
    items: [
      'همهٔ منابع فهرست «منبع ورکر» — edgetunnel (هر دو حالت)، CFnew، NEXUS، miliconfig zeus، ZEUS PANEL، Nova Proxy، miliconfigOS و مخزن گیت‌هاب دلخواه — هم روی Cloudflare Workers و هم روی Cloudflare Pages و به انتخاب خودتان مستقر می‌شوند. هیچ منبعی دیگر خودکار از محیط انتخابی شما بیرون نمی‌رود.',
      'همان انتخاب در ربات تلگرام و در «به‌روزرسانی از مخزن» هم رعایت می‌شود؛ مسیر Workers و مسیر Pages هر دو همان بایندینگ‌های D1/KV/R2 را می‌گیرند.',
      'اگر محیط انتخابی سورس را بالا نیاورد (مثلاً error code 1101 روی Workers)، همان سورس یک‌بار خودکار روی محیط دیگر تلاش می‌شود و نتیجه در لاگ همان استقرار نوشته می‌شود — بدون تکرار بی‌پایان.',
    ],
  },
  {
    version: 'v8',
    date: 'چند روز پیش',
    items: [
      'منابع سنگین CFnew و NEXUS و پنل‌های D1 آن زمان مستقیماً روی «صفحات (Pages)» مستقر می‌شدند — از نسخهٔ v9 محیط اجرا به انتخاب کاربر برگشت.',
      'به‌روزرسانی از مخزن حالا برای استقرارهای Pages هم کار می‌کند (قبلش فقط Workers).',
      'تب جدید «آمار» برای مدیر: نمودار استقرارها، منابع، کاربران و وضعیت سلف‌چک.',
    ],
  },
  // …
]

export default function OnboardingModals() {
  const [stage, setStage] = useState<'none' | 'guide' | 'changelog'>('none')

  useEffect(() => {
    if (sessionStorage.getItem(QUIZ_SESSION_KEY)) return
    setStage('guide')
    sessionStorage.setItem(QUIZ_SESSION_KEY, '1')
  }, [])

  if (stage === 'none') return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4" dir="rtl">
      <div className="relative w-full max-w-md rounded-3xl border border-brand-400/35 bg-slate-900/95 p-6 shadow-2xl max-h-[85vh] overflow-y-auto animate-fade-in">
        <X
          className="absolute top-4 left-4 w-5 h-5 text-slate-500 hover:text-white cursor-pointer"
          onClick={() => setStage(stage === 'guide' ? 'changelog' : 'none')}
        />

        {stage === 'guide' ? (
          <>
            <div className="w-12 h-12 rounded-2xl bg-brand-500/15 border border-brand-400/40 flex items-center justify-center mb-4">
              <Rocket className="w-6 h-6 text-brand-300" />
            </div>
            <h2 className="text-xl font-bold text-white mb-1">سه قدم تا اولین استقرار</h2>
            <p className="text-xs text-slate-400 mb-5">این مسیر را در یک دقیقه طی کنید:</p>
            <ol className="space-y-3 mb-6">
              {[
                { icon: KeyRound, t: 'توکن Cloudflare را اضافه کنید', d: 'از تب «توکن‌ها» — توکن را از داشبورد کلودفلر بگیرید و بچسبانید. استقرار خودکار روی حساب خودتان ساخته می‌شود.' },
                { icon: Rocket, t: '«استقرار جدید» را باز کنید', d: 'منبع ورکر (CFnew، NEXUS، پنل‌های D1 و…) را انتخاب کنید — سورس مستقیماً روی حساب شما بالا می‌آید.' },
                { icon: Sparkles, t: 'لینک پنل و ساب را بگیرید', d: 'بعد از استقرار، لینک پنل و اشتراک فوری در تب «ورکرها و پنل» آماده است.' },
              ].map((s, i) => (
                <li key={i} className="flex gap-3 p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                  <span className="w-7 h-7 rounded-xl bg-brand-500/15 border border-brand-400/30 flex items-center justify-center shrink-0 text-brand-300 font-bold text-xs">
                    {String(i + 1).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-white flex items-center gap-2">
                      <s.icon className="w-4 h-4 text-brand-300" />{s.t}
                    </p>
                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">{s.d}</p>
                  </div>
                </li>
              ))}
            </ol>
            <button onClick={() => setStage('changelog')} className="btn-primary w-full flex items-center justify-center gap-2">
              متوجه شدم — برو قدم بعد <ArrowLeft className="w-4 h-4" />
            </button>
          </>
        ) : (
          <>
            <div className="w-12 h-12 rounded-2xl bg-brand-500/15 border border-brand-400/40 flex items-center justify-center mb-4">
              <Gift className="w-6 h-6 text-brand-300" />
            </div>
            <h2 className="text-xl font-bold text-white mb-1">تازه‌ترین آپدیت‌ها</h2>
            <p className="text-xs text-slate-400 mb-5">خلاصهٔ تغییرات اخیر پنل:</p>
            <div className="space-y-3 mb-6">
              {CHANGELOG.map((c) => (
                <div key={c.version} className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.06]">
                  <p className="text-xs font-bold text-brand-300 mb-2 flex items-center gap-2">
                    <ClipboardList className="w-4 h-4" />
                    آپدیت {c.version} · <span className="text-slate-500">{c.date}</span>
                  </p>
                  <ul className="space-y-2">
                    {c.items.map((it, i) => (
                      <li key={i} className="text-xs text-slate-300 leading-relaxed flex gap-2">
                        <span className="text-brand-400 shrink-0">◆</span>{it}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <button onClick={() => setStage('none')} className="btn-primary w-full">
              شروع کنید
            </button>
          </>
        )}
      </div>
    </div>
  )
}
