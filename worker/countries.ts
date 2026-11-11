// Country-labeled preferred IP pools for per-member subscription generation.
//
// Cloudflare's edge is anycast, so "country" here means community-maintained
// optimized ranges that resolve well from that region / ISP. Every pool can be
// overridden per member with custom IPs in the panel.

export interface CountryPool {
  code: string
  name: string
  flag: string
  ranges: string[]
  port?: number
}

export const COUNTRY_POOLS: CountryPool[] = [
  {
    code: 'us', name: 'آمریکا', flag: '🇺🇸',
    ranges: ['104.16.0.0/24', '104.17.0.0/24', '172.64.0.0/24'],
  },
  {
    code: 'de', name: 'آلمان', flag: '🇩🇪',
    ranges: ['104.18.0.0/24', '104.19.0.0/24', '172.65.0.0/24'],
  },
  {
    code: 'nl', name: 'هلند', flag: '🇳🇱',
    ranges: ['104.20.0.0/24', '104.21.0.0/24', '141.101.0.0/24'],
  },
  {
    code: 'tr', name: 'ترکیه', flag: '🇹🇷',
    ranges: ['104.22.0.0/24', '108.162.0.0/24', '162.158.0.0/24'],
  },
  {
    code: 'ae', name: 'امارات', flag: '🇦🇪',
    ranges: ['104.26.0.0/24', '104.27.0.0/24', '188.114.96.0/24'],
  },
  {
    code: 'fi', name: 'فنلاند (مولتی)', flag: '🇫🇮',
    ranges: ['188.114.97.0/24', '190.93.240.0/24'],
  },
]

const SAMPLES_PER_RANGE = 2

/** Expand a CIDR range into a bounded list of sample IPs. */
export function expandRange(cidr: string, max = SAMPLES_PER_RANGE): string[] {
  const m = cidr.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
  if (!m) return [cidr]
  const base = m[1].split('.').map(Number)
  const prefix = Number(m[2])
  if (prefix < 16 || prefix > 32 || base.some((o) => o > 255)) return [cidr]
  const baseInt = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0
  const size = 2 ** (32 - prefix)
  const out: string[] = []
  const step = Math.max(1, Math.floor(size / (max + 1)))
  for (let i = 1; i <= max && i < size - 1; i++) {
    const ipInt = (baseInt + i * step) >>> 0
    out.push([(ipInt >>> 24) & 255, (ipInt >>> 16) & 255, (ipInt >>> 8) & 255, ipInt & 255].join('.'))
  }
  return out
}

/** Resolve member countries + custom IPs into a flat preferred-IP list. */
export function resolvePool(codes: string[], customIps: string[]): { ip: string; label: string }[] {
  const out: { ip: string; label: string }[] = []
  for (const code of codes) {
    const pool = COUNTRY_POOLS.find((p) => p.code === code)
    if (!pool) continue
    for (const range of pool.ranges) {
      for (const ip of expandRange(range)) {
        out.push({ ip, label: `${pool.flag} ${pool.name}` })
      }
    }
  }
  for (const ip of customIps) {
    if (ip) out.push({ ip, label: 'custom' })
  }
  return out.slice(0, 40)
}
