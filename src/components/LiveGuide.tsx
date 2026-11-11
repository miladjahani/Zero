import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Lightbulb, X, RotateCcw } from 'lucide-react'
import { GUIDE_TEXTS } from '../lib/guideTexts'

// ── Live guide: first-click coach-marks ────────────────────────────────────
// Any element with a `data-guide="key"` attribute explains itself the FIRST
// time the user clicks it: the click is intercepted (capture phase, before
// React handlers), a floating popover describes exactly what it does, and the
// explanation never repeats. Users can turn the guide off entirely or reset
// it from the floating control.

const LS_SEEN = 'miliconfig-guide-seen'
const LS_ENABLED = 'miliconfig-guide-enabled'

interface Tip { key: string; title: string; text: string; x: number; y: number; above: boolean }

interface LiveGuideCtx {
  enabled: boolean
  toggle: () => void
  reset: () => void
  seenCount: number
}

const Ctx = createContext<LiveGuideCtx>({ enabled: true, toggle: () => {}, reset: () => {}, seenCount: 0 })
export const useLiveGuide = () => useContext(Ctx)

function loadSeen(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_SEEN) ?? '[]') as string[] } catch { return [] }
}

export default function LiveGuide({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem(LS_ENABLED) !== 'off')
  const [seenCount, setSeenCount] = useState(() => loadSeen().length)
  const [tip, setTip] = useState<Tip | null>(null)

  // Global capture-phase click interceptor.
  useEffect(() => {
    if (!enabled) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Element | null
      const el = target?.closest?.('[data-guide]') as HTMLElement | null
      if (!el) return
      const key = el.getAttribute('data-guide')
      if (!key) return
      const info = GUIDE_TEXTS[key]
      if (!info) return
      if (loadSeen().includes(key)) return

      // Stop the actual action until the user has read the explanation.
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()

      try {
        const next = [...loadSeen(), key]
        localStorage.setItem(LS_SEEN, JSON.stringify(next))
        setSeenCount(next.length)
      } catch { /* storage unavailable — still show the tip */ }

      const r = el.getBoundingClientRect()
      const spaceBelow = window.innerHeight - r.bottom
      setTip({
        key, title: info.title, text: info.text,
        x: Math.min(Math.max(12, r.left + r.width / 2), window.innerWidth - 12),
        y: spaceBelow > 150 ? r.bottom + 10 : r.top - 10,
        above: spaceBelow <= 150,
      })
    }
    document.addEventListener('click', handler, true)
    return () => document.removeEventListener('click', handler, true)
  }, [enabled])

  // Reposition on scroll/resize so the tip follows its element.
  useEffect(() => {
    if (!tip) return
    const move = () => setTip(null)
    window.addEventListener('scroll', move, true)
    return () => window.removeEventListener('scroll', move, true)
  }, [tip])

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev
      try { localStorage.setItem(LS_ENABLED, next ? 'on' : 'off') } catch { /* ignore */ }
      return next
    })
    setTip(null)
  }, [])

  const reset = useCallback(() => {
    try { localStorage.removeItem(LS_SEEN) } catch { /* ignore */ }
    setSeenCount(0)
    setTip(null)
  }, [])

  return (
    <Ctx.Provider value={{ enabled, toggle, reset, seenCount }}>
      {children}
      {tip && (
        <>
          {/* dim backdrop — click anywhere dismisses */}
          <div className="fixed inset-0 z-[90]" onClick={() => setTip(null)} />
          <div
            className="fixed z-[91] w-[min(340px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl border backdrop-blur-xl shadow-2xl p-4 animate-fade-in"
            style={{
              left: tip.x,
              top: tip.y,
              transform: 'translateX(-50%)',
              background: 'var(--t-bg2)',
              borderColor: 'var(--t-line-strong)',
              boxShadow: '0 20px 50px -12px rgba(var(--t-accent-rgb), 0.3)',
            }}
            dir="rtl"
          >
            <div className="flex items-start gap-2.5">
              <div
                className="w-8 h-8 shrink-0 rounded-xl border flex items-center justify-center"
                style={{
                  background: 'rgba(var(--t-accent-rgb), 0.16)',
                  borderColor: 'var(--t-line-strong)',
                }}
              >
                <Lightbulb className="w-4 h-4" style={{ color: 'var(--t-accent)' }} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold" style={{ color: 'var(--t-text)' }}>{tip.title}</p>
                <p className="text-xs leading-5 mt-1 font-medium" style={{ color: 'var(--t-muted)' }}>{tip.text}</p>
              </div>
              <button
                onClick={() => setTip(null)}
                className="p-1 rounded-lg hover:opacity-80 shrink-0"
                style={{ color: 'var(--t-muted)' }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center justify-between mt-3">
              <span className="text-[10px]" style={{ color: 'var(--t-muted)' }}>این راهنما دیگر تکرار نمی‌شود</span>
              <button
                onClick={() => setTip(null)}
                className="px-3.5 py-1.5 rounded-xl border text-xs font-bold transition-all"
                style={{
                  background: 'rgba(var(--t-accent-rgb), 0.18)',
                  borderColor: 'var(--t-line-strong)',
                  color: 'var(--t-accent)',
                }}
              >
                فهمیدم
              </button>
            </div>
            <div
              className={`absolute left-1/2 -translate-x-1/2 w-3 h-3 rotate-45 ${tip.above ? 'bottom-[-6px] border-b border-r' : 'top-[-6px] border-t border-l'}`}
              style={{
                background: 'var(--t-bg2)',
                borderColor: 'var(--t-line-strong)',
              }}
            />
          </div>
        </>
      )}
      {/* Floating control — fully reactive to active theme */}
      <div className="fixed bottom-4 left-4 z-[80] flex items-center gap-1.5">
        <button
          onClick={toggle}
          title={enabled ? 'خاموش کردن راهنمای زنده' : 'روشن کردن راهنمای زنده'}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-bold border backdrop-blur-xl shadow-lg transition-all"
          style={
            enabled
              ? {
                  background: 'rgba(var(--t-accent-rgb), 0.18)',
                  borderColor: 'var(--t-line-strong)',
                  color: 'var(--t-accent)',
                  boxShadow: '0 8px 24px -8px rgba(var(--t-accent-rgb), 0.45)',
                }
              : {
                  background: 'var(--t-card)',
                  borderColor: 'var(--t-line)',
                  color: 'var(--t-muted)',
                }
          }
        >
          <Lightbulb className="w-3.5 h-3.5" style={{ color: enabled ? 'var(--t-accent)' : 'var(--t-muted)' }} />
          راهنمای زنده {enabled ? 'روشن' : 'خاموش'}
        </button>
        {seenCount > 0 && (
          <button
            onClick={reset}
            title="تکرار همهٔ راهنماها از ابتدا"
            className="p-2 rounded-full border backdrop-blur-xl shadow-lg transition-all hover:scale-105"
            style={{
              background: 'var(--t-card)',
              borderColor: 'var(--t-line-strong)',
              color: 'var(--t-accent)',
            }}
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </Ctx.Provider>
  )
}
