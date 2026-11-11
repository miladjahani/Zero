/**
 * Dynamic, theme-reactive design tokens for miliconfigpro.
 *
 * Every `brand-*`, `slate-*`, and secondary accent utility class resolves
 * through CSS RGB channel variables (`--c-brand-*`, `--c-acc2-*`, `--c-slate-*`)
 * declared per `[data-theme="..."]` in `src/index.css`. Switching themes
 * re-skins 100% of the app (including LiveGuide, modals, badges, and borders)
 * with high-contrast text legibility.
 */
const brandScale = {
  50: 'rgb(var(--c-brand-50) / <alpha-value>)',
  100: 'rgb(var(--c-brand-100) / <alpha-value>)',
  200: 'rgb(var(--c-brand-200) / <alpha-value>)',
  300: 'rgb(var(--c-brand-300) / <alpha-value>)',
  400: 'rgb(var(--c-brand-400) / <alpha-value>)',
  500: 'rgb(var(--c-brand-500) / <alpha-value>)',
  600: 'rgb(var(--c-brand-600) / <alpha-value>)',
  700: 'rgb(var(--c-brand-700) / <alpha-value>)',
  800: 'rgb(var(--c-brand-800) / <alpha-value>)',
  900: 'rgb(var(--c-brand-900) / <alpha-value>)',
}

const secondaryScale = {
  200: 'rgb(var(--c-acc2-200) / <alpha-value>)',
  300: 'rgb(var(--c-acc2-300) / <alpha-value>)',
  400: 'rgb(var(--c-acc2-400) / <alpha-value>)',
  500: 'rgb(var(--c-acc2-500) / <alpha-value>)',
  600: 'rgb(var(--c-acc2-600) / <alpha-value>)',
  700: 'rgb(var(--c-acc2-700) / <alpha-value>)',
}

const surfaceScale = {
  50: 'rgb(var(--c-slate-50) / <alpha-value>)',
  100: 'rgb(var(--c-slate-100) / <alpha-value>)',
  200: 'rgb(var(--c-slate-200) / <alpha-value>)',
  300: 'rgb(var(--c-slate-300) / <alpha-value>)',
  400: 'rgb(var(--c-slate-400) / <alpha-value>)',
  500: 'rgb(var(--c-slate-500) / <alpha-value>)',
  600: 'rgb(var(--c-slate-600) / <alpha-value>)',
  700: 'rgb(var(--c-slate-700) / <alpha-value>)',
  800: 'rgb(var(--c-slate-800) / <alpha-value>)',
  900: 'rgb(var(--c-slate-900) / <alpha-value>)',
  950: 'rgb(var(--c-slate-950) / <alpha-value>)',
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: brandScale,
        lime: brandScale,
        green: {
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
        },
        emerald: {
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399',
          500: '#10b981',
          600: '#059669',
        },
        blue: secondaryScale,
        sky: secondaryScale,
        cyan: secondaryScale,
        teal: secondaryScale,
        indigo: brandScale,
        violet: brandScale,
        purple: secondaryScale,
        slate: surfaceScale,
        error: {
          300: '#fda4af',
          400: '#fb7185',
          500: '#f43f5e',
        },
        warning: {
          300: '#fde047',
          400: '#facc15',
          500: '#eab308',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        '4xl': '1.75rem',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(-12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-14px)' },
        },
        shimmer: {
          from: { backgroundPosition: '200% 0' },
          to: { backgroundPosition: '-200% 0' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 18px rgba(var(--t-accent-rgb), 0.25)' },
          '50%': { boxShadow: '0 0 34px rgba(var(--t-accent-rgb), 0.5)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.85)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out both',
        'slide-up': 'slide-up 0.4s ease-out both',
        'slide-in': 'slide-in 0.3s ease-out both',
        float: 'float 6s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2.4s ease-in-out infinite',
        'pulse-dot': 'pulse-dot 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
