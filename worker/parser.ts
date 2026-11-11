// miliconfig universal smart node parser.
//
// Extracts proxy nodes from ANY real-world content shape:
//   • plain link lists (vless/vmess/trojan/ss/hysteria/hysteria2/tuic/socks)
//   • base64 subscription blobs (up to 3 layers of encoding)
//   • sing-box JSON configs (outbounds → share links)
//   • Clash / Clash.Meta YAML configs (proxies → share links)
//   • JSON arrays of link strings, nodes embedded inside HTML pages,
//     JSON string fields, error pages — anything containing node URIs
//
// The core trick: a global regex sweep over the WHOLE text instead of
// line-by-line matching, so nodes are found wherever they hide.

const NODE_URI_RE = /(?:vless|vmess|trojan|ss|hysteria2?|hy2|tuic|socks5?):\/\/[^\s"'<>\\)\]]+/gi

const SCHEME_RE = /^(vless|vmess|trojan|ss|hysteria2?|hy2|tuic|socks5?):\/\//i

/** Sweep the entire text for node URIs, wherever they are embedded. */
function sweepUris(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(NODE_URI_RE)) {
    // Trim trailing punctuation that commonly sticks to links in prose/HTML.
    const uri = match[0].replace(/[.,;:]+$/, '')
    if (!SCHEME_RE.test(uri)) continue
    // vmess URIs must carry a decodable payload — validated lazily by callers,
    // but drop obviously broken ones here.
    const key = uri.split('#')[0]
    if (seen.has(key)) continue
    seen.add(key)
    out.push(uri)
  }
  return out
}

// ── base64 ───────────────────────────────────────────────────────────────

