/**
 * Ara Optimizer Engine — faithful port of the Sop8 / cf-optimizor algorithm.
 * ---------------------------------------------------------------------------
 * Exact same technique as the reference project: parse a vless/trojan line,
 * selectively replace {address, port, fp, cs, fm} (plus optional sni/host),
 * and rebuild the URL with the real fixed parameter order. Unknown params are
 * preserved in original order. Other protocols pass through untouched.
 */

export const FM_STR =
  '{"tcp":[{"type":"fragment","settings":{"packets":"tlshello","lengths":["5","94","1"],"delays":["0"],"maxSplit":"0"}},{"type":"fragment","settings":{"packets":"1-1","lengths":["109","1"],"delays":["1"],"maxSplit":"355"}}]}'

export const CS_STR = [
  'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
  'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256', 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA', 'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
  'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256', 'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256',
].join(':')

/** "Aras Mode" — documented lightweight profile from the reference tool. */
export const ARAS_CS = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256'
export const ARAS_FM =
  '{"tcp":[{"type":"fragment","settings":{"packets":"tlshello","lengths":["1-1"],"delays":["0"],"maxSplit":"0"}}]}'
export const ARAS_FP = 'chrome'

export const ARA_DEFAULTS = { adr: '', fp: 'unsafe', cs: CS_STR, fm: FM_STR }

export const PARAM_ORDER = ['cs', 'path', 'security', 'alpn', 'encryption', 'fm', 'insecure', 'host', 'fp', 'type', 'allowInsecure', 'sni']

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
export const PROTO_START_RE = /^(vless|vmess|trojan|ss|hysteria2?|tuic|naive\+https?|naive\+quic|wireguard|socks5?|http):\/\//i

export interface AraOptions {
  adr?: string
  port?: string | number
  sni?: string
  host?: string
  fp?: string
  cs?: string
  fm?: string
}

interface AraConfig {
  proto: 'vless' | 'trojan'
  id?: string
  pass?: string
  host: string
  port: string
  p: { k: string; v: string }[]
  f: string
}

function dec(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

function pq(q: string): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = []
  if (!q) return out
  q.split('&').forEach((p) => {
    if (!p) return
    const i = p.indexOf('=')
    out.push({ k: dec(i < 0 ? p : p.slice(0, i)), v: i < 0 ? '' : dec(p.slice(i + 1)) })
  })
  return out
}

function setParam(p: { k: string; v: string }[], k: string, v: string): void {
  const lk = k.toLowerCase()
  let found = false
  for (let i = p.length - 1; i >= 0; i--) {
    if (p[i]!.k.toLowerCase() === lk) {
      if (found) { p.splice(i, 1); continue }
      p[i] = { k, v }
      found = true
    }
  }
  if (!found) p.push({ k, v })
}

function buildQS(p: { k: string; v: string }[]): string {
  const idx: Record<string, number> = {}
  PARAM_ORDER.forEach((k, i) => { idx[k] = i })
  const a: { k: string; v: string }[] = []
  const b: { k: string; v: string }[] = []
  p.forEach((x) => (idx[x.k.toLowerCase()] !== undefined ? a : b).push(x))
  a.sort((x, y) => (idx[x.k.toLowerCase()] ?? 0) - (idx[y.k.toLowerCase()] ?? 0))
  return a.concat(b).map((x) => `${encodeURIComponent(x.k)}=${encodeURIComponent(x.v)}`).join('&')
}

function parseAuth(au: string): { host: string; port: string } {
  let host = au
  let port = ''
  if (au.charAt(0) === '[') {
    const c = au.indexOf(']')
    if (c < 0) throw new Error('IPv6 نامعتبر')
    host = au.slice(0, c + 1)
    if (au.charAt(c + 1) === ':') port = au.slice(c + 2)
  } else {
    const c2 = au.lastIndexOf(':')
    if (c2 > 0) { host = au.slice(0, c2); port = au.slice(c2 + 1) }
  }
  return { host, port }
}

function splitUrl(raw: string, skip: number): { body: string; q: string; f: string } {
  let b = raw.slice(skip)
  let frag = ''
  let qi = b.indexOf('?')
  let hi = -1
  if (qi >= 0) hi = b.indexOf('#', qi)
  else hi = b.indexOf('#')
  if (hi >= 0) { frag = b.slice(hi + 1); b = b.slice(0, hi) }
  let q = ''
  const x = b.indexOf('?')
  if (x >= 0) { q = b.slice(x + 1); b = b.slice(0, x) }
  return { body: b, q, f: frag }
}

