// miliconfig injection engine — swaps node entry addresses with scanned
// preferred IPs (fixed entry) and builds Clash Meta configs with HTTP/SOCKS5
// dialer-proxy chains (fixed egress) — the part cf-optimizor lacks.

import { b64encodeUtf8 } from './net'
import { extractNodes } from './parser'
import { parseNodeLine, type ParsedNode } from './optimizer'

export interface PreferredIP { ip: string; port?: number }
export interface ProxySpec {
  type: 'http' | 'socks5'
  server: string
  port: number
  username?: string
  password?: string
}

// ── Source collection ───────────────────────────────────────────────────

export async function collectNodeLines(source: string): Promise<string[]> {
  const trimmed = source.trim()
  if (/(https?|sub):\/\//i.test(trimmed)) {
    // Multi-URL + universal parser (base64 / JSON / Clash YAML / plain / HTML).
    const { fetchMultiSubLines } = await import('./formats')
    const lines = await fetchMultiSubLines(trimmed)
    if (lines.length) return lines
    throw new Error(`دریافت لینک ساب ناموفق بود — هیچ نود معتبری پیدا نشد`)
  }
  return extractNodes(trimmed)
}

// ── Entry-IP injection (base64 sub) ─────────────────────────────────────

/** Replace the entry `host:port` of a node URI with a preferred IP, keeping
 *  sni/host params (the original domain) untouched so TLS stays valid. */
function swapEntry(line: string, proto: string, ip: string, port: number): string | null {
  if (proto === 'vmess') {
    try {
      const json = JSON.parse(atob(line.slice('vmess://'.length))) as Record<string, unknown>
      const original = String(json.add ?? '')
      json.add = ip
      json.port = port
      if (!json.host) json.host = original
      return 'vmess://' + btoa(JSON.stringify(json))
    } catch {
      return null
    }
  }
  const hashIndex = line.indexOf('#')
  const qIndex = line.indexOf('?')
  const authorityEnd = qIndex > -1 ? qIndex : (hashIndex > -1 ? hashIndex : line.length)
  const authority = line.slice(0, authorityEnd)
  const at = authority.lastIndexOf('@')
  if (at === -1) return null
  const head = authority.slice(0, at + 1)
  const tail = line.slice(authorityEnd)
  return `${head}${ip}:${port}${tail}`
}

export interface InjectResult {
  subLines: string[]
  clashProxies: Array<Record<string, unknown>>
  clashProxiesNames: string[]
  injectedCount: number
}

export function applyInjection(
  lines: string[],
  ips: PreferredIP[],
  proxies: ProxySpec[],
): InjectResult {
  const nodes = lines.map(parseNodeLine).filter((n): n is ParsedNode => n !== null)
  const subLines: string[] = []
  const clashProxies: Array<Record<string, unknown>> = []
  const clashProxiesNames: string[] = []
  let injectedCount = 0

  for (const node of nodes) {
    // Keep the original node first.
    subLines.push(node.line)
    const originalClash = nodeToClash(node, node.name)
    if (originalClash) {
      clashProxies.push(originalClash)
      clashProxiesNames.push(node.name)
    }

    if (ips.length === 0) continue
    // Injected variants: entry = preferred IP, sni/host = original domain.
    for (const pref of ips.slice(0, 20)) {
      const port = pref.port ?? node.port
      const swapped = swapEntry(node.line, node.proto, pref.ip, port)
      if (!swapped) continue
      injectedCount++
      const variantName = `${node.name} | miliconfig-${pref.ip}${port !== 443 ? ':' + port : ''}`
      const withName = setNodeName(swapped, node.proto, variantName)
      subLines.push(withName)
      const clashNode = nodeToClash(
        { ...node, host: pref.ip, port, line: withName },
        variantName,
        node.host, // keep original domain as sni/host
      )
      if (clashNode) {
        clashProxies.push(clashNode)
        clashProxiesNames.push(variantName)
      }
    }
  }

  // Proxy servers themselves + dialer-proxy chains (fixed egress).
  const chainPairs: Array<{ nodeName: string; proxy: ProxySpec }> = []
  const topNodes = nodes.slice(0, 10)
  for (const [pi, proxy] of proxies.entries()) {
    const pname = `${proxy.type}-${proxy.server}:${proxy.port}`
    clashProxies.push({
      name: pname,
      type: proxy.type,
      server: proxy.server,
      port: proxy.port,
      ...(proxy.username ? { username: proxy.username } : {}),
      ...(proxy.password ? { password: proxy.password } : {}),
      udp: true,
    })
    clashProxiesNames.push(pname)
    for (const node of topNodes) {
      const viaName = `${node.name} | via-${pi + 1}`
      const base = nodeToClash(node, viaName)
      if (base) {
        base['dialer-proxy'] = pname
        clashProxies.push(base)
        clashProxiesNames.push(viaName)
      }
      chainPairs.push({ nodeName: node.name, proxy })
      injectedCount++
    }
  }

  return { subLines, clashProxies, clashProxiesNames, injectedCount }
}

function setNodeName(line: string, proto: string, name: string): string {
  if (proto === 'vmess') return line // vmess name already inside JSON
  const hashIndex = line.indexOf('#')
  const withoutName = hashIndex > -1 ? line.slice(0, hashIndex) : line
  return `${withoutName}#${encodeURIComponent(name)}`
}