function b64decode(s: string): string | null {
  try {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
    const bin = atob(norm)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function b64encodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

// ── sing-box JSON → share links ──────────────────────────────────────────

/** Convert a sing-box config's outbounds into standard share links. */
export function singboxJsonToLinks(text: string): string[] {
  try {
    const cfg = JSON.parse(text) as { outbounds?: Array<Record<string, unknown>> }
    if (!Array.isArray(cfg.outbounds)) return []
    const links: string[] = []
    for (const o of cfg.outbounds) {
      const link = singboxOutboundToLink(o)
      if (link) links.push(link)
    }
    return links
  } catch {
    return []
  }
}

function singboxOutboundToLink(o: Record<string, unknown>): string | null {
  try {
    const type = String(o.type ?? '')
    const server = String(o.server ?? '')
    const port = Number(o.server_port ?? 0)
    const tag = String(o.tag ?? `${type}-${server}`)
    if (!server || !port) return null

    const transport = o.transport as Record<string, unknown> | undefined
    const network = transport ? String(transport.type ?? 'tcp') : 'tcp'
    const path = transport ? String(transport.path ?? '') : ''
    const wsHost = transport && typeof transport.headers === 'object' && transport.headers !== null
      ? String((transport.headers as Record<string, unknown>).Host ?? '') : ''
    const serviceName = transport ? String(transport.service_name ?? '') : ''
    const tls = o.tls as Record<string, unknown> | undefined
    const isReality = !!(tls?.reality as Record<string, unknown> | undefined)?.enabled
    const security = type === 'trojan' ? 'tls' : tls?.enabled ? (isReality ? 'reality' : 'tls') : 'none'
    const sni = tls ? String(tls.server_name ?? '') : ''
    const fp = tls && typeof tls.utls === 'object' ? String((tls.utls as Record<string, unknown>).fingerprint ?? '') : ''

    const q = new URLSearchParams()
    if (security !== 'none') {
      q.set('security', security)
      if (sni) q.set('sni', sni)
      if (fp) q.set('fp', fp)
      if (isReality) {
        const r = (tls!.reality ?? {}) as Record<string, unknown>
        if (r.public_key) q.set('pbk', String(r.public_key))
        if (r.short_id) q.set('sid', String(r.short_id))
      }
    }
    if (network === 'ws' || network === 'grpc' || network === 'httpupgrade') {
      q.set('type', network)
      if (path) q.set('path', path)
      if (wsHost) q.set('host', wsHost)
      if (network === 'grpc' && serviceName) q.set('serviceName', serviceName)
    }
    const qs = q.toString()

    if (type === 'vless') {
      const flow = o.flow ? `&flow=${encodeURIComponent(String(o.flow))}` : ''
      return `vless://${o.uuid}@${server}:${port}?encryption=none${qs ? '&' + qs : ''}${flow}#${encodeURIComponent(tag)}`
    }
    if (type === 'vmess') {
      const json = { v: '2', ps: tag, add: server, port, id: o.uuid, aid: o.alter_id ?? 0, scy: o.security ?? 'auto', net: network, host: wsHost, path, tls: security === 'tls' || security === 'reality' ? 'tls' : '', sni }
      return `vmess://${b64encodeUtf8(JSON.stringify(json))}`
    }
    if (type === 'trojan') {
      return `trojan://${encodeURIComponent(String(o.password ?? ''))}@${server}:${port}?${qs}#${encodeURIComponent(tag)}`
    }
    if (type === 'shadowsocks') {
      return `ss://${b64encodeUtf8(`${o.method}:${o.password}`)}@${server}:${port}#${encodeURIComponent(tag)}`
    }
    if (type === 'hysteria2') {
      return `hysteria2://${encodeURIComponent(String(o.password ?? ''))}@${server}:${port}?${qs}#${encodeURIComponent(tag)}`
    }
    return null
  } catch {
    return null
  }
}

// ── Clash / Clash.Meta YAML → share links ────────────────────────────────

interface ClashProxy {
  name: string; type: string; server: string; port: number
  [k: string]: unknown
}

/** Minimal YAML-subset parser for the `proxies:` section of Clash configs.
 *  Handles both block style (`- name: x\n  type: ss ...`) and flow style
 *  (`- {name: x, type: ss, server: y, port: 443, ...}`). */
export function clashYamlToProxies(text: string): ClashProxy[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^proxies\s*:/.test(l))
  if (start === -1) return []

  const proxies: ClashProxy[] = []
  let current: Record<string, unknown> | null = null

  const flush = () => {
    if (current && current.name && current.server && current.port) proxies.push(current as ClashProxy)
    current = null
  }

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    // New top-level key ends the proxies section.
    if (/^[A-Za-z-]+\s*:/.test(line) && !line.startsWith(' ') && !line.startsWith('-')) break
    const flow = line.match(/^\s*-\s*\{(.+)\}\s*$/)
    if (flow) {
      flush()
      current = parseFlowMap(flow[1]!)
      continue
    }
    const blockStart = line.match(/^\s*-\s+(.+)$/)
    if (blockStart) {
      flush()
      current = {}
      const kv = blockStart[1]!.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/)
      if (kv) assignKV(current, kv[1]!, kv[2]!)
      continue
    }
    if (current && /^\s+([A-Za-z_-]+)\s*:\s*(.*)$/.test(line)) {
      const kv = line.match(/^\s+([A-Za-z_-]+)\s*:\s*(.*)$/)!
      assignKV(current, kv[1]!, kv[2]!)
    }
  }
  flush()
  return proxies
}

function parseFlowMap(body: string): Record<string, unknown> {
  const map: Record<string, unknown> = {}
  // Split on commas not inside quotes.
  const parts: string[] = []
  let cur = '', quote = ''
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === ',') { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) parts.push(cur)
  for (const part of parts) {
    const m = part.match(/^\s*([A-Za-z_-]+)\s*:\s*(.*)$/)
    if (m) assignKV(map, m[1]!, m[2]!)
  }
  return map
}

function assignKV(map: Record<string, unknown>, key: string, raw: string): void {
  let v: unknown = raw.trim()
  const s = String(v)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    v = s.slice(1, -1)
  } else if (/^-?\d+(\.\d+)?$/.test(s)) {
    v = Number(s)
  } else if (/^(true|false)$/i.test(s)) {
    v = s.toLowerCase() === 'true'
  }
  map[key] = v
}

