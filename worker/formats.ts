// Output-format converters for merged subscription content.
// • buildSingboxJson()      — share links → sing-box config
// • renderSubscription()    — one renderer for every sub type (group/inject/member)
// • configJsonToLines()     — sing-box JSON configs parsed as node sources
// Clash Meta already has buildClashYaml.

import { b64encodeUtf8 } from './net'
import { buildClashYaml, linesToResult } from './inject'
import { extractNodes, singboxJsonToLinks } from './parser'

/** Decode a response body the way the EDT source does: try UTF-8 first,
 *  and if the text contains replacement characters (wrong charset — common
 *  with GB2312/GBK Chinese IP lists and some Persian providers), retry with
 *  the charset from Content-Type, then GB2312, then Latin-1. */
function decodeSmart(buffer: ArrayBuffer, contentType: string): string {
  const charset = (contentType.match(/charset=([^\s;]+)/i)?.[1] ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
  const candidates = [
    ...(charset && charset !== 'utf-8' && charset !== 'utf8' ? [charset] : []),
    'utf-8', 'gb2312', 'windows-1256', 'latin1',
  ]
  for (const enc of candidates) {
    try {
      const decoded = new TextDecoder(enc).decode(buffer)
      if (decoded.length > 0 && !decoded.includes('\ufffd')) return decoded
    } catch { /* encoding unsupported in this runtime → next */ }
  }
  return new TextDecoder('utf-8').decode(buffer)
}

/** Fetch node lines from ANY subscription URL, tolerating every real-world
 * shape: base64 blobs, plain link lists, sing-box JSON, Clash YAML, HTML
 * pages, error pages with partial content, and wrong paths. If the exact
 * URL fails (404 etc.) we retry smart fallback variants — e.g. a pasted
 * `worker/uuid/sub?target=x` still resolves to the working `worker/uuid`
 * direct subscription. Mirrors the proven fetch hardening of the EDT
 * source: client User-Agent, `sub://` scheme, `#remark` tagging and
 * multi-charset decoding. */
export async function fetchSubLines(url: string, timeoutMs = 30_000): Promise<string[]> {
  const raw = url.trim()
  // EDT-style `sub://host` scheme → https (preferred-IP generator links).
  const u = raw.replace(/^sub:\/\//i, 'https://')
  // `#remark` suffix on pasted URLs tags every node from this source (EDT-style).
  const hashIndex = u.indexOf('#')
  const remark = hashIndex > -1 ? decodeURIComponent(u.slice(hashIndex + 1)).trim() : ''
  const cleanUrl = hashIndex > -1 ? u.slice(0, hashIndex) : u

  const tag = (lines: string[]): string[] => {
    if (!remark) return lines
    return lines.map((l) => {
      const h = l.indexOf('#')
      const base = h > -1 ? l.slice(0, h) : l
      const name = h > -1 ? decodeURIComponent(l.slice(h + 1)) : ''
      const newName = name ? `${name} [${remark}]` : remark
      return `${base}#${encodeURIComponent(newName)}`
    })
  }

  const variants: string[] = [cleanUrl]
  try {
    const parsed = new URL(cleanUrl)
    // 2) without query string
    if (parsed.search) variants.push(parsed.origin + parsed.pathname)
    // 3) without a trailing `/sub` segment (common wrong mix of direct-sub + panel path)
    if (/\/sub\/?$/i.test(parsed.pathname)) {
      const stripped = parsed.origin + parsed.pathname.replace(/\/sub\/?$/i, '')
      variants.push(stripped)
      if (parsed.search) variants.push(stripped + parsed.search)
    }
    // 4) origin + first path segment only (edgetunnel direct sub = /UUID)
    const seg = '/' + parsed.pathname.split('/').filter(Boolean)[0]
    if (seg !== '/' && seg !== parsed.pathname) variants.push(parsed.origin + seg)
  } catch { /* not a URL — caller handles raw content */ }

  let saw1042 = false
  for (const candidate of [...new Set(variants)]) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeoutMs)
      let buffer: ArrayBuffer = new ArrayBuffer(0)
      let contentType = ''
      let ok = false
      try {
        // Client-style UA — some sub providers 403 empty/unknown UAs.
        const resp = await fetch(candidate, {
          redirect: 'follow',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'v2rayNG/1.9.16' },
        })
        ok = resp.ok
        // Even non-200 bodies sometimes contain usable node lines — read them.
        contentType = resp.headers.get('content-type') ?? ''
        buffer = await resp.arrayBuffer()
      } finally {
        clearTimeout(t)
      }
      const text = decodeSmart(buffer, contentType)
      if (text.includes('error code: 1042')) saw1042 = true
      const lines = tag(extractNodes(text))
      if (lines.length) return lines
      if (!ok) continue // 404/5xx with no usable content → next variant
    } catch { /* network error → next variant */ }
  }
  if (saw1042) {
    throw new Error('کلودفلر دریافت ساب از ورکر workers.dev را مسدود کرد (خطای 1042) — پرچم global_fetch_strictly_public باید روی ورکر فعال باشد')
  }
  return []
}

