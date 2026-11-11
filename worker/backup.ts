// Full JSON backup export/import for both individual users (/api/backup)
// and the platform administrator (/api/admin/backup).

import type { Env } from './env'
import { apiError, genId, json, nowIso } from './util'

interface BackupMember {
  deployment_ref: { id: string; name: string }
  name: string
  token: string
  enabled: number
  expires_at: string | null
  quota_bytes: number | null
  request_quota: number | null
  ip_limit: number | null
  start_on_connect: number
  reset_period_days: number | null
  settings: Record<string, unknown>
}

interface BackupInjector {
  name: string
  source: string
  ips: string[]
  proxies: unknown[]
  sub_token: string
  rotate_minutes: number | null
}

interface BackupGroup {
  name: string
  deployment_refs: { id: string; name: string }[]
  sub_token: string
  inject?: number
  ips?: string[]
  proxies?: unknown[]
  format?: string
  extra_links?: string[]
}

interface BackupDeployment {
  id: string
  name: string
  worker_url?: string | null
  panel_url?: string | null
  sub_url?: string | null
  uuid?: string | null
  custom_path?: string | null
  admin_password?: string | null
  worker_source?: string | null
  method?: string | null
  proxyip?: string | null
  status?: string | null
  config?: Record<string, unknown>
}

interface BackupToken {
  name: string
  token: string
  status?: string
}

function safeObj(v: unknown): Record<string, unknown> {
  try { return typeof v === 'string' ? JSON.parse(v) : (v as Record<string, unknown>) ?? {} } catch { return {} }
}
function safeArr(v: unknown): unknown[] {
  try { return typeof v === 'string' ? JSON.parse(v) : Array.isArray(v) ? v : [] } catch { return [] }
}

export async function exportBackup(env: Env, userId: string): Promise<Response> {
  const [userRow, tokens, deps, members, injectors, groups, optimizers] = await Promise.all([
    env.DB.prepare(`SELECT id, email, role, max_deployments, created_at FROM users WHERE id = ?`).bind(userId).first<Record<string, unknown>>().catch(() => null),
    env.DB.prepare(`SELECT name, token, status, created_at FROM cf_tokens WHERE user_id = ? ORDER BY created_at`).bind(userId).all<Record<string, unknown>>().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM deployments WHERE user_id = ? ORDER BY created_at`).bind(userId).all<Record<string, unknown>>().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM worker_members WHERE owner_user_id = ? ORDER BY created_at`).bind(userId).all<Record<string, unknown>>().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT name, source, ips, proxies, sub_token, rotate_minutes FROM injector_jobs WHERE user_id = ? ORDER BY created_at`).bind(userId).all<{ name: string; source: string; ips: string; proxies: string; sub_token: string; rotate_minutes: number | null }>().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM sub_groups WHERE user_id = ? ORDER BY created_at`).bind(userId).all<Record<string, unknown>>().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM optimizer_configs WHERE user_id = ? ORDER BY created_at`).bind(userId).all<Record<string, unknown>>().catch(() => ({ results: [] })),
  ])

  const depById = new Map((deps.results ?? []).map((d) => [String(d.id), { id: String(d.id), name: String(d.name ?? '') }]))

  const payload = {
    app: 'miliconfig',
    scope: 'user',
    version: 2,
    exported_at: nowIso(),
    profile: userRow ?? { id: userId },
    tokens: (tokens.results ?? []).map((t) => ({
      name: String(t.name ?? ''),
      token: String(t.token ?? ''),
      status: String(t.status ?? 'active'),
    })),
    deployments: (deps.results ?? []).map((d) => ({
      id: String(d.id ?? ''),
      name: String(d.name ?? ''),
      worker_url: (d.worker_url as string | null) ?? null,
      panel_url: (d.panel_url as string | null) ?? null,
      sub_url: (d.sub_url as string | null) ?? null,
      uuid: (d.uuid as string | null) ?? null,
      custom_path: (d.custom_path as string | null) ?? null,
      admin_password: (d.admin_password as string | null) ?? null,
      worker_source: (d.worker_source as string | null) ?? null,
      method: (d.method as string | null) ?? 'workers',
      proxyip: (d.proxyip as string | null) ?? null,
      status: (d.status as string | null) ?? 'deployed',
      config: safeObj(d.config),
    })) as BackupDeployment[],
    members: (members.results ?? []).map((m) => {
      const dep = depById.get(String(m.deployment_id))
      return {
        deployment_ref: dep ? { id: dep.id, name: dep.name } : { id: '', name: String(m.deployment_id) },
        name: m.name,
        token: m.token,
        enabled: m.enabled,
        expires_at: m.expires_at,
        quota_bytes: m.quota_bytes,
        request_quota: m.request_quota,
        ip_limit: m.ip_limit,
        start_on_connect: m.start_on_connect,
        reset_period_days: m.reset_period_days,
        settings: safeObj(m.settings),
      }
    }) as BackupMember[],
    injectors: (injectors.results ?? []).map((j) => ({
      name: j.name,
      source: j.source,
      ips: safeArr(j.ips),
      proxies: safeArr(j.proxies),
      sub_token: j.sub_token,
      rotate_minutes: j.rotate_minutes,
    })) as BackupInjector[],
    groups: (groups.results ?? []).map((g) => {
      const ids = safeArr(g.deployment_ids) as string[]
      return {
        name: g.name,
        deployment_refs: ids.map((id) => {
          const d = depById.get(id)
          return d ? { id: d.id, name: d.name } : { id, name: id }
        }),
        sub_token: g.sub_token,
        inject: g.inject as number | undefined,
        ips: safeArr(g.ips as string),
        proxies: safeArr(g.proxies as string),
        format: (g.format as string | null) ?? 'base64',
        extra_links: safeArr(g.extra_links as string) as string[],
      }
    }) as BackupGroup[],
    optimizers: optimizers.results ?? [],
  }

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="miliconfig-backup-${nowIso().slice(0, 10)}.json"`,
    },
  })
}

