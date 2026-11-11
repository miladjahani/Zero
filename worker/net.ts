import { connect } from 'cloudflare:sockets'

// ── Real TCP probing (Workers Sockets API) ─────────────────────────────────

/** Open a raw TCP connection and measure handshake latency. Returns null on failure. */
export async function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<number | null> {
  let socket: ReturnType<typeof connect> | null = null
  const t0 = Date.now()
  try {
    socket = connect(`${host}:${port}`, { secureTransport: 'off' })
    // Race instead of relying on close() rejecting `opened` — on some runtimes
    // the promise stays pending forever after the socket is force-closed.
    const latency = await Promise.race([
      socket.opened.then(() => Date.now() - t0 as number),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])
    return latency
  } catch {
    return null
  } finally {
    try { socket?.close() } catch { /* already closed */ }
  }
}

/** Probe [host:port] pairs with bounded concurrency; keeps order of inputs. */
export async function probeBatch<T extends { host: string; port: number }>(
  targets: T[],
  concurrency = 10,
  timeoutMs = 3000,
): Promise<Array<T & { latencyMs: number | null }>> {
  const len = targets.length
  const latencies = new Array<number | null>(len)
  let index = 0
  
  async function worker(): Promise<void> {
    while (index < len) {
      const i = index++
      const target = targets[i]!
      latencies[i] = await tcpProbe(target.host, target.port, timeoutMs)
    }
  }
  
  const workers: Promise<void>[] = []
  for (let i = 0, n = Math.min(concurrency, len); i < n; i++) {
    workers.push(worker())
  }
  await Promise.all(workers)
  
  // Reuse input array structure for compatibility
  return targets.map((t, i) => ({ ...t, latencyMs: latencies[i]! }))
}

/** Expand simple CIDRv4 ranges (e.g. 1.1.1.0/24) into individual IPs, capped. */
export function expandRanges(ranges: string[], cap = 512): string[] {
  const ips: string[] = []
  for (const range of ranges) {
    const [base, bitsRaw] = range.trim().split('/')
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(base)) continue
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw)
    if (!Number.isInteger(bits) || bits < 16 || bits > 32) continue
    const octets = base.split('.').map(Number)
    const baseInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
    const size = 2 ** (32 - bits)
    const start = baseInt & (size === 4294967296 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0)
    for (let i = 0; i < size && ips.length < cap; i++) {
      const v = (start + i) >>> 0
      ips.push(`${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`)
    }
    if (ips.length >= cap) break
  }
  return ips
}

// ── Base64 helpers ──────────────────────────────────────────────────────────

export function b64encodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function tryDecodeSub(text: string): string {
  const trimmed = text.trim()
  if (trimmed.includes('://')) return trimmed
  try {
    const bin = atob(trimmed.replace(/\s+/g, ''))
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const decoded = new TextDecoder().decode(bytes)
    return decoded.includes('://') ? decoded : trimmed
  } catch {
    return trimmed
  }
}