/** Fetch nodes from MULTIPLE subscription URLs at once (pasted together,
 *  separated by newlines, commas or spaces) and merge + dedupe the result. */
export async function fetchMultiSubLines(input: string, timeoutMs = 30_000): Promise<string[]> {
  const urls = input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^(https?|sub):\/\//i.test(s))
    .slice(0, 10)
  if (!urls.length) return []

  const results = await Promise.allSettled(
    urls.map((u) => fetchSubLines(u, timeoutMs)),
  )
  
  const seen = new Set<string>()
  const out: string[] = []
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    for (const line of result.value) {
      const key = line.split('#')[0]!
      if (seen.has(key)) continue
      seen.add(key)
      out.push(line)
    }
  }
  return out
}

/** Serialize node lines in the requested output format.
 * format: base64 (default) | plain | clash | singbox */
export function renderSubscription(lines: string[], format: string | null | undefined): Response {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'profile-update-interval': '1' }
  const fmt = ['plain', 'clash', 'singbox'].includes(String(format)) ? String(format) : 'base64'
  if (fmt === 'clash') {
    return new Response(buildClashYaml(linesToResult(lines)), {
      headers: { 'Content-Type': 'text/yaml; charset=utf-8', 'profile-update-interval': '1' },
    })
  }
  if (fmt === 'singbox') return new Response(buildSingboxJson(lines), { headers })
  if (fmt === 'plain') return new Response(lines.join('\n'), { headers })
  return new Response(b64encodeUtf8(lines.join('\n')), { headers })
}/** Detect a sing-box style JSON config and convert its outbounds back into
 *  standard share links — now powered by the universal parser engine. */
export function configJsonToLines(text: string): string[] {
  return singboxJsonToLinks(text)
}

