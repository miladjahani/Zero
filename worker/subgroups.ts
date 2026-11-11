import type { Env } from './env'
import { apiError, genId, json, nowIso, safeJsonParse } from './util'
import { b64encodeUtf8 } from './net'
import { applyInjection, buildClashYaml, linesToResult, type PreferredIP, type ProxySpec } from './inject'
import { fetchSourceNodes, resolveSource } from './sourcebridge'
import { renderSubscription } from './formats'
import { expandRanges } from './net'
import { extractNodes } from './parser'

// ── Group subscriptions: merge several deployed workers into one sub link ──
// With injection enabled, preferred IPs and HTTP/SOCKS5 chains are applied at
// serve time — so the group sub auto-updates whenever workers or IPs change.

interface GroupBody {
  name?: string
  deployment_ids?: string[]
  ips?: PreferredIP[]
  proxies?: ProxySpec[]
  inject?: boolean
  format?: string
  extra_links?: string[]
}

const FORMATS = ['base64', 'plain', 'clash', 'singbox'] as const
export function sanitizeFormat(v?: string | null): string {
  return (FORMATS as readonly string[]).includes(String(v)) ? String(v) : 'base64'
}

function sanitizeIps(ips?: PreferredIP[]): PreferredIP[] {
  // CIDR ranges (104.16.0.0/30 style) are expanded per-address, capped.
  const out: PreferredIP[] = []
  for (const p of ips ?? []) {
    if (!p || typeof p.ip !== 'string') continue
    const ip = p.ip.trim()
    if (ip.includes('/')) {
      for (const expanded of expandRanges([ip], 40 - out.length)) {
        out.push({ ip: expanded, ...(p.port ? { port: Number(p.port) } : {}) })
        if (out.length >= 40) return out
      }
    } else if (/^(\d{1,3}(\.\d{1,3}){3}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(ip)) {
      out.push({ ip, ...(p.port ? { port: Number(p.port) } : {}) })
    }
  }
  return out.slice(0, 20)
}

function sanitizeProxies(proxies?: ProxySpec[]): ProxySpec[] {
  return (proxies ?? [])
    .filter((p) => p && ['http', 'socks5'].includes(String(p.type)) && p.server && Number(p.port) > 0)
    .slice(0, 5)
    .map((p) => ({
      type: p.type === 'http' ? 'http' as const : 'socks5' as const,
      server: String(p.server),
      port: Number(p.port),
      ...(p.username ? { username: String(p.username) } : {}),
      ...(p.password ? { password: String(p.password) } : {}),
    }))
}

function sanitizeExtraLinks(links?: string[]): string[] {
  return (links ?? [])
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length < 2000)
    .slice(0, 20)
}