export async function importBackup(env: Env, userId: string, request: Request): Promise<Response> {
  let body: {
    tokens?: BackupToken[]
    deployments?: BackupDeployment[]
    members?: BackupMember[]
    injectors?: BackupInjector[]
    groups?: BackupGroup[]
    mode?: 'merge' | 'replace'
  }
  try { body = await request.json() } catch { return apiError('JSON نامعتبر است', 400) }
  const mode = body.mode === 'replace' ? 'replace' : 'merge'

  if (mode === 'replace') {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM worker_members WHERE owner_user_id = ?`).bind(userId),
      env.DB.prepare(`DELETE FROM injector_jobs WHERE user_id = ?`).bind(userId),
      env.DB.prepare(`DELETE FROM sub_groups WHERE user_id = ?`).bind(userId),
    ])
  }

  // 1. Restore Cloudflare API tokens if included
  let addedTokens = 0
  for (const t of body.tokens ?? []) {
    if (!t.name || !t.token) continue
    const exists = await env.DB.prepare(`SELECT 1 FROM cf_tokens WHERE user_id = ? AND token = ?`).bind(userId, t.token).first().catch(() => null)
    if (exists) continue
    await env.DB.prepare(
      `INSERT INTO cf_tokens (id, user_id, name, token, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(genId(), userId, t.name, t.token, t.status || 'active', nowIso()).run().catch(() => null)
    addedTokens++
  }

  // 2. Restore deployment records if included so members/groups can attach even on a fresh DB
  let addedDeployments = 0
  for (const d of body.deployments ?? []) {
    if (!d.name) continue
    const existing = await env.DB.prepare(`SELECT id FROM deployments WHERE user_id = ? AND (id = ? OR lower(name) = lower(?))`).bind(userId, d.id || '', d.name).first().catch(() => null)
    if (existing) continue
    const depId = d.id || genId()
    await env.DB.prepare(
      `INSERT INTO deployments (id, user_id, name, worker_url, panel_url, sub_url, uuid, custom_path, admin_password, worker_source, method, proxyip, status, config, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)`
    ).bind(
      depId, userId, d.name, d.worker_url ?? null, d.panel_url ?? null, d.sub_url ?? null,
      d.uuid ?? crypto.randomUUID(), d.custom_path ?? null, d.admin_password ?? null,
      d.worker_source ?? 'milios', d.method ?? 'workers', d.proxyip ?? null,
      d.status ?? 'deployed', JSON.stringify(d.config ?? {}), nowIso()
    ).run().catch(() => null)
    addedDeployments++
  }

  const deps = await env.DB.prepare(`SELECT id, name FROM deployments WHERE user_id = ?`)
    .bind(userId).all<{ id: string; name: string }>()
  const depByName = new Map((deps.results ?? []).map((d) => [d.name.toLowerCase(), d.id]))
  const depById = new Set((deps.results ?? []).map((d) => d.id))

  let addedMembers = 0, skippedMembers = 0
  for (const m of body.members ?? []) {
    const depId = m.deployment_ref && depById.has(m.deployment_ref.id)
      ? m.deployment_ref.id
      : depByName.get((m.deployment_ref?.name ?? '').toLowerCase())
    if (!depId) { skippedMembers++; continue }
    const exists = await env.DB.prepare(`SELECT 1 FROM worker_members WHERE token = ?`).bind(m.token).first()
    if (exists) { skippedMembers++; continue }
    await env.DB.prepare(
      `INSERT INTO worker_members (id, owner_user_id, deployment_id, name, token, enabled, expires_at, quota_bytes, request_quota, ip_limit, start_on_connect, reset_period_days, settings, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    ).bind(
      crypto.randomUUID().replaceAll('-', ''), userId, depId, m.name, m.token,
      m.enabled === 0 ? 0 : 1, m.expires_at ?? null, m.quota_bytes ?? null,
      m.request_quota ?? null, m.ip_limit ?? null, m.start_on_connect ? 1 : 0,
      m.reset_period_days ?? null, JSON.stringify(m.settings ?? {}), nowIso(),
    ).run()
    addedMembers++
  }

  let addedInjectors = 0, skippedInjectors = 0
  for (const j of body.injectors ?? []) {
    const exists = await env.DB.prepare(`SELECT 1 FROM injector_jobs WHERE sub_token = ?`).bind(j.sub_token).first()
    if (exists) { skippedInjectors++; continue }
    await env.DB.prepare(
      `INSERT INTO injector_jobs (id, user_id, name, source, ips, proxies, sub_token, rotate_minutes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
    ).bind(crypto.randomUUID().replaceAll('-', ''), userId, j.name, j.source || 'custom',
      JSON.stringify(j.ips ?? []), JSON.stringify(j.proxies ?? []), j.sub_token, j.rotate_minutes ?? null, nowIso()).run()
    addedInjectors++
  }

  let addedGroups = 0, skippedGroups = 0
  for (const g of body.groups ?? []) {
    const ids = (g.deployment_refs ?? [])
      .map((r) => (depById.has(r.id) ? r.id : depByName.get(r.name.toLowerCase())))
      .filter((x): x is string => !!x)
    if (ids.length === 0 && (g.deployment_refs ?? []).length > 0) { skippedGroups++; continue }
    const exists = await env.DB.prepare(`SELECT 1 FROM sub_groups WHERE sub_token = ?`).bind(g.sub_token).first()
    if (exists) { skippedGroups++; continue }
    await env.DB.prepare(
      `INSERT INTO sub_groups (id, user_id, name, deployment_ids, sub_token, inject, ips, proxies, format, extra_links, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 0), COALESCE(?7, '[]'), COALESCE(?8, '[]'), COALESCE(?9, 'base64'), COALESCE(?10, '[]'), ?11)`
    ).bind(crypto.randomUUID().replaceAll('-', ''), userId, g.name, JSON.stringify(ids), g.sub_token,
      g.inject ?? 0, JSON.stringify(g.ips ?? []), JSON.stringify(g.proxies ?? []),
      g.format ?? null, g.extra_links ? JSON.stringify(g.extra_links) : null, nowIso()).run()
    addedGroups++
  }

  return json({
    ok: true,
    mode,
    tokens_added: addedTokens,
    deployments_added: addedDeployments,
    members_added: addedMembers,
    members_skipped: skippedMembers,
    injectors_added: addedInjectors,
    injectors_skipped: skippedInjectors,
    groups_added: addedGroups,
    groups_skipped: skippedGroups,
  })
}

/**
 * Full platform-wide backup for the Administrator (/api/admin/backup).
 * Exports all users, tokens, deployments, worker_members, sub_groups,
 * injector_jobs, bot_config, bot_users, bot_tenants, and panel_settings.
 */
export async function exportAdminBackup(env: Env): Promise<Response> {
  const [
    users,
    cfTokens,
    deployments,
    workerMembers,
    subGroups,
    injectorJobs,
    optimizerConfigs,
    botConfig,
    botUsers,
    botTenants,
    railwayTokens,
    renderTokens,
    panelDeploys,
  ] = await Promise.all([
    env.DB.prepare(`SELECT * FROM users ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM cf_tokens ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM deployments ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM worker_members ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM sub_groups ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM injector_jobs ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM optimizer_configs ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM bot_config ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM bot_users ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM bot_tenants ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM railway_tokens ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM render_tokens ORDER BY created_at`).all().catch(() => ({ results: [] })),
    env.DB.prepare(`SELECT * FROM panel_deploys ORDER BY created_at`).all().catch(() => ({ results: [] })),
  ])

  const payload = {
    app: 'miliconfig-admin-full',
    scope: 'admin',
    version: 2,
    exported_at: nowIso(),
    tables: {
      users: users.results ?? [],
      cf_tokens: cfTokens.results ?? [],
      deployments: deployments.results ?? [],
      worker_members: workerMembers.results ?? [],
      sub_groups: subGroups.results ?? [],
      injector_jobs: injectorJobs.results ?? [],
      optimizer_configs: optimizerConfigs.results ?? [],
      bot_config: botConfig.results ?? [],
      bot_users: botUsers.results ?? [],
      bot_tenants: botTenants.results ?? [],
      railway_tokens: railwayTokens.results ?? [],
      render_tokens: renderTokens.results ?? [],
      panel_deploys: panelDeploys.results ?? [],
    },
  }

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="miliconfig-admin-full-backup-${nowIso().slice(0, 10)}.json"`,
    },
  })
}

export async function importAdminBackup(env: Env, request: Request): Promise<Response> {
  let body: {
    scope?: string
    mode?: 'merge' | 'replace'
    tables?: Record<string, Record<string, unknown>[]>
  }
  try { body = await request.json() } catch { return apiError('JSON نامعتبر است', 400) }
  const tables = body?.tables
  if (!tables || typeof tables !== 'object') {
    return apiError('ساختار فایل بکاپ ادمین معتبر نیست (فیلد tables یافت نشد)', 400)
  }

  const counts: Record<string, number> = {}
  const allowedTables = [
    'users',
    'cf_tokens',
    'deployments',
    'worker_members',
    'sub_groups',
    'injector_jobs',
    'optimizer_configs',
    'bot_config',
    'bot_users',
    'bot_tenants',
    'railway_tokens',
    'render_tokens',
    'panel_deploys',
  ]

  for (const table of allowedTables) {
    const rows = Array.isArray(tables[table]) ? tables[table] : []
    counts[table] = 0
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const cols = Object.keys(row).filter((k) => /^[a-zA-Z0-9_]+$/.test(k))
      if (!cols.length) continue
      const placeholders = cols.map((_, idx) => `?${idx + 1}`).join(', ')
      const values = cols.map((c) => {
        const v = row[c]
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : (v ?? null)
      })
      const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`
      const ok = await env.DB.prepare(sql).bind(...values).run().then(() => true).catch(() => false)
      if (ok) counts[table]++
    }
  }

  return json({
    ok: true,
    restored: counts,
    message: 'بکاپ جامع ادمین با موفقیت در دیتابیس بازیابی شد',
  })
}