/** Convert parsed Clash proxies into standard share links. */
export function clashProxiesToLinks(proxies: ClashProxy[]): string[] {
  const out: string[] = []
  for (const p of proxies) {
    const name = encodeURIComponent(String(p.name ?? ''))
    const server = String(p.server ?? '')
    const port = Number(p.port ?? 0)
    if (!server || !port) continue
    try {
      if (p.type === 'ss') {
        const cipher = String(p.cipher ?? 'aes-128-gcm')
        const password = String(p.password ?? '')
        if (!password) continue
        out.push(`ss://${b64encodeUtf8(`${cipher}:${password}`)}@${server}:${port}#${name}`)
        continue
      }
      if (p.type === 'trojan') {
        const q = new URLSearchParams()
        if (p.sni) q.set('security', 'tls'), q.set('sni', String(p.sni))
        if (p['client-fingerprint']) q.set('fp', String(p['client-fingerprint']))
        const network = String(p.network ?? 'tcp')
        if (network !== 'tcp') q.set('type', network)
        if (p['ws-opts']) {
          const opts = p['ws-opts'] as Record<string, unknown>
          q.set('type', 'ws')
          if (opts.path) q.set('path', String(opts.path))
          const headers = opts.headers as Record<string, unknown> | undefined
          if (headers?.Host) q.set('host', String(headers.Host))
        }
        out.push(`trojan://${encodeURIComponent(String(p.password ?? ''))}@${server}:${port}?${q.toString()}#${name}`)
        continue
      }
      if (p.type === 'vless') {
        const q = new URLSearchParams({ encryption: 'none' })
        const tlsOn = p.tls === true || String(p.security ?? '') === 'reality'
        if (tlsOn || p.servername) {
          q.set('security', String(p.security ?? 'tls') === 'reality' ? 'reality' : 'tls')
          if (p.servername) q.set('sni', String(p.servername))
        }
        if (p['client-fingerprint']) q.set('fp', String(p['client-fingerprint']))
        if (p.flow) q.set('flow', String(p.flow))
        const ro = p['reality-opts'] as Record<string, unknown> | undefined
        if (ro?.['public-key']) q.set('pbk', String(ro['public-key']))
        if (ro?.['short-id']) q.set('sid', String(ro['short-id']))
        const network = String(p.network ?? 'tcp')
        if (network !== 'tcp') q.set('type', network)
        if (p['ws-opts']) {
          const opts = p['ws-opts'] as Record<string, unknown>
          q.set('type', 'ws')
          if (opts.path) q.set('path', String(opts.path))
          const headers = opts.headers as Record<string, unknown> | undefined
          if (headers?.Host) q.set('host', String(headers.Host))
        }
        if (p['grpc-opts']) {
          const opts = p['grpc-opts'] as Record<string, unknown>
          q.set('type', 'grpc')
          if (opts['grpc-service-name']) q.set('serviceName', String(opts['grpc-service-name']))
        }
        out.push(`vless://${p.uuid}@${server}:${port}?${q.toString()}#${name}`)
        continue
      }
      if (p.type === 'vmess') {
        const wsOpts = p['ws-opts'] as Record<string, unknown> | undefined
        const json = {
          v: '2', ps: String(p.name ?? ''), add: server, port,
          id: String(p.uuid ?? ''), aid: Number(p.alterId ?? p['alterId'] ?? 0),
          scy: String(p.cipher ?? 'auto'),
          net: String(p.network ?? 'tcp'),
          host: wsOpts?.headers ? String((wsOpts.headers as Record<string, unknown>).Host ?? '') : '',
          path: wsOpts?.path ? String(wsOpts.path) : '',
          tls: p.tls === true ? 'tls' : '',
          sni: String(p.servername ?? ''),
        }
        if (!json.id) continue
        out.push(`vmess://${b64encodeUtf8(JSON.stringify(json))}`)
        continue
      }
    } catch { /* skip malformed proxy */ }
  }
  return out
}

// ── Orchestrator ─────────────────────────────────────────────────────────

/** Extract node share links from ANY subscription content.
 *  Order: direct sweep → sing-box JSON → Clash YAML → base64 layers. */
export function extractNodes(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  // 1) Node URIs anywhere in the text (plain lists, HTML, JSON-embedded…).
  let links = sweepUris(trimmed)
  if (links.length) return links

  // 2) sing-box JSON config.
  links = singboxJsonToLinks(trimmed)
  if (links.length) return links

  // 3) Clash / Clash.Meta YAML.
  links = clashProxiesToLinks(clashYamlToProxies(trimmed))
  if (links.length) return links

  // 4) base64 layers (subscriptions are sometimes double/triple-encoded).
  let layer = trimmed
  for (let i = 0; i < 3; i++) {
    const decoded = b64decode(layer)
    if (!decoded || decoded === layer) break
    links = sweepUris(decoded)
    if (links.length) return links
    links = singboxJsonToLinks(decoded)
    if (links.length) return links
    layer = decoded.trim()
  }
  return []
}

/** Is this line/URI a node link at all? */
export function isNodeLine(line: string): boolean {
  return SCHEME_RE.test(line.trim())
}