export async function handleGroupCreate(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<GroupBody>(await request.text().catch(() => ''), {})
  const name = body.name?.trim() || 'ساب گروهی'
  const ids = (body.deployment_ids ?? []).filter(Boolean).slice(0, 50)
  const extraLinks = sanitizeExtraLinks(body.extra_links)
  if (ids.length === 0 && extraLinks.length === 0) return apiError('حداقل یک ورکر یا یک لینک نود وارد کنید')
  const ips = sanitizeIps(body.ips)
  const proxies = sanitizeProxies(body.proxies)
  const inject = (body.inject && (ips.length > 0 || proxies.length > 0)) ? 1 : 0

  // Only allow workers owned by the user.
  let ownedIds: string[] = []
  if (ids.length > 0) {
    const owned = await env.DB.prepare(
      `SELECT id FROM deployments WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    ).bind(userId, ...ids).all<{ id: string }>()
    ownedIds = owned.results.map((r) => r.id)
  }

  const id = genId()
  const subToken = genId().replace(/-/g, '')
  const format = sanitizeFormat(body.format)
  await env.DB.prepare(
    'INSERT INTO sub_groups (id, user_id, name, deployment_ids, sub_token, ips, proxies, inject, format, extra_links, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, userId, name, JSON.stringify(ownedIds), subToken, JSON.stringify(ips), JSON.stringify(proxies), inject, format, JSON.stringify(extraLinks), nowIso()).run()
  return json({ data: { id, name, sub_token: subToken } }, 201)
}

export async function handleGroupList(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare('SELECT * FROM sub_groups WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all()
  return json({
    data: r.results.map((row) => ({
      ...row,
      deployment_ids: safeJsonParse(row.deployment_ids as string, []),
      ips: safeJsonParse(row.ips as string, []),
      proxies: safeJsonParse(row.proxies as string, []),
      extra_links: safeJsonParse(row.extra_links as string, []),
      inject: !!row.inject,
    })),
  })
}

export async function handleGroupDelete(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM sub_groups WHERE id = ? AND user_id = ? RETURNING name').bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('گروه پیدا نشد', 404)
  return json({ success: true })
}

/** Update a group's injection settings / output format — the sub link stays the same. */
export async function handleGroupPatch(env: Env, userId: string, id: string, request: Request): Promise<Response> {
  const body = safeJsonParse<GroupBody>(await request.text().catch(() => ''), {})
  const existing = await env.DB.prepare('SELECT id, ips, proxies, inject, format, extra_links FROM sub_groups WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .first<{ id: string; ips: string; proxies: string; inject: number; format: string; extra_links: string }>()
  if (!existing) return apiError('گروه پیدا نشد', 404)

  const ips = body.ips !== undefined ? sanitizeIps(body.ips) : safeJsonParse<PreferredIP[]>(existing.ips, [])
  const proxies = body.proxies !== undefined ? sanitizeProxies(body.proxies) : safeJsonParse<ProxySpec[]>(existing.proxies, [])
  const extraLinks = body.extra_links !== undefined ? sanitizeExtraLinks(body.extra_links) : safeJsonParse<string[]>(existing.extra_links, [])
  const format = body.format !== undefined ? sanitizeFormat(body.format) : sanitizeFormat(existing.format)
  const inject = body.inject !== undefined
    ? ((body.inject && (ips.length > 0 || proxies.length > 0)) ? 1 : 0)
    : existing.inject

  await env.DB.prepare('UPDATE sub_groups SET ips = ?, proxies = ?, inject = ?, format = ?, extra_links = ? WHERE id = ?')
    .bind(JSON.stringify(ips), JSON.stringify(proxies), inject, format, JSON.stringify(extraLinks), id)
    .run()
  return json({ data: { id, ips, proxies, inject: !!inject, format, extra_links: extraLinks } })
}

/** Fetch the live subscription content of a single deployed worker (via source bridge). */
async function fetchWorkerSub(env: Env, deploymentId: string): Promise<string[]> {
  const ctx = await resolveSource(env, null, deploymentId).catch(() => null)
  if (!ctx) return []
  const { lines } = await fetchSourceNodes(ctx)
  return lines
}

/** Fetch nodes from an arbitrary subscription URL or raw pasted content.
 * Accepts any format that contains nodes — plain link lists, base64 blobs,
 * sing-box JSON, Clash YAML, HTML with embedded links — via the universal
 * parser engine. */
async function fetchExtraLink(link: string): Promise<string[]> {
  try {
    if (/^https?:\/\//i.test(link)) {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 30_000)
      try {
        const resp = await fetch(link, { redirect: 'follow', signal: ctrl.signal })
        if (!resp.ok) return []
        return extractNodes(await resp.text())
      } finally {
        clearTimeout(t)
      }
    }
    // Raw content pasted directly into the group
    return extractNodes(link)
  } catch {
    return []
  }
}

/** Serialize merged node lines in the requested output format. */
function renderOutput(lines: string[], format: string): Response {
  return renderSubscription(lines, format)
}

/** Public endpoint — GET /api/sub/group/:token[?target=base64|plain|clash|singbox] */
export async function serveGroupSub(env: Env, token: string, target: string | null): Promise<Response> {
  const group = await env.DB.prepare('SELECT deployment_ids, ips, proxies, inject, format, extra_links FROM sub_groups WHERE sub_token = ?')
    .bind(token)
    .first<{ deployment_ids: string; ips: string; proxies: string; inject: number; format: string | null; extra_links: string | null }>()
  if (!group) return new Response('گروه یافت نشد', { status: 404 })
  const ids = safeJsonParse<string[]>(group.deployment_ids, [])
  const extraLinks = safeJsonParse<string[]>(group.extra_links ?? '[]', [])
  if (!ids.length && !extraLinks.length) return new Response('گروه خالی است', { status: 404 })

  const deps = ids.length > 0
    ? await env.DB.prepare(
        `SELECT id, user_id FROM deployments
         WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'deployed'`,
      ).bind(...ids).all<{ id: string; user_id: string }>()
    : { results: [] as { id: string; user_id: string }[] }

  const seen = new Set<string>()
  const merged: string[] = []
  const chunks = [...deps.results.map((d) => fetchWorkerSub(env, d.id)), ...extraLinks.map((l) => fetchExtraLink(l))]
  const all = (await Promise.allSettled(chunks)).flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  for (const line of all) {
    // Dedupe by node identity (scheme+credentials+host+port+params), ignoring
    // the display name — so re-injected variants don't pile up.
    const identity = line.replace(/#.*$/, '')
    if (!seen.has(identity)) {
      seen.add(identity)
      merged.push(line)
    }
  }

  // Collapse prior injection variants (names like "X | miliconfig-1.2.3.4")
  // back to their base nodes, so a fresh injection doesn't multiply them.
  const baseByName = new Map<string, string>()
  for (const line of merged) {
    const m = line.match(/^([^#]+)#(.*)$/)
    const name = m ? decodeURIComponent(m[2]) : ''
    const baseName = name.split(' | miliconfig-')[0].trim()
    if (!baseByName.has(baseName) || !name.includes(' | miliconfig-')) {
      baseByName.set(baseName, line)
    }
  }
  const baseLines = merged.length && baseByName.size ? [...baseByName.values()] : merged
  if (!merged.length) return new Response('هیچ کانفیگی از ورکرهای گروه دریافت نشد', { status: 502 })

  // Injection is applied at serve time → the link auto-updates with the
  // current workers content and the group's saved IP/proxy settings.
  // Output format: query param wins over the group's saved default.
  const format = sanitizeFormat(target ?? group.format)
  if (group.inject) {
    const result = applyInjection(baseLines, safeJsonParse<PreferredIP[]>(group.ips, []), safeJsonParse<ProxySpec[]>(group.proxies, []))
    if (format === 'clash') {
      return new Response(buildClashYaml(result), {
        headers: { 'Content-Type': 'text/yaml; charset=utf-8', 'profile-update-interval': '1' },
      })
    }
    return renderOutput(result.subLines, format)
  }

  return renderOutput(merged, format)
}
