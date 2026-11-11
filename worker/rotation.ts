// Deterministic IP rotation + health-checked fallback pools.
//
// • rotate(): reorders the IP list by the current time-bucket so the entry
//   address changes automatically every N minutes — no cron needed, clients
//   pick up the new order on their next subscription refresh.
// • filterAlive(): TCP-probes the pool and drops dead IPs, keeping the
//   fastest ones. Results are cached briefly so sub fetches stay fast.

import { tcpProbe } from './net'

/** Rotate a list deterministically every `minutes` (0 or falsy = no rotation). */
export function rotate<T>(items: T[], minutes: number | undefined | null): T[] {
  if (!minutes || minutes <= 0 || items.length <= 1) return items
  const bucket = Math.floor(Date.now() / (minutes * 60_000))
  const offset = bucket % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

export interface AliveIp {
  ip: string
  port?: number
  ms: number
}

const probeCache = new Map<string, { alive: boolean; ms: number; ts: number }>()
const PROBE_TTL = 5 * 60_000

/**
 * Probe up to `cap` IPs concurrently and return the alive ones sorted by
 * latency (fastest first). Cached for 5 minutes to keep sub fetches snappy.
 */
export async function filterAlive(
  ips: { ip: string; port?: number }[],
  cap = 12,
): Promise<AliveIp[]> {
  const targets = ips.slice(0, cap)
  const results: (AliveIp | null)[] = await Promise.all(
    targets.map(async ({ ip, port }) => {
      const key = `${ip}:${port ?? 443}`
      const hit = probeCache.get(key)
      if (hit && Date.now() - hit.ts < PROBE_TTL) {
        return hit.alive ? { ip, port, ms: hit.ms } : null
      }
      const ms = await tcpProbe(ip, port ?? 443, 1500).catch(() => null)
      probeCache.set(key, { alive: ms !== null, ms: ms ?? -1, ts: Date.now() })
      return ms !== null ? { ip, port, ms } : null
    }),
  )
  return results
    .filter((r): r is AliveIp => r !== null)
    .sort((a, b) => a.ms - b.ms)
}