export function buildSingboxJson(lines: string[]): string {
  const outbounds = lines
    .map(parseNodeLine)
    .filter((o): o is Record<string, unknown> => !!o)
  const config = {
    log: { level: 'info', timestamp: true },
    dns: {
      servers: ['https://1.1.1.1/dns-query', '8.8.8.8'],
      rules: [{ outbound: 'any', server: 'https://1.1.1.1/dns-query' }],
    },
    inbounds: [
      { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30'], auto_route: true, stack: 'mixed' },
    ],
    outbounds,
    route: {
      rules: [{ protocol: 'dns', outbound: 'dns-out' }],
      final: 'proxy',
      auto_detect_interface: true,
    },
  }
  return JSON.stringify(config, null, 2)
}

function b64decode(s: string): string | null {
  try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')) } catch { return null }
}

/** Convert one share link into a sing-box outbound object (or null). */
function parseNodeLine(line: string): Record<string, unknown> | null {
  try {
    const trimmed = line.trim()
    const scheme = trimmed.split('://')[0]
    const hashIdx = trimmed.indexOf('#')
    const name = hashIdx > -1 ? decodeURIComponent(trimmed.slice(hashIdx + 1)) : 'node'
    const body = (hashIdx > -1 ? trimmed.slice(0, hashIdx) : trimmed)

    if (scheme === 'vmess') {
      const json = JSON.parse(b64decode(body.slice('vmess://'.length)) ?? '')
      if (!json.add || !json.id) return null
      const outbound: Record<string, unknown> = {
        type: 'vmess', tag: String(json.ps || name), server: String(json.add),
        server_port: Number(json.port || 443), uuid: String(json.id),
        alter_id: Number(json.aid || 0), security: String(json.scy || 'auto'),
      }
      addTlsTransport(outbound, json.tls === 'tls', String(json.sni || ''), json.net ? String(json.net) : '', json.path ? String(json.path) : '', json.host ? String(json.host) : '')
      return outbound
    }

    if (scheme === 'ss') {
      // Both forms: ss://b64(method:pass)@host:port and fully-encoded
      let method = '', password = '', hostPort = ''
      const at = body.lastIndexOf('@')
      if (at > -1) {
        const cred = body.slice('ss://'.length, at)
        const decoded = b64decode(cred) ?? decodeURIComponent(cred)
        const sep = decoded.indexOf(':')
        method = decoded.slice(0, sep)
        password = decoded.slice(sep + 1)
        hostPort = body.slice(at + 1).split('?')[0]
      } else {
        const decoded = b64decode(body.slice('ss://'.length)) ?? ''
        const m = decoded.match(/^(.+?):(.+)@(.+)$/)
        if (!m) return null
        ;[, method, password, hostPort] = m
      }
      const [host, portStr] = hostPort.split(':')
      if (!host || !Number(portStr)) return null
      return { type: 'shadowsocks', tag: name, server: host, server_port: Number(portStr), method, password }
    }

    // URI-style schemes sharing ?query params
    const qIdx = body.indexOf('?')
    const authority = (qIdx > -1 ? body.slice(0, qIdx) : body).split('://')[1] ?? ''
    const query = new URLSearchParams(qIdx > -1 ? body.slice(qIdx + 1) : '')
    const at = authority.lastIndexOf('@')
    if (at < 0) return null
    const credential = authority.slice(0, at)
    const [host, portStr] = authority.slice(at + 1).split(':')
    const port = Number(portStr)
    if (!host || !port) return null

    if (scheme === 'vless') {
      const outbound: Record<string, unknown> = {
        type: 'vless', tag: name, server: host, server_port: port, uuid: credential,
        flow: query.get('flow') || '',
      }
      const security = query.get('security') ?? ''
      const sni = query.get('sni') ?? ''
      if (security === 'reality') {
        outbound.tls = {
          enabled: true, server_name: sni,
          utls: { enabled: true, fingerprint: query.get('fp') || 'chrome' },
          reality: { enabled: true, public_key: query.get('pbk') ?? '', short_id: query.get('sid') ?? '' },
        }
      } else {
        addTlsTransport(outbound, security === 'tls' || port === 443, sni, query.get('type') ?? '', query.get('path') ?? '', query.get('host') ?? '')
      }
      return outbound
    }

    if (scheme === 'trojan') {
      const outbound: Record<string, unknown> = {
        type: 'trojan', tag: name, server: host, server_port: port, password: decodeURIComponent(credential),
      }
      addTlsTransport(outbound, true, query.get('sni') ?? '', query.get('type') ?? '', query.get('path') ?? '', query.get('host') ?? '')
      return outbound
    }

    return null
  } catch {
    return null
  }
}

function addTlsTransport(outbound: Record<string, unknown>, tls: boolean, sni: string, network: string, path: string, hostHeader: string): void {
  if (tls || sni) {
    outbound.tls = {
      enabled: true,
      ...(sni ? { server_name: sni } : {}),
      ...(outbound.type !== 'trojan' ? { insecure: false } : {}),
    }
  }
  if (network === 'ws') {
    outbound.transport = { type: 'ws', ...(path ? { path } : {}), ...(hostHeader ? { headers: { Host: hostHeader } } : {}) }
  } else if (network === 'grpc') {
    outbound.transport = { type: 'grpc', service_name: path || '' }
  }
}
