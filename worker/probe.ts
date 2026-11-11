/**
 * Real edge probe engines — ported from Sop8's worker backend.
 * ---------------------------------------------------------------------------
 * 1) tcpProbe  — real TCP handshake via cloudflare:sockets.
 * 2) coloProbe — fetch() with cf.resolveOverride: TLS handshake happens
 *    against the candidate IP while SNI stays valid (speed.cloudflare.com),
 *    then the genuine cdn-cgi/trace body + CF-RAY header give the real colo.
 *    Cross-verification of both signals is the strongest proof an IP is a
 *    genuine Cloudflare edge node.
 * 3) speedTest — streaming proxy to speed.cloudflare.com/__down with
 *    resolveOverride: real bytes really flow through the candidate IP.
 * 4) portSweep — real TCP handshake against every standard CF port.
 */

import { connect } from 'cloudflare:sockets'
import type { Env } from './env'
import { json, apiError, getUserFromRequest } from './util'

export const CLOUDFLARE_PORTS = {
  tls: [443, 8443, 2053, 2083, 2087, 2096],
  nontls: [80, 8080, 8880, 2052, 2082, 2086, 2095],
}

// Compact colo → city map (the most common datacenters).
const COLO_CITY_MAP: Record<string, string> = {
  FRA: 'Frankfurt, DE', DUS: 'Dusseldorf, DE', MUC: 'Munich, DE', BER: 'Berlin, DE',
  LHR: 'London, UK', MAN: 'Manchester, UK', AMS: 'Amsterdam, NL', VIE: 'Vienna, AT',
  MXP: 'Milan, IT', FCO: 'Rome, IT', CDG: 'Paris, FR', MRS: 'Marseille, FR',
  MAD: 'Madrid, ES', BCN: 'Barcelona, ES', LIS: 'Lisbon, PT', WAW: 'Warsaw, PL',
  PRG: 'Prague, CZ', BUD: 'Budapest, HU', OTP: 'Bucharest, RO', SOF: 'Sofia, BG',
  ATH: 'Athens, GR', IST: 'Istanbul, TR', DXB: 'Dubai, AE', DOH: 'Doha, QA',
  KWI: 'Kuwait City, KW', RUH: 'Riyadh, SA', JED: 'Jeddah, SA', TLV: 'Tel Aviv, IL',
  CAI: 'Cairo, EG', JNB: 'Johannesburg, ZA', LOS: 'Lagos, NG', NBO: 'Nairobi, KE',
  SIN: 'Singapore, SG', HKG: 'Hong Kong, HK', NRT: 'Tokyo, JP', KIX: 'Osaka, JP',
  ICN: 'Seoul, KR', TPE: 'Taipei, TW', BKK: 'Bangkok, TH', KUL: 'Kuala Lumpur, MY',
  CGK: 'Jakarta, ID', MNL: 'Manila, PH', DEL: 'Delhi, IN', BOM: 'Mumbai, IN',
  MAA: 'Chennai, IN', BLR: 'Bangalore, IN', HYD: 'Hyderabad, IN', BOM2: 'Mumbai, IN',
  CMB: 'Colombo, LK', KHI: 'Karachi, PK', LHE: 'Lahore, PK', ISB: 'Islamabad, PK',
  TAS: 'Tashkent, UZ', ALA: 'Almaty, KZ', GYD: 'Baku, AZ', TBS: 'Tbilisi, GE',
  EWR: 'Newark, US', JFK: 'New York, US', IAD: 'Washington, US', MIA: 'Miami, US',
  ORD: 'Chicago, US', DFW: 'Dallas, US', DEN: 'Denver, US', LAX: 'Los Angeles, US',
  SJC: 'San Jose, US', SEA: 'Seattle, US', ATL: 'Atlanta, US', BOS: 'Boston, US',
  SFO: 'San Francisco, US', PHX: 'Phoenix, US', IAH: 'Houston, US', MSP: 'Minneapolis, US',
  YYZ: 'Toronto, CA', YVR: 'Vancouver, CA', GRU: 'São Paulo, BR', GIG: 'Rio, BR',
  EZE: 'Buenos Aires, AR', SCL: 'Santiago, CL', BOG: 'Bogotá, CO', LIM: 'Lima, PE',
  MEX: 'Mexico City, MX', QRO: 'Querétaro, MX', SYD: 'Sydney, AU', MEL: 'Melbourne, AU',
  AKL: 'Auckland, NZ', PER: 'Perth, AU', BNE: 'Brisbane, AU',
}

export function runWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const len = items.length
  if (len === 0) return Promise.resolve([])
  const results = new Array<R>(len)
  let next = 0
  
  async function worker(): Promise<void> {
    while (next < len) {
      const i = next++
      results[i] = await fn(items[i]!)
    }
  }
  
  const workers: Promise<void>[] = []
  const count = Math.min(limit, len)
  for (let i = 0; i < count; i++) {
    workers.push(worker())
  }
  return Promise.all(workers).then(() => results)
}