function parseVlessReal(raw: string): AraConfig {
  const s = splitUrl(raw, 8)
  const a = s.body.lastIndexOf('@')
  if (a < 0) throw new Error('@ وجود ندارد')
  const id = dec(s.body.slice(0, a)).trim()
  const au = s.body.slice(a + 1).trim()
  if (!UUID_RE.test(id)) throw new Error('UUID نامعتبر')
  const hp = parseAuth(au)
  return { proto: 'vless', id, host: hp.host, port: hp.port, p: pq(s.q), f: s.f }
}

function parseTrojanReal(raw: string): AraConfig {
  const s = splitUrl(raw, 9)
  const a = s.body.lastIndexOf('@')
  if (a < 0) throw new Error('@ وجود ندارد')
  const pass = dec(s.body.slice(0, a)).trim()
  const au = s.body.slice(a + 1).trim()
  if (!pass) throw new Error('رمز عبور خالی')
  const hp = parseAuth(au)
  return { proto: 'trojan', pass, host: hp.host, port: hp.port, p: pq(s.q), f: s.f }
}

function buildVlessReal(c: AraConfig): string {
  const qs = buildQS(c.p)
  return `vless://${c.id}@${c.host}${c.port ? ':' + c.port : ''}${qs ? '?' + qs : ''}${c.f ? '#' + c.f : ''}`
}

function buildTrojanReal(c: AraConfig): string {
  const qs = buildQS(c.p)
  return `trojan://${encodeURIComponent(c.pass ?? '')}@${c.host}${c.port ? ':' + c.port : ''}${qs ? '?' + qs : ''}${c.f ? '#' + c.f : ''}`
}

function fmOf(raw: string): string {
  const t = String(raw || '').trim() || FM_STR
  try { return JSON.stringify(JSON.parse(t)) } catch { throw new Error('FinalMask JSON نامعتبر') }
}

function applyParams(c: AraConfig, o: AraOptions): void {
  if (o.adr) c.host = o.adr
  if (o.port) c.port = String(o.port)
  setParam(c.p, 'fp', o.fp || ARA_DEFAULTS.fp)
  setParam(c.p, 'cs', o.cs || ARA_DEFAULTS.cs)
  setParam(c.p, 'fm', fmOf(o.fm || ''))
  if (o.sni) setParam(c.p, 'sni', o.sni)
  if (o.host) setParam(c.p, 'host', o.host)
}

/**
 * The real optimize() entry point — parses a single config line, replaces
 * only the target params, and rebuilds with the exact parameter order.
 * Any other protocol passes through untouched.
 */
export function optimizeConfigLine(raw: string, o: AraOptions = {}): string {
  const l = String(raw || '').trim()
  if (/^vless:\/\//i.test(l)) {
    const cv = parseVlessReal(l)
    applyParams(cv, o)
    return buildVlessReal(cv)
  }
  if (/^trojan:\/\//i.test(l)) {
    const ct = parseTrojanReal(l)
    applyParams(ct, o)
    return buildTrojanReal(ct)
  }
  if (PROTO_START_RE.test(l)) return l
  throw new Error('پروتکل ناشناخته یا نامعتبر')
}

// ── Real base64 subscription decode/extract (identical to reference) ──────

export function b64decodeSmart(s: string): string {
  try {
    let t = s.replace(/[\r\n\t ]/g, '').replace(/-/g, '+').replace(/_/g, '/')
    while (t.length % 4) t += '='
    const bin = atob(t)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch { return '' }
}

export function extractConfigLines(text: string): string[] {
  const found: string[] = []
  String(text || '').split(/\r?\n/).forEach((line) => {
    const l = line.trim()
    if (PROTO_START_RE.test(l)) found.push(l)
  })
  return found
}

export function extractConfigs(text: string): string[] {
  const t = String(text || '')
  const direct = extractConfigLines(t)
  if (direct.length) return direct
  const decoded = b64decodeSmart(t)
  if (decoded) {
    const fromDecoded = extractConfigLines(decoded)
    if (fromDecoded.length) return fromDecoded
  }
  return []
}
