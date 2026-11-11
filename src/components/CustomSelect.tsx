import React, { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check, Search, X } from 'lucide-react'

export interface CustomSelectProps {
  value?: string | number
  onChange?: (e: { target: { value: string }; currentTarget: { value: string } }) => void
  className?: string
  dir?: 'rtl' | 'ltr' | 'auto'
  disabled?: boolean
  title?: string
  placeholder?: string
  children?: React.ReactNode
}

interface ParsedOption {
  value: string
  label: string
  disabled?: boolean
}

function extractText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (React.isValidElement(node)) {
    return extractText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

function collectOptions(children: React.ReactNode, out: ParsedOption[] = []): ParsedOption[] {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return
    const type = child.type
    const props = child.props as { value?: string | number; disabled?: boolean; children?: React.ReactNode }
    if (type === 'option') {
      const val = props.value !== undefined ? String(props.value) : extractText(props.children)
      const label = extractText(props.children).trim() || val
      out.push({ value: val, label, disabled: !!props.disabled })
    } else if (props?.children) {
      collectOptions(props.children, out)
    }
  })
  return out
}

export default function CustomSelect({
  value,
  onChange,
  className = '',
  dir,
  disabled = false,
  title,
  placeholder = 'انتخاب کنید...',
  children,
}: CustomSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [rect, setRect] = useState<{ top: number; left: number; width: number; bottomSpace: number } | null>(null)
  const [isMobile, setIsMobile] = useState(false)

  const options = useMemo(() => collectOptions(children), [children])
  const strValue = value !== undefined && value !== null ? String(value) : (options[0]?.value ?? '')
  const selectedOption = options.find((o) => o.value === strValue) ?? options[0]

  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
  }, [options, search])

  const updatePosition = () => {
    if (!triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    setIsMobile(window.innerWidth < 640)
    setRect({
      top: r.bottom + 6,
      left: r.left,
      width: Math.max(r.width, 240),
      bottomSpace: window.innerHeight - r.bottom,
    })
  }

  useEffect(() => {
    if (!open) {
      setSearch('')
      return
    }
    updatePosition()
    const onResize = () => updatePosition()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const handleSelect = (val: string) => {
    if (disabled) return
    onChange?.({ target: { value: val }, currentTarget: { value: val } })
    setOpen(false)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        dir={dir}
        onClick={() => !disabled && setOpen((p) => !p)}
        className={`flex items-center justify-between gap-2 text-right select-none cursor-pointer transition-all ${className}`}
        style={{
          borderColor: open ? 'var(--t-accent)' : undefined,
          boxShadow: open ? '0 0 0 3px rgba(var(--t-accent-rgb), 0.16)' : undefined,
        }}
      >
        <span className="truncate flex-1 font-medium" style={{ color: 'var(--t-text)' }}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown
          className={`w-4 h-4 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          style={{ color: 'var(--t-accent)' }}
        />
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-[9990] flex items-end sm:items-start justify-center" dir={dir ?? 'rtl'}>
            {/* Backdrop */}
            <div
              className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-fade-in"
              onClick={() => setOpen(false)}
            />

            {/* Dropdown / Sheet Panel */}
            <div
              className={`relative z-[9991] overflow-hidden border shadow-2xl animate-slide-up ${
                isMobile ? 'w-full max-w-lg rounded-t-3xl p-4 pb-6 max-h-[78vh] flex flex-col' : 'rounded-2xl p-2 flex flex-col max-h-[360px]'
              }`}
              style={{
                background: 'var(--t-bg2)',
                borderColor: 'var(--t-line-strong)',
                color: 'var(--t-text)',
                ...(isMobile
                  ? {}
                  : {
                      position: 'fixed',
                      top: rect
                        ? rect.bottomSpace < 260
                          ? Math.max(12, rect.top - 320)
                          : rect.top
                        : 100,
                      left: rect ? Math.min(Math.max(12, rect.left), window.innerWidth - rect.width - 12) : 100,
                      width: rect ? Math.min(rect.width, window.innerWidth - 24) : 320,
                    }),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Mobile header handle */}
              {isMobile && (
                <div className="flex items-center justify-between pb-3 mb-2 border-b" style={{ borderColor: 'var(--t-line)' }}>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: 'var(--t-accent)' }} />
                    <span className="text-sm font-bold" style={{ color: 'var(--t-text)' }}>
                      {title || 'انتخاب از فهرست'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="p-1.5 rounded-xl hover:bg-white/10 transition-colors"
                    style={{ color: 'var(--t-muted)' }}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Search box when options > 5 */}
              {options.length > 5 && (
                <div className="relative mb-2 shrink-0">
                  <Search className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--t-muted)' }} />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="جستجو در گزینه‌ها..."
                    className="input-field py-2 pr-9 pl-3 text-xs"
                  />
                </div>
              )}

              {/* Options list */}
              <div className="overflow-y-auto space-y-1 pr-0.5 flex-1">
                {filteredOptions.length === 0 ? (
                  <p className="text-xs text-center py-6" style={{ color: 'var(--t-muted)' }}>
                    موردی یافت نشد
                  </p>
                ) : (
                  filteredOptions.map((opt) => {
                    const active = opt.value === strValue
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={opt.disabled}
                        onClick={() => handleSelect(opt.value)}
                        className={`w-full flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl text-right text-xs sm:text-sm transition-all ${
                          opt.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
                        }`}
                        style={{
                          background: active ? 'rgba(var(--t-accent-rgb), 0.16)' : 'transparent',
                          border: active ? '1px solid var(--t-line-strong)' : '1px solid transparent',
                          color: active ? 'var(--t-accent)' : 'var(--t-text)',
                          fontWeight: active ? 700 : 500,
                        }}
                      >
                        <span className="leading-5 flex-1 break-words">{opt.label}</span>
                        <span
                          className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-all"
                          style={{
                            border: active ? '2px solid var(--t-accent)' : '1.5px solid var(--t-line-strong)',
                            background: active ? 'var(--t-accent)' : 'transparent',
                            color: active ? 'var(--t-btn-text)' : 'transparent',
                          }}
                        >
                          {active && <Check className="w-3 h-3 stroke-[3]" />}
                        </span>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