export async function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<{ ip: string; port: number; latency: number | null; status: 'ok' | 'error'; error?: string }> {
  let socket: ReturnType<typeof connect> | null = null
  const start = Date.now()
  try {
    socket = connect(`${host}:${port}`, { secureTransport: 'off' })
    const latency = await Promise.race([
      socket.opened.then(() => Date.now() - start as number),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])
    if (latency === null) return { ip: host, port, latency: null, status: 'error', error: 'timeout' }
    return { ip: host, port, latency, status: 'ok' }
  } catch (e) {
    return { ip: host, port, latency: null, status: 'error', error: e instanceof Error ? e.message : 'error' }
  } finally {
    try { socket?.close() } catch { /* already closed */ }
  }
}

export interface ColoProbeResult {
  ip: string
  status: 'ok' | 'error'
  latency: number | null
  colo: string | null
  city: string | null
  warp?: string
  httpProtocol?: string | null
  edgeVerifiedIp?: string | null
  crossVerified?: boolean
  error?: string
}

/** Real colo/geo verification: resolveOverride + cdn-cgi/trace + CF-RAY cross-check. */
export async function coloProbe(ip: string, timeoutMs = 4000): Promise<ColoProbeResult> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch('https://speed.cloudflare.com/cdn-cgi/trace', {
      cf: { resolveOverride: ip, cacheTtl: 0 } as never,
      signal: controller.signal,
    })
    clearTimeout(tid)
    const latency = Date.now() - start
    if (!res.ok) return { ip, status: 'error', latency: null, colo: null, city: null, error: `HTTP ${res.status}` }

    const cfRay = res.headers.get('cf-ray') || ''
    const isCfServer = (res.headers.get('server') || '').toLowerCase() === 'cloudflare'
    const rayColoMatch = cfRay.match(/[A-Z]{3}$/)
    const rayColo = isCfServer && rayColoMatch ? rayColoMatch[0] : null

    const text = await res.text()
    const data: Record<string, string> = {}
    text.split('\n').forEach((line) => {
      const eq = line.indexOf('=')
      if (eq > -1) data[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    })

    const traceColo = data.colo || null
    const finalColo = traceColo || rayColo || null
    return {
      ip,
      status: 'ok',
      latency,
      colo: finalColo,
      city: finalColo ? (COLO_CITY_MAP[finalColo] ?? null) : null,
      warp: data.warp || 'off',
      httpProtocol: data.http || null,
      edgeVerifiedIp: data.ip || null,
      crossVerified: !!(traceColo && rayColo && traceColo === rayColo),
    }
  } catch (e) {
    return { ip, status: 'error', latency: null, colo: null, city: null, error: e instanceof Error ? e.message : 'error' }
  }
}

/** Real TCP port sweep — every port genuinely handshaked, fastest wins. */
export async function portSweep(ip: string, ports: number[], concurrency = 8): Promise<{ best: { port: number; latency: number } | null; results: { port: number; latency: number | null; status: string }[] }> {
  const results = await runWithConcurrency(ports, concurrency, (p) => tcpProbe(ip, p, 3000))
  const healthy = results
    .filter((r) => r.status === 'ok' && r.latency !== null)
    .sort((a, b) => (a.latency ?? 99999) - (b.latency ?? 99999))
  return {
    best: healthy[0] ? { port: healthy[0].port, latency: healthy[0].latency! } : null,
    results: results.map((r) => ({ port: r.port, latency: r.latency, status: r.status })),
  }
}

// ── Authenticated HTTP handlers ────────────────────────────────────────────

async function requireUser(env: Env, request: Request): Promise<{ userId: string } | Response> {
  const user = await getUserFromRequest(env, request)
  if (!user) return apiError('احراز هویت لازم است', 401)
  return { userId: user.id }
}

/** GET /api/opt/probe?ip=&port=&colo=1 — single IP probe (TCP + optional colo). */
export async function handleOptProbe(env: Env, request: Request): Promise<Response> {
  const auth = await requireUser(env, request)
  if (auth instanceof Response) return auth
  const url = new URL(request.url)
  const ip = url.searchParams.get('ip') || url.searchParams.get('host')
  const port = parseInt(url.searchParams.get('port') || '443', 10)
  const withColo = url.searchParams.get('colo') === '1'
  if (!ip) return apiError('آدرس IP مشخص نشده است', 400)

  const tcp = await tcpProbe(ip, port, 3500)
  if (!withColo) return json({ success: tcp.status === 'ok', ...tcp })

  const colo = await coloProbe(ip, 4000)
  return json({
    success: tcp.status === 'ok' || colo.status === 'ok',
    ip, port,
    latency: tcp.latency,
    status: tcp.status,
    colo: colo.colo, city: colo.city, warp: colo.warp,
    httpLatency: colo.latency,
    crossVerified: !!colo.crossVerified,
  })
}