/** Convert a parsed node into a Clash Meta proxy map (or null if unsupported). */
function nodeToClash(node: ParsedNode, name: string, sniOverride?: string): Record<string, unknown> | null {
  const sni = sniOverride ?? node.host
  try {
    if (node.proto === 'vmess') {
      const json = JSON.parse(atob(node.line.slice('vmess://'.length))) as Record<string, unknown>
      const net = String(json.net ?? 'tcp')
      const map: Record<string, unknown> = {
        name, type: 'vmess', server: node.host, port: node.port,
        uuid: String(json.id ?? ''), alterId: Number(json.aid ?? 0), cipher: String(json.scy ?? 'auto'), udp: true,
      }
      if (String(json.tls ?? '') === 'tls') { map.tls = true; map.servername = String(json.sni ?? json.host ?? sni) }
      if (net === 'ws') map['ws-opts'] = { path: String(json.path ?? '/'), headers: { Host: String(json.host ?? sni) } }
      return map
    }
    if (node.proto === 'vless' || node.proto === 'trojan') {
      const hashIndex = node.line.indexOf('#')
      const qIndex = node.line.indexOf('?')
      const authority = node.line.slice(0, qIndex > -1 ? qIndex : (hashIndex > -1 ? hashIndex : node.line.length))
      const userinfo = authority.split('://')[1] ?? ''
      const secret = decodeURIComponent(userinfo.split('@')[0] ?? '')
      const params = new URLSearchParams(qIndex > -1 ? node.line.slice(qIndex + 1, hashIndex > -1 ? hashIndex : undefined) : '')
      const security = params.get('security') ?? (node.proto === 'trojan' ? 'tls' : '')
      const network = params.get('type') ?? 'tcp'
      const map: Record<string, unknown> = {
        name, type: node.proto, server: node.host, port: node.port, udp: true,
      }
      if (node.proto === 'vless') { map.uuid = secret; if (params.get('flow')) map.flow = params.get('flow') }
      else map.password = secret
      if (security === 'tls' || security === 'reality') {
        map.tls = true
        map.servername = params.get('sni') ?? params.get('host') ?? sni
        const fp = params.get('fp')
        if (fp) map['client-fingerprint'] = fp
        if (security === 'reality') {
          map['reality-opts'] = { 'public-key': params.get('pbk') ?? '', 'short-id': params.get('sid') ?? '' }
        }
      }
      if (network === 'ws') {
        map.network = 'ws'
        map['ws-opts'] = {
          path: params.get('path') ?? '/',
          headers: { Host: params.get('host') ?? sni },
        }
      } else if (network === 'grpc') {
        map.network = 'grpc'
        map['grpc-opts'] = { 'grpc-service-name': params.get('serviceName') ?? '' }
      }
      return map
    }
    if (node.proto === 'ss') {
      // SIP002: ss://base64(method:pass)@host:port#name
      const hashIndex = node.line.indexOf('#')
      const qIndex = node.line.indexOf('?')
      const authority = node.line.slice(0, qIndex > -1 ? qIndex : (hashIndex > -1 ? hashIndex : node.line.length))
      const userinfo = authority.split('://')[1] ?? ''
      const at = userinfo.lastIndexOf('@')
      if (at === -1) return null
      let methodPass = ''
      const cred = userinfo.slice(0, at)
      try { methodPass = atob(cred) } catch { methodPass = decodeURIComponent(cred) }
      const sep = methodPass.indexOf(':')
      if (sep === -1) return null
      return {
        name, type: 'ss', server: node.host, port: node.port, udp: true,
        cipher: methodPass.slice(0, sep), password: methodPass.slice(sep + 1),
      }
    }
  } catch {
    return null
  }
  return null
}

// ── Outputs ─────────────────────────────────────────────────────────────

export function buildSubBase64(result: InjectResult): string {
  return b64encodeUtf8(result.subLines.join('\n'))
}

const yamlSafe = (s: string) => JSON.stringify(s)

/** Wrap plain node lines (no injection) into the InjectResult shape so
 *  renderers like buildClashYaml can be reused for any line set. */
export function linesToResult(lines: string[]): InjectResult {
  const clashProxies: Array<Record<string, unknown>> = []
  const clashProxiesNames: string[] = []
  for (const node of lines.map(parseNodeLine).filter((n): n is ParsedNode => n !== null)) {
    const proxy = nodeToClash(node, node.name)
    if (proxy) {
      clashProxies.push(proxy)
      clashProxiesNames.push(node.name)
    }
  }
  return { subLines: lines, clashProxies, clashProxiesNames, injectedCount: 0 }
}

export function buildClashYaml(result: InjectResult): string {
  const lines: string[] = []
  lines.push('# miliconfig — optimized & injected config')
  lines.push('# Generated by miliconfig panel — auto-updates from your workers')
  lines.push('port: 7890')
  lines.push('allow-lan: false')
  lines.push('mode: rule')
  lines.push('log-level: info')
  lines.push('proxies:')
  for (const p of result.clashProxies) {
    lines.push('  - ' + clashInline(p))
  }
  lines.push('proxy-groups:')
  lines.push('  - name: "miliconfig"')
  lines.push('    type: select')
  lines.push('    proxies:')
  for (const n of result.clashProxiesNames) lines.push(`      - ${yamlSafe(n)}`)
  lines.push('rules:')
  lines.push('  - MATCH,miliconfig')
  return lines.join('\n')
}

function clashValue(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v && typeof v === 'object') return clashInline(v as Record<string, unknown>)
  return yamlSafe(String(v))
}

function clashInline(map: Record<string, unknown>): string {
  const parts = Object.entries(map).map(([k, v]) => `${k}: ${clashValue(v)}`)
  return `{ ${parts.join(', ')} }`
}