/** GET /api/opt/ports?ip=&ports=&tls=1 — real port sweep, fastest port wins. */
export async function handleOptPorts(env: Env, request: Request): Promise<Response> {
  const auth = await requireUser(env, request)
  if (auth instanceof Response) return auth
  const url = new URL(request.url)
  const ip = url.searchParams.get('ip')
  if (!ip) return apiError('آدرس IP مشخص نشده است', 400)
  const tls = url.searchParams.get('tls') !== '0'
  const portsParam = url.searchParams.get('ports')
  const ports = portsParam
    ? [...new Set(portsParam.split(',').map((p) => parseInt(p.trim(), 10)).filter((p) => p > 0 && p < 65536))].slice(0, 16)
    : tls ? CLOUDFLARE_PORTS.tls : CLOUDFLARE_PORTS.nontls
  const { best, results } = await portSweep(ip, ports)
  return json({ success: true, ip, results, best })
}

/** POST /api/opt/scan-batch { ips[], port, mode: tcp|colo|both, concurrency } */
export async function handleOptScanBatch(env: Env, request: Request): Promise<Response> {
  const auth = await requireUser(env, request)
  if (auth instanceof Response) return auth
  const body = await request.json().catch(() => ({})) as { ips?: unknown; port?: unknown; mode?: unknown; concurrency?: unknown }
  const ips = Array.isArray(body.ips) ? (body.ips as unknown[]).filter((i) => typeof i === 'string').slice(0, 500) as string[] : []
  const port = parseInt(String(body.port ?? '443'), 10) || 443
  const mode = ['tcp', 'colo', 'both'].includes(String(body.mode)) ? String(body.mode) : 'tcp'
  const concurrency = Math.min(Math.max(parseInt(String(body.concurrency ?? '30'), 10) || 30, 1), 60)
  if (!ips.length) return apiError('لیست IP خالی است', 400)

  const results = await runWithConcurrency(ips, concurrency, async (ip) => {
    if (mode === 'tcp') return { ...await tcpProbe(ip, port, 3000), colo: null, city: null, verified: false, crossVerified: false }
    if (mode === 'colo') {
      const c = await coloProbe(ip, 4000)
      return { ip, port, latency: c.latency, status: c.status, colo: c.colo, city: c.city, verified: c.status === 'ok', crossVerified: !!c.crossVerified }
    }
    const [tcp, colo] = await Promise.all([tcpProbe(ip, port, 3000), coloProbe(ip, 4000)])
    return {
      ip, port,
      latency: tcp.latency,
      status: tcp.status === 'ok' ? 'ok' : colo.status === 'ok' ? 'ok' : 'error',
      colo: colo.colo, city: colo.city, warp: colo.warp,
      httpLatency: colo.latency,
      verified: colo.status === 'ok',
      crossVerified: !!colo.crossVerified,
    }
  })

  const healthy = results.filter((r) => r.status === 'ok').length
  return json({ success: true, count: results.length, healthy, mode, results })
}

/**
 * GET /api/opt/speedtest?ip=&bytes= — REAL streaming download speed.
 * resolveOverride makes speed.cloudflare.com/__down actually connect
 * through the candidate IP; the client measures real bytes/second.
 */
export async function handleOptSpeedtest(env: Env, request: Request): Promise<Response> {
  const auth = await requireUser(env, request)
  if (auth instanceof Response) return auth
  const url = new URL(request.url)
  const ip = url.searchParams.get('ip')
  const bytes = Math.min(Math.max(parseInt(url.searchParams.get('bytes') || '2000000', 10) || 2_000_000, 100_000), 20_000_000)
  if (!ip) return apiError('آدرس IP مشخص نشده است', 400)

  try {
    const upstream = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, {
      cf: { resolveOverride: ip, cacheTtl: 0 } as never,
    })
    if (!upstream.ok || !upstream.body) {
      return json({ success: false, error: `upstream responded ${upstream.status}` }, 502)
    }
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Speedtest-Ip': ip,
        'X-Speedtest-Bytes': String(bytes),
      },
    })
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : 'speedtest failed' }, 502)
  }
}

/** Shared with optimizer: speed-test a single IP, returns Mbps (0 on failure). */
export async function measureSpeed(ip: string, bytes = 1_500_000, timeoutMs = 8000): Promise<{ mbps: number; ms: number }> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), timeoutMs)
    const upstream = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`, {
      cf: { resolveOverride: ip, cacheTtl: 0 } as never,
      signal: controller.signal,
    })
    clearTimeout(tid)
    if (!upstream.ok || !upstream.body) return { mbps: 0, ms: 0 }
    const buf = await upstream.arrayBuffer()
    const ms = Date.now() - start
    if (ms <= 0 || buf.byteLength === 0) return { mbps: 0, ms: 0 }
    const mbps = (buf.byteLength * 8) / (1_048_576 * (ms / 1000))
    return { mbps: Math.round(mbps * 100) / 100, ms }
  } catch {
    return { mbps: 0, ms: 0 }
  }
}

// Env import kept for handler symmetry (future per-user rate limits).
export type { Env }
