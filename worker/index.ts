import type { Env } from './env'
import { apiError, json, getUserFromRequest, logActivity, genId, nowIso, safeJsonParse } from './util'
import { handleSignup, handleLogin, handleLogout, handleMe, handleTelegramLogin, isOwner } from './auth'
import { reapStaleDeployments, startDeployment, verifyAndHeal } from './deploy'
import { handleDeploymentUpdate } from './update'
import { verifyRailwayToken, RailwayApiError } from './railway'
import { verifyRenderToken, RenderApiError } from './render'
import {
  startPanelDeploy,
  watchPanelDeploy,
  listPanelDeploys,
  forgetPanelDeploy,
  probePanelHealth,
  updatePanelDeploy,
  updatePanelSettings,
  setPanelAutoUpdate,
  fetchLatestPanelVersion,
  autoUpdatePanels,
  type PanelSettingsPatch,
} from './panel-deploy'
import { handleWorkerConfig } from './kvconfig'
import { handleIpScanner, handleRangeScan } from './scanner'
import { handleTelegramWebhook } from './telegram'
import { panelAppUrl, sendMsg, syncBotProfile } from './telegram-core'
import { ensureSchema } from './schema'
import { dbHealth, isDbLimitError } from './db'
import { maybeRunMaintenance, runDbMaintenance } from './db-maintenance'
import { setPanelSource, syncPanelSource } from './panel-source'
import { handleOptimizerCreate, handleOptimizerList, handleOptimizerGet, handleOptimizerDelete, serveOptimizerSub } from './optimizer'
import { handleOptProbe, handleOptPorts, handleOptScanBatch, handleOptSpeedtest } from './probe'
import { handleGroupCreate, handleGroupList, handleGroupDelete, handleGroupPatch, serveGroupSub } from './subgroups'
import { handleInjectorCreate, handleInjectorList, handleInjectorPatch, handleInjectorDelete, serveInjectedSub } from './injector'
import { handleMemberCreate, handleMemberCreateMany, handleMemberList, handleMemberPatch, handleMemberDelete, handleMemberBulk, handleCfQuota, refreshMemberUsage, serveMemberSub, handleMemberTest } from './members'
import { serveStatusPage, serveMemberBackup } from './status'
import { exportBackup, importBackup, exportAdminBackup, importAdminBackup } from './backup'
import { handleSourceSettings, handleSourceNodes } from './sourcebridge'
import { DEFAULT_PANEL_REPO, DEFAULT_RAILWAY_REGION, panelTcpPorts, railwayRegionLabel, resolvePanel } from '../shared/panels'

interface DeploymentBody {
  name?: string
  uuid?: string
  custom_path?: string
  method?: 'workers' | 'pages'
  worker_source?: string
  /** "Deploy from any GitHub repository" — the URL pasted in the wizard. */
  source_url?: string
  /** Storage to create for a GitHub source (opt-in; nothing by default). */
  bindings?: { kv?: boolean; d1?: boolean }
  proxyip?: string
  admin_password?: string
  cf_token_id?: string
}

async function requireUser(env: Env, request: Request) {
  return getUserFromRequest(env, request)
}

// ── Tokens ─────────────────────────────────────────────────────────────────

async function listTokens(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare('SELECT * FROM cf_tokens WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all()
  return json({ data: r.results })
}

async function createToken(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ name?: string; token?: string }>(await request.text().catch(() => ''), {})
  if (!body.name?.trim() || !body.token?.trim()) return apiError('نام و توکن الزامی است')
  const id = genId()
  await env.DB.prepare("INSERT INTO cf_tokens (id, user_id, name, token, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
    .bind(id, userId, body.name.trim(), body.token.trim(), nowIso())
    .run()
  await logActivity(env, userId, 'token_created', 'token', body.name.trim())
  return json({ data: { id, user_id: userId, name: body.name.trim(), token: body.token.trim(), status: 'active', created_at: nowIso() } }, 201)
}

async function deleteToken(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM cf_tokens WHERE id = ? AND user_id = ? RETURNING name').bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('توکن پیدا نشد', 404)
  await logActivity(env, userId, 'token_deleted', 'token', row.name)
  return json({ success: true })
}

// ── Railway tokens & auto-deploy ────────────────────────────────────────────

// Railway tokens are write-once secrets: after a successful save we never return
// the raw token to the browser again — the UI only sees the last 4 characters.

async function listRailwayTokens(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT id, name, status, account_name, last_used_at, created_at, substr(token, -4) AS token_tail
     FROM railway_tokens WHERE user_id = ? ORDER BY created_at DESC`,
  ).bind(userId).all()
  return json({ data: r.results })
}

async function createRailwayToken(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ name?: string; token?: string }>(await request.text().catch(() => ''), {})
  if (!body.name?.trim() || !body.token?.trim()) return apiError('نام و توکن الزامی است')

  // Validate the token against Railway before storing anything.
  let account: { name: string; email: string }
  try {
    account = await verifyRailwayToken(body.token.trim())
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'توکن Railway نامعتبر است', 400)
  }

  const id = genId()
  const accountName = account.email || account.name || null
  await env.DB.prepare(
    `INSERT INTO railway_tokens (id, user_id, name, token, status, account_name, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(id, userId, body.name.trim(), body.token.trim(), accountName, nowIso())
    .run()
  await logActivity(env, userId, 'railway_token_created', 'token', body.name.trim())
  return json(
    {
      data: {
        id,
        name: body.name.trim(),
        status: 'active',
        account_name: accountName,
        token_tail: body.token.trim().slice(-4),
        last_used_at: null,
        created_at: nowIso(),
      },
    },
    201,
  )
}

async function deleteRailwayToken(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM railway_tokens WHERE id = ? AND user_id = ? RETURNING name').bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('توکن پیدا نشد', 404)
  await logActivity(env, userId, 'railway_token_deleted', 'token', row.name)
  return json({ success: true })
}

async function loadRailwayToken(env: Env, userId: string, id: string): Promise<{ id: string; token: string; name: string } | null> {
  return env.DB.prepare("SELECT id, token, name FROM railway_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
    .bind(id, userId)
    .first<{ id: string; token: string; name: string }>()
}

/** Auto-deploy a catalog panel to Railway: create project + service, start deploy. */
async function handleRailwayDeploy(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ token_id?: string; name?: string; region?: string; panel?: string }>(await request.text().catch(() => ''), {})
  // Same validation + creation path the Telegram bot uses (worker/panel-deploy.ts).
  const started = await startPanelDeploy(env, {
    userId,
    tokenId: body.token_id ?? '',
    name: body.name ?? '',
    panel: resolvePanel(body.panel),
    region: body.region,
  })
  if (!started.ok) return apiError(started.error, 400)
  const panel = resolvePanel(body.panel)
  return json({
    data: {
      deploymentId: started.id,
      projectId: started.projectId ?? started.id,
      projectUrl: started.dashboardUrl,
      domain: started.domain,
      panel: panel.id,
      panel_name: panel.name,
      panel_path: panel.panelPath,
      // The unique name this deployment got (may carry a suffix when the
      // requested name was already used by another deployment).
      project_name: started.projectName,
      // This deployment's own credentials — returned exactly once, here.
      admin_username: started.adminUsername,
      admin_password: started.adminPassword,
      // The region Railway confirmed — the wizard shows this instead of assuming
      // the requested one was accepted.
      region: started.region ?? DEFAULT_RAILWAY_REGION,
      region_label: railwayRegionLabel(started.region ?? DEFAULT_RAILWAY_REGION),
    },
  })
}

// ── Hosted panel registry (the dedicated catalog panel) ──────────────────────

/**
 * The catalog panel plus every deployment of it this user owns.
 *
 * One request feeds the whole "پنل اختصاصی ما" surface: the dashboard card,
 * the panels tab and the bot all read this shape, so the spec (path, health
 * path, port, volume) and the deployments can never disagree.
 */
async function handlePanelList(env: Env, userId: string, origin: string): Promise<Response> {
  const panel = resolvePanel(undefined)
  // The upstream revision is a cached, best-effort hint (GitHub can be slow or
  // rate limited), so it never blocks or fails the panel list itself.
  const [deploys, latestVersion] = await Promise.all([
    listPanelDeploys(env, userId),
    fetchLatestPanelVersion(panel).catch(() => null),
  ])
  return json({
    data: {
      panel: {
        id: panel.id,
        name: panel.name,
        tagline: panel.tagline,
        repo: panel.repo,
        repoUrl: panel.url,
        defaultRepo: DEFAULT_PANEL_REPO,
        port: panel.port,
        extraPorts: panel.extraPorts ?? [],
        tcpPorts: panelTcpPorts(panel),
        panelPath: panel.panelPath,
        healthPath: panel.healthPath ?? panel.panelPath,
        origin: panel.origin ?? null,
        targets: panel.targets,
        dataVolume: panel.dataVolume ?? null,
        notes: panel.notes ?? null,
        lastCommit: panel.lastCommit ?? null,
        verifiedAt: panel.verifiedAt ?? null,
      },
      deploys,
      origin,
      latestVersion,
    },
  })
}

/**
 * Repoint the dedicated panel at a different source repository.
 *
 * The panel's address can change at any time, so it is stored in D1 instead of
 * being baked into the catalog. Every path — Railway, Render, the VPS package,
 * the upstream version probe, the Telegram bot and the web UI — reads the same
 * override, so one save here moves the whole installation.
 */
async function handlePanelRepo(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ repo?: string }>(await request.text().catch(() => ''), {})
  const repo = await setPanelSource(env, body.repo ?? '')
  if (!repo) {
    return apiError('آدرس مخزن معتبر نیست — قالب باید owner/name باشد (مثلاً miliopi/Lalaland)', 400)
  }
  await logActivity(env, userId, 'panel_repo_changed', 'panel', repo)
  return json({ data: { repo, defaultRepo: DEFAULT_PANEL_REPO, changed: repo !== DEFAULT_PANEL_REPO } })
}

/** Poll one hosted panel; the live transition bootstraps its admin once. */
async function handlePanelWatch(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ platform?: string; id?: string }>(await request.text().catch(() => ''), {})
  const platform = panelPlatformOf(body.platform)
  if (!platform || !body.id) return apiError('پلتفرم و شناسهٔ استقرار الزامی است')
  return json({ data: await watchPanelDeploy(env, userId, platform, body.id) })
}

/** Health-probe a hosted panel from the edge (URL comes from our own record). */
async function handlePanelHealth(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ platform?: string; id?: string }>(await request.text().catch(() => ''), {})
  const platform = panelPlatformOf(body.platform)
  if (!platform || !body.id) return apiError('پلتفرم و شناسهٔ استقرار الزامی است')
  return json({ data: await probePanelHealth(env, userId, platform, body.id) })
}

/** Forget a panel record (the service itself keeps running on the platform). */
async function handlePanelForget(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ platform?: string; id?: string }>(await request.text().catch(() => ''), {})
  const platform = panelPlatformOf(body.platform)
  if (!platform || !body.id) return apiError('پلتفرم و شناسهٔ استقرار الزامی است')
  const forgotten = await forgetPanelDeploy(env, userId, platform, body.id)
  if (!forgotten.ok) return apiError(forgotten.error, 404)
  return json({ success: true })
}

/**
 * Rebuild a hosted panel from the newest upstream commit — "بروزرسانی به آخرین
 * نسخه". The panel keeps its domain, volume and admin credentials; only the
 * code moves to the latest release.
 */
async function handlePanelUpdate(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ platform?: string; id?: string }>(await request.text().catch(() => ''), {})
  const platform = panelPlatformOf(body.platform)
  if (!platform || !body.id) return apiError('پلتفرم و شناسهٔ استقرار الزامی است')
  const updated = await updatePanelDeploy(env, userId, platform, body.id)
  if (!updated.ok) return apiError(updated.error, 400)
  return json({ data: updated })
}

/**
 * Change a running panel's platform settings — region, Serverless, outbound
 * IPv6 and CDN caching. Returns the refreshed registry so the card in the UI
 * updates from the server instead of guessing.
 */
async function handlePanelSettings(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{
    platform?: string
    id?: string
    region?: string
    sleepApplication?: boolean
    ipv6Egress?: boolean
    cdnEnabled?: boolean
  }>(await request.text().catch(() => ''), {})
  const platform = panelPlatformOf(body.platform)
  if (!platform || !body.id) return apiError('پلتفرم و شناسهٔ استقرار الزامی است')
  const patch: PanelSettingsPatch = {}
  if (typeof body.region === 'string') patch.region = body.region
  if (typeof body.sleepApplication === 'boolean') patch.sleepApplication = body.sleepApplication
  if (typeof body.ipv6Egress === 'boolean') patch.ipv6Egress = body.ipv6Egress
  if (typeof body.cdnEnabled === 'boolean') patch.cdnEnabled = body.cdnEnabled
  if (!Object.keys(patch).length) return apiError('تنظیمی برای تغییر ارسال نشده')
  const result = await updatePanelSettings(env, userId, platform, body.id, patch)
  if (!result.ok) return apiError(result.error, 400)
  return json({
    data: {
      deploys: await listPanelDeploys(env, userId),
      // What Railway actually reports now, plus any non-fatal caveat (a region
      // that was recorded but could not be taken live yet).
      region: result.region,
      region_label: railwayRegionLabel(result.region),
      redeployId: result.redeployId,
      warning: result.warning,
    },
  })
}

/** Opt one hosted panel into (or out of) the scheduled latest-version sweep. */
async function handlePanelAutoUpdate(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ platform?: string; id?: string; enabled?: boolean }>(await request.text().catch(() => ''), {})
  const platform = panelPlatformOf(body.platform)
  if (!platform || !body.id) return apiError('پلتفرم و شناسهٔ استقرار الزامی است')
  const result = await setPanelAutoUpdate(env, userId, platform, body.id, body.enabled !== false)
  if (!result.ok) return apiError(result.error, 404)
  return json({ data: result })
}

/** Narrow a request field to a supported deployment platform. */
function panelPlatformOf(value?: string): 'railway' | 'render' | null {
  return value === 'railway' || value === 'render' ? value : null
}

// ── Render.com tokens & auto-deploy ──────────────────────────────────────────

async function listRenderTokens(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT id, name, status, account_name, last_used_at, created_at, substr(token, -4) AS token_tail
     FROM render_tokens WHERE user_id = ? ORDER BY created_at DESC`,
  ).bind(userId).all()
  return json({ data: r.results })
}

async function createRenderToken(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ name?: string; token?: string }>(await request.text().catch(() => ''), {})
  if (!body.name?.trim() || !body.token?.trim()) return apiError('نام و کلید الزامی است')

  let account: { name: string; email: string }
  try {
    account = await verifyRenderToken(body.token.trim())
  } catch (err) {
    return apiError(err instanceof Error ? err.message : 'کلید API رندر نامعتبر است', 400)
  }

  const id = genId()
  const accountName = account.email || account.name || null
  await env.DB.prepare(
    `INSERT INTO render_tokens (id, user_id, name, token, status, account_name, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(id, userId, body.name.trim(), body.token.trim(), accountName, nowIso())
    .run()
  await logActivity(env, userId, 'render_token_created', 'token', body.name.trim())
  return json(
    {
      data: {
        id,
        name: body.name.trim(),
        status: 'active',
        account_name: accountName,
        token_tail: body.token.trim().slice(-4),
        last_used_at: null,
        created_at: nowIso(),
      },
    },
    201,
  )
}

async function deleteRenderToken(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM render_tokens WHERE id = ? AND user_id = ? RETURNING name').bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('توکن پیدا نشد', 404)
  await logActivity(env, userId, 'render_token_deleted', 'token', row.name)
  return json({ success: true })
}

async function loadRenderToken(env: Env, userId: string, id: string): Promise<{ id: string; token: string; name: string } | null> {
  return env.DB.prepare("SELECT id, token, name FROM render_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
    .bind(id, userId)
    .first<{ id: string; token: string; name: string }>()
}

/** Auto-deploy a catalog panel to Render.com: create Blueprint service, start deploy. */
async function handleRenderDeploy(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ token_id?: string; name?: string; panel?: string }>(await request.text().catch(() => ''), {})
  // Same validation + creation path the Telegram bot uses (worker/panel-deploy.ts).
  const started = await startPanelDeploy(env, {
    userId,
    tokenId: body.token_id ?? '',
    name: body.name ?? '',
    panel: resolvePanel(body.panel),
  })
  if (!started.ok) return apiError(started.error, 400)
  const panel = resolvePanel(body.panel)
  return json({
    data: {
      deployId: started.id,
      serviceId: started.serviceId,
      dashboardUrl: started.dashboardUrl,
      panel: panel.id,
      panel_name: panel.name,
      panel_path: panel.panelPath,
      project_name: started.projectName,
      admin_username: started.adminUsername,
      admin_password: started.adminPassword,
    },
  })
}

/** Poll the status of a Render deployment that handleRenderDeploy started. */
async function handleRenderStatus(env: Env, userId: string, url: URL): Promise<Response> {
  const deployId = url.searchParams.get('deploy_id') ?? ''
  if (!deployId) return apiError('شناسه استقرار ناقص است')
  // Same lifecycle the Telegram bot uses (worker/panel-deploy.ts): on the live
  // transition the panel admin is bootstrapped once and the owner is notified.
  const watched = await watchPanelDeploy(env, userId, 'render', deployId)
  if (watched.state === 'failed') return apiError(`استقرار ناموفق بود (${watched.status})`, 400)
  return json({
    data: {
      status: watched.state === 'live' ? 'LIVE' : watched.status,
      url: watched.url,
      setup_done: watched.state === 'live' ? true : undefined,
    },
  })
}

/** Poll the status of a Railway deployment that handleRailwayDeploy started. */
async function handleRailwayStatus(env: Env, userId: string, url: URL): Promise<Response> {
  const deploymentId = url.searchParams.get('deployment_id') ?? ''
  if (!deploymentId) return apiError('شناسه استقرار ناقص است')
  // Same lifecycle the Telegram bot uses (worker/panel-deploy.ts): on the live
  // transition the panel admin is bootstrapped once and the owner is notified.
  const watched = await watchPanelDeploy(env, userId, 'railway', deploymentId)
  if (watched.state === 'failed') return apiError(`استقرار ناموفق بود (${watched.status})`, 400)
  return json({
    data: {
      status: watched.state === 'live' ? 'SUCCESS' : watched.status,
      url: watched.url,
      setup_done: watched.state === 'live' ? true : undefined,
    },
  })
}

// ── Deployments ────────────────────────────────────────────────────────────

/**
 * Shape a `deployments` row for the API.
 *
 * `sub_url` is computed on the fly when it is missing, so deployments created
 * before the source-specific link was stored still get a working sub link
 * instead of the UI guessing a path that 404s. The value persisted at deploy
 * time always wins when present.
 */
function parseDeploymentRow(row: Record<string, unknown>): Record<string, unknown> {
  const config = safeJsonParse<Record<string, unknown>>(row.config as string, {})
  return {
    ...row,
    config,
    sub_url: row.sub_url ?? deploymentSubUrl({
      workerUrl: row.worker_url as string | null,
      uuid: row.uuid as string | null,
      source: String(row.worker_source ?? config.worker_source ?? 'edgetunnel'),
    }),
  }
}

/**
 * The subscription link for a Cloudflare worker deployment, derived from its
 * source when the stored value is absent. Mirrors the logic in
 * `worker/deploy.ts` (which runs at deploy time and also needs an md5 token,
 * so it cannot be reproduced here) for the sources whose link is a plain URL:
 * CFnew/NEXUS serve it under the UUID path, zeus has none until a user exists.
 */
function deploymentSubUrl(input: { workerUrl: string | null; uuid: string | null; source: string }): string | null {
  const base = input.workerUrl?.replace(/\/+$/, '')
  if (!base || !input.uuid) return null
  // Full-panel sources: zeus is served from the root, nova's dashboard is
  // fixed at /admin, miliconfigOS serves its dashboard under /<uuid> — in every
  // case a sub link only exists after a user is created inside the panel, so
  // there is no deploy-time sub URL.
  if (input.source === 'miliconfigzeus' || input.source === 'nova' || input.source === 'milios') return null
  if (input.source === 'miliconfigosv3') return null
  if (input.source === 'edgetunnel' || input.source === 'edgetunnel_kv') return null
  return `${base}/${input.uuid}/sub`
}

const lastReapByUser = new Map<string, number>()
async function maybeReapStale(env: Env, userId: string): Promise<void> {
  const now = Date.now()
  if ((lastReapByUser.get(userId) ?? 0) + 15_000 > now) return
  lastReapByUser.set(userId, now)
  if (lastReapByUser.size > 500) lastReapByUser.clear()
  await reapStaleDeployments(env, userId).catch(() => 0)
}

async function listDeployments(env: Env, userId: string, url: URL, ctx?: ExecutionContext, origin = ''): Promise<Response> {
  await maybeReapStale(env, userId)
  const idsParam = url.searchParams.get('ids')
  let rows: Record<string, unknown>[]
  if (idsParam) {
    const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50)
    rows = []
    for (const id of ids) {
      const row = await env.DB.prepare('SELECT * FROM deployments WHERE id = ? AND user_id = ?').bind(id, userId).first<Record<string, unknown>>()
      if (row) rows.push(row)
    }
  } else {
    const r = await env.DB.prepare('SELECT * FROM deployments WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all<Record<string, unknown>>()
    rows = r.results
  }
  if (ctx && typeof ctx.waitUntil === 'function' && rows[0]) {
    ctx.waitUntil(verifyAndHeal(env, ctx, rows[0], origin).catch(() => null))
  }
  return json({ data: rows.map(parseDeploymentRow) })
}

async function getDeployment(
  env: Env,
  userId: string,
  id: string,
  ctx?: ExecutionContext,
  origin = '',
): Promise<Response> {
  // The deploy wizard polls this endpoint: a lost task must turn into a clear
  // failure instead of an endless spinner.
  await maybeReapStale(env, userId)
  const row = await env.DB.prepare('SELECT * FROM deployments WHERE id = ? AND user_id = ?').bind(id, userId).first<Record<string, unknown>>()
  if (!row) return apiError('ورکر پیدا نشد', 404)
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(verifyAndHeal(env, ctx, row, origin).catch(() => null))
  }
  return json({ data: parseDeploymentRow(row) })
}

async function createDeployment(env: Env, userId: string, request: Request, ctx: ExecutionContext, origin: string): Promise<Response> {
  const body = safeJsonParse<DeploymentBody>(await request.text().catch(() => ''), {})
  // Same validation + creation path the Telegram bot uses (worker/deploy.ts).
  const started = await startDeployment(env, ctx, {
    userId,
    name: body.name ?? '',
    uuid: body.uuid ?? '',
    cfTokenId: body.cf_token_id ?? '',
    method: body.method === 'pages' ? 'pages' : 'workers',
    workerSource: body.worker_source ?? 'edgetunnel',
    sourceUrl: body.source_url || undefined,
    bindings: body.bindings,
    proxyip: body.proxyip || undefined,
    adminPassword: body.admin_password || undefined,
    customPath: body.custom_path || undefined,
    origin,
  })
  if (!started.ok) return apiError(started.error, 400)
  return getDeployment(env, userId, started.id)
}

async function deleteDeployment(env: Env, userId: string, id: string): Promise<Response> {
  const row = await env.DB.prepare('DELETE FROM deployments WHERE id = ? AND user_id = ? RETURNING name').bind(id, userId).first<{ name: string }>()
  if (!row) return apiError('ورکر پیدا نشد', 404)
  await logActivity(env, userId, 'worker_deleted', 'deployment', row.name)
  return json({ success: true })
}

// ── Bot config & users ─────────────────────────────────────────────────────

/** Shape a bot_config row for the API (never leak the secret). */
async function botConfigRowToObj(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { webhook_secret: _secret, ...rest } = row
  return { ...rest, is_active: !!row.is_active }
}

/** Clean a pasted bot token: strip the optional "bot" prefix, whitespace and
 *  invisible Unicode characters (ZWNJ/RLM/LRM etc.) that Persian keyboards and
 *  copy-paste often inject — any of these makes Telegram reject the token. */
function sanitizeBotToken(raw: string): string {
  return raw
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\s]/g, '')
    .replace(/^bot/i, '')
    .trim()
}

/** Register (or re-register) the Telegram webhook for a bot.
 *  A per-bot random secret_token rides along so the webhook handler can route
 *  every incoming update to exactly this bot_config row. */
async function setBotWebhook(botToken: string, origin: string, secret: string): Promise<{ ok: boolean; description?: string }> {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: `${origin}/api/webhooks/telegram`,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
      secret_token: secret,
    }),
  }).then((r) => r.json()).catch(() => null)
  const data = resp as { ok?: boolean; description?: string } | null
  return { ok: !!data?.ok, description: data?.description }
}

/** Live webhook diagnostics straight from Telegram (getWebhookInfo). */
async function botWebhookInfo(env: Env, userId: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT bot_token FROM bot_config WHERE user_id = ? LIMIT 1').bind(userId).first<{ bot_token: string }>()
  if (!row) return apiError('ربات هنوز پیکربندی نشده است', 404)
  const info = await fetch(`https://api.telegram.org/bot${sanitizeBotToken(row.bot_token)}/getWebhookInfo`)
    .then((r) => r.json())
    .catch(() => null)
  const data = info as { ok?: boolean; result?: Record<string, unknown>; description?: string } | null
  if (!data?.ok) return apiError(`خواندن وضعیت وب‌هوک از تلگرام ناموفق بود: ${data?.description ?? 'ارتباط برقرار نشد'}`)
  return json({ data: data.result })
}

/** Force-reconnect the webhook using the stored token (no retyping needed). */
async function reconnectBotWebhook(env: Env, userId: string, origin: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT id, bot_token, is_active FROM bot_config WHERE user_id = ? LIMIT 1').bind(userId).first<{ id: string; bot_token: string; is_active: number }>()
  if (!row) return apiError('ربات هنوز پیکربندی نشده است', 404)
  if (!row.is_active) await env.DB.prepare('UPDATE bot_config SET is_active = 1 WHERE id = ?').bind(row.id).run()
  const secret = genId().replace(/-/g, '')
  const hook = await setBotWebhook(sanitizeBotToken(row.bot_token), origin, secret)
  if (!hook.ok) return apiError(`اتصال مجدد وب‌هوک ناموفق بود: ${hook.description ?? 'خطای ناشناخته'}`)
  await env.DB.prepare('UPDATE bot_config SET webhook_url = ?, webhook_secret = ?, is_active = 1, updated_at = ? WHERE id = ?')
    .bind(`${origin}/api/webhooks/telegram`, secret, nowIso(), row.id)
    .run()
  // Refresh the profile + "باز کردن پنل" menu button too, so changing PANEL_URL
  // takes effect without the owner having to retype the bot token.
  await syncBotProfile(sanitizeBotToken(row.bot_token), panelAppUrl(env, origin)).catch(() => null)
  await logActivity(env, userId, 'bot_webhook_reconnected', 'bot', null)
  return getBotConfig(env, userId)
}

async function getBotConfig(env: Env, userId: string, origin?: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM bot_config WHERE user_id = ? LIMIT 1').bind(userId).first<Record<string, unknown>>()
  // Self-heal bots whose webhook was registered before per-bot secrets existed:
  // without a secret Telegram sends no routing header and the update can only be
  // routed when the whole install runs a single bot. Re-registering here gives
  // every panel user's bot its own exact routing again.
  if (row && origin && row.is_active && !row.webhook_secret && row.bot_token) {
    const secret = genId().replace(/-/g, '')
    const hook = await setBotWebhook(sanitizeBotToken(row.bot_token as string), origin, secret)
    if (hook.ok) {
      await env.DB.prepare('UPDATE bot_config SET webhook_url = ?, webhook_secret = ?, updated_at = ? WHERE id = ?')
        .bind(`${origin}/api/webhooks/telegram`, secret, nowIso(), row.id as string)
        .run()
      row.webhook_secret = secret
    }
  }
  return json({ data: row ? await botConfigRowToObj(row) : null })
}

async function saveBotConfig(env: Env, userId: string, request: Request, origin: string): Promise<Response> {
  const body = safeJsonParse<{ bot_token?: string; welcome_message?: string; is_active?: boolean }>(await request.text().catch(() => ''), {})

  const existing = await env.DB.prepare('SELECT * FROM bot_config WHERE user_id = ? LIMIT 1').bind(userId).first<Record<string, unknown>>()

  // Update without a token: toggle is_active and/or edit the welcome message.
  // Saving again also re-registers the webhook from the stored token — a safe
  // "reconnect" that fixes silently-dropped hooks without retyping the token.
  if (!body.bot_token?.trim() && existing) {
    const storedToken = sanitizeBotToken(existing.bot_token as string)
    let reconnect: { ok: boolean; description?: string } | null = null
    if ((typeof body.is_active === 'boolean' ? body.is_active : !!existing.is_active) && storedToken) {
      const secret = genId().replace(/-/g, '')
      reconnect = await setBotWebhook(storedToken, origin, secret)
      if (reconnect.ok) {
        await env.DB.prepare('UPDATE bot_config SET webhook_url = ?, webhook_secret = ? WHERE id = ?')
          .bind(`${origin}/api/webhooks/telegram`, secret, existing.id as string)
          .run()
      }
    }
    await env.DB.prepare(
      `UPDATE bot_config SET
         welcome_message = COALESCE(?, welcome_message),
         is_active = COALESCE(?, is_active),
         updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        body.welcome_message?.trim() ?? null,
        typeof body.is_active === 'boolean' ? (body.is_active ? 1 : 0) : null,
        nowIso(),
        existing.id as string,
      )
      .run()
    if (reconnect && !reconnect.ok) {
      const updated = await env.DB.prepare('SELECT * FROM bot_config WHERE user_id = ? LIMIT 1').bind(userId).first<Record<string, unknown>>()
      return json({ data: updated ? await botConfigRowToObj(updated) : null, warning: `وب‌هوک دوباره وصل نشد: ${reconnect.description ?? 'خطای ناشناخته'}` })
    }
    return getBotConfig(env, userId, origin)
  }

  if (!body.bot_token?.trim() && !existing) return apiError('توکن ربات الزامی است')
  const botToken = sanitizeBotToken(body.bot_token!)
  if (!/^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    return apiError('قالب توکن درست نیست — توکن باید شبیه 123456789:AAH... باشد و مستقیم از BotFather کپی شود')
  }

  // One bot, one panel account. Two users sharing a bot token would make the
  // webhook route updates to whichever row wins, i.e. one of them would deploy
  // with the other's Cloudflare token — refuse it outright.
  const claimed = await env.DB.prepare('SELECT user_id FROM bot_config WHERE bot_token = ? LIMIT 1')
    .bind(botToken)
    .first<{ user_id: string }>()
  if (claimed && claimed.user_id !== userId) {
    return apiError('این ربات قبلاً به حساب کاربری دیگری وصل شده است. هر ربات فقط به یک حساب تعلق دارد — در BotFather یک ربات تازه بسازید و توکن آن را اینجا وارد کنید')
  }
  const welcome = body.welcome_message?.trim()
    || ((existing?.welcome_message as string) ?? '')
    || 'سلام! به ربات miliconfig خوش آمدید. برای شروع /start را بفرستید.'

  // Validate the token with Telegram and connect the webhook.
  const meResp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`).then((r) => r.json()).catch(() => null)
  const meData = meResp as { ok?: boolean; result?: { username?: string }; description?: string } | null
  if (!meData?.ok) {
    const d = meData?.description ?? ''
    const hint = d.includes('Unauthorized')
      ? 'توکن از سمت تلگرام رد شد — مطمئن شوید کل رشتهٔ کامل از BotFather کپی شده و ربات با /revoke باطل نشده باشد'
      : d
        ? `تلگرام پاسخ داد: ${d}`
        : 'اتصال به سرور تلگرام ناموفق بود — چند لحظه بعد دوباره تلاش کنید'
    return apiError(`توکن ربات تأیید نشد: ${hint}`)
  }
  const botUsername = meData.result?.username ?? null
  const webhookUrl = `${origin}/api/webhooks/telegram`
  const webhookSecret = genId().replace(/-/g, '')
  const hookData = await setBotWebhook(botToken, origin, webhookSecret)
  if (!hookData.ok) {
    return apiError(`اتصال وب‌هوک ناموفق بود: ${hookData.description ?? 'خطای ناشناخته'}`)
  }
  if (existing) {
    await env.DB.prepare(
      `UPDATE bot_config SET bot_token = ?, bot_username = ?, webhook_url = ?, webhook_secret = ?, is_active = ?, welcome_message = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(botToken, botUsername, webhookUrl, webhookSecret, body.is_active === false ? 0 : 1, welcome, nowIso(), existing.id as string)
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO bot_config (id, user_id, bot_token, bot_username, webhook_url, webhook_secret, is_active, welcome_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
      .bind(genId(), userId, botToken, botUsername, webhookUrl, webhookSecret, welcome, nowIso(), nowIso())
      .run()
  }

  // Register the command list, description and the "open web panel" button so
  // the bot behaves like an app from the very first time it is opened.
  await syncBotProfile(botToken, panelAppUrl(env, origin)).catch(() => null)

  await logActivity(env, userId, 'bot_configured', 'bot', botUsername)
  return getBotConfig(env, userId, origin)
}

async function listBotUsers(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare(
    `SELECT bu.*,
       bt.user_id AS tenant_user_id,
       bt.access_token AS access_token,
       (SELECT COUNT(*) FROM deployments d WHERE d.user_id = bt.user_id) AS deployments_count,
       (SELECT COUNT(*) FROM deployments d WHERE d.user_id = bt.user_id AND d.status = 'deployed') AS deployed_count,
       (SELECT COUNT(*) FROM cf_tokens t WHERE t.user_id = bt.user_id) AS tokens_count,
       (SELECT max_deployments FROM users u WHERE u.id = bt.user_id) AS max_deployments
     FROM bot_users bu
     LEFT JOIN bot_tenants bt ON bt.telegram_id = bu.telegram_id
     WHERE bu.user_id = ?
     ORDER BY bu.created_at DESC`,
  ).bind(userId).all().catch(() => env.DB.prepare('SELECT * FROM bot_users WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all())
  return json({
    data: r.results.map((u) => ({
      ...u,
      is_active: !!u.is_active,
      is_admin: !!u.is_admin,
      deployments_count: Number(u.deployments_count ?? 0),
      deployed_count: Number(u.deployed_count ?? 0),
      tokens_count: Number(u.tokens_count ?? 0),
      max_deployments: Number(u.max_deployments ?? 10),
    })),
  })
}

async function updateBotUser(env: Env, userId: string, id: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{ is_active?: boolean; is_admin?: boolean; max_deployments?: number }>(await request.text().catch(() => ''), {})
  const sets: string[] = []
  const binds: (number | string)[] = []
  if (typeof body.is_active === 'boolean') { sets.push('is_active = ?'); binds.push(body.is_active ? 1 : 0) }
  if (typeof body.is_admin === 'boolean') { sets.push('is_admin = ?'); binds.push(body.is_admin ? 1 : 0) }
  if (sets.length) {
    binds.push(id, userId)
    const r = await env.DB.prepare(`UPDATE bot_users SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run()
    if (!r.meta.changes) return apiError('کاربر پیدا نشد', 404)
  }
  if (body.max_deployments !== undefined) {
    const quota = Math.min(Math.max(1, Number(body.max_deployments) || 1), 1000)
    const bu = await env.DB.prepare('SELECT telegram_id FROM bot_users WHERE id = ? AND user_id = ?')
      .bind(id, userId)
      .first<{ telegram_id: string }>()
    if (!bu) return apiError('کاربر پیدا نشد', 404)
    const tenant = await env.DB.prepare('SELECT user_id FROM bot_tenants WHERE telegram_id = ?')
      .bind(bu.telegram_id)
      .first<{ user_id: string }>()
    if (tenant?.user_id) {
      await env.DB.prepare('UPDATE users SET max_deployments = ? WHERE id = ?').bind(quota, tenant.user_id).run()
    }
  }
  if (!sets.length && body.max_deployments === undefined) return apiError('فیلدی برای به‌روزرسانی نیست')
  return json({ success: true })
}

async function broadcastBotUsers(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<{
    message?: string
    target?: 'all' | 'active' | 'selected'
    telegram_ids?: string[]
    button_text?: string
    button_url?: string
  }>(await request.text().catch(() => ''), {})
  const message = (body.message ?? '').trim()
  if (!message) return apiError('متن پیام الزامی است', 400)

  const cfg = await env.DB.prepare('SELECT bot_token FROM bot_config WHERE user_id = ? AND is_active = 1 LIMIT 1')
    .bind(userId)
    .first<{ bot_token: string }>()
    .then((r) => r ?? env.DB.prepare('SELECT bot_token FROM bot_config WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1').first<{ bot_token: string }>())
  if (!cfg?.bot_token) return apiError('ربات تلگرام فعالی متصل نیست — ابتدا از بخش ربات تلگرام توکن را ثبت کنید', 400)

  let recipients: string[] = []
  if (body.target === 'selected' && Array.isArray(body.telegram_ids) && body.telegram_ids.length > 0) {
    recipients = Array.from(new Set(body.telegram_ids.map((s) => String(s).trim()).filter(Boolean)))
  } else {
    const onlyActive = body.target !== 'all'
    const rows = await env.DB.prepare(
      onlyActive
        ? 'SELECT telegram_id FROM bot_users WHERE user_id = ? AND is_active = 1'
        : 'SELECT telegram_id FROM bot_users WHERE user_id = ?',
    ).bind(userId).all<{ telegram_id: string }>()
    recipients = Array.from(new Set((rows.results ?? []).map((r) => String(r.telegram_id).trim()).filter(Boolean)))
    if (recipients.length === 0) {
      const allTenants = await env.DB.prepare('SELECT telegram_id FROM bot_tenants').all<{ telegram_id: string }>().catch(() => ({ results: [] }))
      recipients = Array.from(new Set((allTenants.results ?? []).map((r) => String(r.telegram_id).trim()).filter(Boolean)))
    }
  }

  if (recipients.length === 0) {
    return apiError('هیچ کاربری برای ارسال پیام یافت نشد', 400)
  }

  const keyboard = body.button_text?.trim() && body.button_url?.trim()
    ? { inline_keyboard: [[{ text: body.button_text.trim(), url: body.button_url.trim() }]] }
    : undefined

  const formattedMsg = `📢 <b>پیام مدیریت</b>\n\n${message}`
  let sent = 0
  let failed = 0
  // Batch in groups of 10 so we stay fast and polite to Telegram rate limits
  for (let i = 0; i < recipients.length; i += 10) {
    const chunk = recipients.slice(i, i + 10)
    const results = await Promise.all(
      chunk.map((chatId) => sendMsg(cfg.bot_token, chatId, formattedMsg, keyboard).then((id) => id !== null).catch(() => false)),
    )
    for (const ok of results) {
      if (ok) sent++
      else failed++
    }
  }

  await logActivity(env, userId, 'bot_broadcast_sent', 'bot', `${sent}/${recipients.length}`)
  return json({ data: { total: recipients.length, sent, failed } })
}

async function deleteBotUser(env: Env, userId: string, id: string): Promise<Response> {
  const r = await env.DB.prepare('DELETE FROM bot_users WHERE id = ? AND user_id = ?').bind(id, userId).run()
  if (!r.meta.changes) return apiError('کاربر پیدا نشد', 404)
  return json({ success: true })
}

// ── Stats & logs ───────────────────────────────────────────────────────────

async function getStats(env: Env, userId: string): Promise<Response> {
  const [tokens, deps, botUsersAll, recentLogs] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS c FROM cf_tokens WHERE user_id = ?').bind(userId).first<{ c: number }>(),
    env.DB.prepare("SELECT status, COUNT(*) AS c FROM deployments WHERE user_id = ? GROUP BY status").bind(userId).all<{ status: string; c: number }>(),
    env.DB.prepare('SELECT is_active, is_admin, COUNT(*) AS c FROM bot_users WHERE user_id = ? GROUP BY is_active, is_admin').bind(userId).all<{ is_active: number; is_admin: number; c: number }>(),
    env.DB.prepare('SELECT id, action, entity_name, created_at FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 8').bind(userId).all(),
  ])

  const statusCounts = Object.fromEntries(deps.results.map((r) => [r.status, r.c]))
  const botUsers = botUsersAll.results.reduce((acc, g) => acc + g.c, 0)
  const activeBotUsers = botUsersAll.results.filter((g) => g.is_active).reduce((acc, g) => acc + g.c, 0)

  return json({
    tokens: tokens?.c ?? 0,
    deployments: deps.results.reduce((acc, g) => acc + g.c, 0),
    deployed: statusCounts.deployed ?? 0,
    failed: statusCounts.failed ?? 0,
    botUsers,
    activeBotUsers,
    recentLogs: recentLogs.results,
  })
}

async function listLogs(env: Env, userId: string): Promise<Response> {
  const r = await env.DB.prepare('SELECT * FROM activity_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(userId).all()
  return json({ data: r.results })
}

/**
 * Site-wide statistics for the admin tab ("آمار").
 *
 * Everything is one aggregate read of the shared tables: who deployed what,
 * which sources dominate, how many deployments land every day, how many end
 * up failing and with which error — the picture the admin needs to decide
 * whether a source or method is currently breaking for users. All the heavy
 * GROUP BYs run inside D1; the endpoint itself only reshapes the rows.
 */
async function getSiteStats(env: Env): Promise<Response> {
  const day = "substr(created_at, 1, 10)"
  const [totals, byStatus, bySource, byMethod, daily, topUsers, failures, userCount, botUsers, membersCount, selfCheck] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS c FROM deployments').first<{ c: number }>(),
    env.DB.prepare('SELECT status, COUNT(*) AS c FROM deployments GROUP BY status').all<{ status: string; c: number }>(),
    env.DB.prepare("SELECT COALESCE(NULLIF(worker_source, ''), 'github') AS src, COUNT(*) AS c FROM deployments GROUP BY src ORDER BY c DESC").all<{ src: string; c: number }>(),
    env.DB.prepare("SELECT COALESCE(NULLIF(method, ''), 'workers') AS m, COUNT(*) AS c FROM deployments GROUP BY m ORDER BY c DESC").all<{ m: string; c: number }>(),
    env.DB.prepare(`SELECT ${day} AS d, COUNT(*) AS c FROM deployments WHERE created_at >= date('now', '-13 days') GROUP BY d ORDER BY d ASC`).all<{ d: string; c: number }>(),
    env.DB.prepare(
      `SELECT u.email, u.role, COUNT(d.id) AS c
         FROM deployments d JOIN users u ON u.id = d.user_id
        GROUP BY d.user_id ORDER BY c DESC LIMIT 8`,
    ).all(),
    env.DB.prepare(
      `SELECT d.id, d.name, d.worker_source, d.method, d.error_message, d.created_at, u.email AS user_email
         FROM deployments d LEFT JOIN users u ON u.id = d.user_id
        WHERE d.status = 'failed' ORDER BY d.created_at DESC LIMIT 12`,
    ).all(),
    env.DB.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS c FROM bot_users').first<{ c: number }>(),
    // The members table only exists once the user manages end users; a fresh
    // panel should not 500 on the stats tab just because it is still empty.
    env.DB.prepare('SELECT COUNT(*) AS c FROM members').first<{ c: number }>().catch(() => ({ c: 0 })),
    env.DB.prepare(
      "SELECT json_extract(config, '$.self_check') AS sc, COUNT(*) AS c FROM deployments WHERE status = 'deployed' GROUP BY sc",
    ).all<{ sc: string | null; c: number }>(),
  ])

  const sc = Object.fromEntries((selfCheck.results ?? []).map((r) => [r.sc ?? 'none', r.c]))
  // Wrapped in `data` like every other endpoint: the stats tab reads
  // `const { data } = await api(...)`, so an unwrapped payload left the tab on
  // "آماری موجود نیست" even though the query succeeded.
  return json({
    data: {
    totals: {
      deployments: totals?.c ?? 0,
      users: userCount?.c ?? 0,
      botUsers: botUsers?.c ?? 0,
      members: membersCount?.c ?? 0,
      deployed: byStatus.results?.find((r) => r.status === 'deployed')?.c ?? 0,
      failed: byStatus.results?.find((r) => r.status === 'failed')?.c ?? 0,
    },
    byStatus: byStatus.results ?? [],
    bySource: bySource.results ?? [],
    byMethod: byMethod.results ?? [],
    daily: daily.results ?? [],
    topUsers: topUsers.results ?? [],
    failures: failures.results ?? [],
    selfCheck: sc,
    },
  })
}

// ── Router ────────────────────────────────────────────────────────────────

/** Echo the caller's origin so the SPA can also be hosted on a separate domain. */
function corsHeaders(request: Request): Record<string, string> {
  const requestOrigin = request.headers.get('Origin')
  if (!requestOrigin) return {}
  return {
    'Access-Control-Allow-Origin': requestOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function withCors(response: Response, headers: Record<string, string>): Response {
  if (!Object.keys(headers).length) return response
  const resp = new Response(response.body, response)
  for (const [k, v] of Object.entries(headers)) resp.headers.set(k, v)
  return resp
}

async function handleRouted(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  path: string,
  origin: string,
  method: string,
): Promise<Response> {
  const url = new URL(request.url)

  // Telegram webhook — public, authenticated by bot token inside the handler.
  if (path === '/api/webhooks/telegram' && method === 'POST') {
    return await handleTelegramWebhook(env, ctx, request)
  }

  // Public auth endpoints
  if (path === '/api/auth/signup' && method === 'POST') return await handleSignup(env, request)
  if (path === '/api/auth/login' && method === 'POST') return await handleLogin(env, request)
  // Telegram Mini App: the bot's `initData` is verified against the bot token.
  if (path === '/api/auth/telegram' && method === 'POST') return await handleTelegramLogin(env, request)

  // Public subscription endpoints (token in URL acts as the credential)
  if (path.startsWith('/api/sub/') && method === 'GET') {
    const token = path.split('/')[4] ?? ''
    const target = url.searchParams.get('target')
    if (path.startsWith('/api/sub/opt/')) return await serveOptimizerSub(env, token, target)
    if (path.startsWith('/api/sub/group/')) return await serveGroupSub(env, token, target)
    if (path.startsWith('/api/sub/inject/')) return await serveInjectedSub(env, token, target)
    if (path.startsWith('/api/sub/member/')) return await serveMemberSub(env, token, target, request)
  }

  // Public status page per member (token in URL acts as the credential).
  // `/status/<token>/sub` serves the member's live subscription directly —
  // so the download button on the status card never 404s.
  if (path.startsWith('/status/') && method === 'GET') {
    const rest = path.slice('/status/'.length)
    const subMatch = rest.match(/^([^/]+)\/sub\/?$/)
    if (subMatch) {
      return await serveMemberSub(env, subMatch[1], url.searchParams.get('target'), request)
    }
    const backupMatch = rest.match(/^([^/]+)\/backup\/?$/)
    if (backupMatch) {
      return await serveMemberBackup(env, backupMatch[1], url.origin)
    }
    return await serveStatusPage(env, rest, url.origin)
  }

  // Everything below requires a session
  if (path.startsWith('/api/auth/') || path.startsWith('/api/')) {
    const user = await requireUser(env, request)

    if (path === '/api/auth/logout' && method === 'POST') {
      if (!user) return json({ success: true })
      return await handleLogout(env, request)
    }
    if (path === '/api/auth/me' && method === 'GET') return await handleMe(env, request)

    if (!user) return apiError('ابتدا وارد شوید', 401)

    if (path === '/api/tokens' && method === 'GET') return await listTokens(env, user.id)
    if (path === '/api/tokens' && method === 'POST') return await createToken(env, user.id, request)
    if (path.match(/^\/api\/tokens\/[^/]+$/) && method === 'DELETE') return await deleteToken(env, user.id, path.split('/')[3])

    // ── Railway (catalog panel auto-deploy) ──────────────────────────────
    if (path === '/api/railway/tokens' && method === 'GET') return await listRailwayTokens(env, user.id)
    if (path === '/api/railway/tokens' && method === 'POST') return await createRailwayToken(env, user.id, request)
    if (path.match(/^\/api\/railway\/tokens\/[^/]+$/) && method === 'DELETE') return await deleteRailwayToken(env, user.id, path.split('/')[4])
    if (path === '/api/railway/deploy' && method === 'POST') return await handleRailwayDeploy(env, user.id, request)
    if (path === '/api/railway/status' && method === 'GET') return await handleRailwayStatus(env, user.id, url)

    // ── Render.com (catalog panel auto-deploy) ───────────────────────────
    if (path === '/api/render/tokens' && method === 'GET') return await listRenderTokens(env, user.id)
    if (path === '/api/render/tokens' && method === 'POST') return await createRenderToken(env, user.id, request)
    if (path.match(/^\/api\/render\/tokens\/[^/]+$/) && method === 'DELETE') return await deleteRenderToken(env, user.id, path.split('/')[4])
    if (path === '/api/render/deploy' && method === 'POST') return await handleRenderDeploy(env, user.id, request)
    if (path === '/api/render/status' && method === 'GET') return await handleRenderStatus(env, user.id, url)

    // ── Hosted panel registry (the dedicated catalog panel) ───────────────
    // Repointing the source is a global change (it drives every deploy, the bot
    // and the version probe), so only the owner or an admin may do it.
    if (path === '/api/panels/repo' && method === 'POST') {
      if (!(await isOwner(env, user.id)) && user.role !== 'admin') {
        return apiError('تغییر آدرس مخزن پنل فقط برای مالک یا ادمین است', 403)
      }
      return await handlePanelRepo(env, user.id, request)
    }
    if (path === '/api/panels' && method === 'GET') return await handlePanelList(env, user.id, origin)
    if (path === '/api/panels/watch' && method === 'POST') return await handlePanelWatch(env, user.id, request)
    if (path === '/api/panels/health' && method === 'POST') return await handlePanelHealth(env, user.id, request)
    if (path === '/api/panels/update' && method === 'POST') return await handlePanelUpdate(env, user.id, request)
    if (path === '/api/panels/settings' && method === 'POST') return await handlePanelSettings(env, user.id, request)
    if (path === '/api/panels/auto-update' && method === 'POST') return await handlePanelAutoUpdate(env, user.id, request)
    if (path === '/api/panels/forget' && method === 'POST') return await handlePanelForget(env, user.id, request)

    if (path === '/api/deployments' && method === 'GET') return await listDeployments(env, user.id, url, ctx, origin)
    if (path === '/api/deployments' && method === 'POST') return await createDeployment(env, user.id, request, ctx, origin)
    if (path.match(/^\/api\/deployments\/[^/]+$/) && method === 'GET') return await getDeployment(env, user.id, path.split('/')[3], ctx, origin)
    if (path.match(/^\/api\/deployments\/[^/]+$/) && method === 'DELETE') return await deleteDeployment(env, user.id, path.split('/')[3])
    // Pull the worker source from its upstream repo again — D1/R2/KV untouched.
    if (path === '/api/deployments/update' && method === 'POST') return await handleDeploymentUpdate(env, user.id, request)

    // The deployer bot is the owner's own tool: it is not a panel feature for
    // users or admins, so the whole section is closed to everyone else.
    if ((path.startsWith('/api/bot-config') || path.startsWith('/api/bot-users')) && user.role !== 'admin' && !(await isOwner(env, user.id))) {
      return apiError('این بخش فقط برای مالک یا ادمین پنل است', 403)
    }

    if (path === '/api/bot-config/webhook-info' && method === 'GET') return await botWebhookInfo(env, user.id)
    if (path === '/api/bot-config/reconnect' && method === 'POST') return await reconnectBotWebhook(env, user.id, origin)
    if (path === '/api/bot-config' && method === 'GET') return await getBotConfig(env, user.id, origin)
    if (path === '/api/bot-config' && (method === 'PUT' || method === 'PATCH')) return await saveBotConfig(env, user.id, request, origin)

    if (path === '/api/bot-users/broadcast' && method === 'POST') return await broadcastBotUsers(env, user.id, request)
    if (path === '/api/bot-users' && method === 'GET') return await listBotUsers(env, user.id)
    if (path.match(/^\/api\/bot-users\/[^/]+$/) && method === 'PATCH') return await updateBotUser(env, user.id, path.split('/')[3], request)
    if (path.match(/^\/api\/bot-users\/[^/]+$/) && method === 'DELETE') return await deleteBotUser(env, user.id, path.split('/')[3])

    if (path === '/api/stats' && method === 'GET') return await getStats(env, user.id)
    if (path === '/api/logs' && method === 'GET') return await listLogs(env, user.id)

    if (path === '/api/worker-config' && method === 'POST') {
      const body = safeJsonParse(await request.text().catch(() => ''), {})
      return await handleWorkerConfig(env, user.id, body)
    }

    // ── Real source bridge: unified settings + live node check ────────
    if (path === '/api/source-settings' && method === 'POST') {
      const body = safeJsonParse(await request.text().catch(() => ''), {})
      return await handleSourceSettings(env, user.id, body)
    }
    if (path.match(/^\/api\/source-nodes\/[^/]+$/) && method === 'GET') {
      return await handleSourceNodes(env, user.id, path.split('/')[3])
    }
    if (path === '/api/ip-scanner' && method === 'POST') {
      const body = safeJsonParse<{ mode?: string; ranges?: string; ports?: string; count?: number; timeout?: number }>(await request.text().catch(() => ''), {})
      if (body.mode === 'ranges') return await handleRangeScan(body)
      return await handleIpScanner(body)
    }

    // ── Config optimizer ────────────────────────────────────────────────
    if (path === '/api/optimizer' && method === 'GET') return await handleOptimizerList(env, user.id)
    if (path === '/api/optimizer' && method === 'POST') return await handleOptimizerCreate(env, user.id, request, ctx)
    if (path.match(/^\/api\/optimizer\/[^/]+$/) && method === 'GET') return await handleOptimizerGet(env, user.id, path.split('/')[3])
    if (path.match(/^\/api\/optimizer\/[^/]+$/) && method === 'DELETE') return await handleOptimizerDelete(env, user.id, path.split('/')[3])

    // ── Real edge probes (Sop8 engines: colo, ports, speedtest, batch) ──
    if (path === '/api/opt/probe' && method === 'GET') return await handleOptProbe(env, request)
    if (path === '/api/opt/ports' && method === 'GET') return await handleOptPorts(env, request)
    if (path === '/api/opt/scan-batch' && method === 'POST') return await handleOptScanBatch(env, request)
    if (path === '/api/opt/speedtest' && method === 'GET') return await handleOptSpeedtest(env, request)

    // ── Group subscriptions ───────────────────────────────────────────
    if (path === '/api/subgroups' && method === 'GET') return await handleGroupList(env, user.id)
    if (path === '/api/subgroups' && method === 'POST') return await handleGroupCreate(env, user.id, request)
    if (path.match(/^\/api\/subgroups\/[^/]+$/) && method === 'PATCH') return await handleGroupPatch(env, user.id, path.split('/')[3], request)
    if (path.match(/^\/api\/subgroups\/[^/]+$/) && method === 'DELETE') return await handleGroupDelete(env, user.id, path.split('/')[3])

    // ── Custom injected subscriptions (miliconfig) ────────────────────
    if (path === '/api/injector' && method === 'GET') return await handleInjectorList(env, user.id)
    if (path === '/api/injector' && method === 'POST') return await handleInjectorCreate(env, user.id, request)
    if (path.match(/^\/api\/injector\/[^/]+$/) && method === 'PATCH') return await handleInjectorPatch(env, user.id, path.split('/')[3], request)
    if (path.match(/^\/api\/injector\/[^/]+$/) && method === 'DELETE') return await handleInjectorDelete(env, user.id, path.split('/')[3])

    // ── Per-worker members (end users with private settings) ──────────
    if (path === '/api/backup' && method === 'GET') return await exportBackup(env, user.id)
    if (path === '/api/backup' && method === 'POST') return await importBackup(env, user.id, request)
    if (path === '/api/members' && method === 'GET') return await handleMemberList(env, user.id, url.searchParams.get('deployment_id'))
    if (path === '/api/members' && method === 'POST') return await handleMemberCreate(env, user.id, request)
    if (path === '/api/members/bulk' && method === 'POST') return await handleMemberBulk(env, user.id, request)
    if (path === '/api/members/create-many' && method === 'POST') return await handleMemberCreateMany(env, user.id, request)
    if (path === '/api/cf-quota' && method === 'GET') return await handleCfQuota(env, user.id)
    if (path.match(/^\/api\/members\/[^/]+\/usage$/) && method === 'POST') return await refreshMemberUsage(env, user.id, path.split('/')[3])
    if (path.match(/^\/api\/members\/[^/]+\/test$/) && method === 'GET') return await handleMemberTest(env, user.id, path.split('/')[3])
    if (path.match(/^\/api\/members\/[^/]+$/) && method === 'PATCH') return await handleMemberPatch(env, user.id, path.split('/')[3], request)
    if (path.match(/^\/api\/members\/[^/]+$/) && method === 'DELETE') return await handleMemberDelete(env, user.id, path.split('/')[3])

    // ── Admin: user & quota management ─────────────────────────────────
    if (path.startsWith('/api/admin')) {
      // The installation owner is an admin by definition, whatever its role column says.
      if (user.role !== 'admin' && !(await isOwner(env, user.id))) return apiError('دسترسی فقط برای ادمین', 403)
      if (path === '/api/admin/backup' && method === 'GET') return await exportAdminBackup(env)
      if (path === '/api/admin/backup' && method === 'POST') return await importAdminBackup(env, request)
      if (path === '/api/admin/broadcast' && method === 'POST') return await broadcastBotUsers(env, user.id, request)
      if (path === '/api/admin/users' && method === 'GET') {
        const r = await env.DB.prepare(
          `SELECT u.id, u.email, u.role, u.max_deployments, u.created_at,
            (SELECT COUNT(*) FROM deployments d WHERE d.user_id = u.id) AS deployments,
            (SELECT COUNT(*) FROM deployments d WHERE d.user_id = u.id AND d.status = 'deployed') AS deployed_count,
            (SELECT COUNT(*) FROM deployments d WHERE d.user_id = u.id AND d.status = 'failed') AS failed_count,
            (SELECT COUNT(*) FROM cf_tokens t WHERE t.user_id = u.id) AS tokens_count,
            bt.telegram_id AS telegram_id,
            bt.username AS telegram_username,
            bt.first_name AS telegram_first_name
           FROM users u
           LEFT JOIN bot_tenants bt ON bt.user_id = u.id
           ORDER BY u.created_at DESC`,
        ).all().catch(() =>
          env.DB.prepare(
            `SELECT u.id, u.email, u.role, u.max_deployments, u.created_at,
              (SELECT COUNT(*) FROM deployments d WHERE d.user_id = u.id) AS deployments
             FROM users u ORDER BY u.created_at`,
          ).all(),
        )
        return json({ data: r.results })
      }
    // پنل آمار: نمای کلی همهٔ استقرارها برای تب «آمار» مدیر
    if (path === '/api/admin/site-stats' && method === 'GET') return await getSiteStats(env)
    // D1 budget health: how many best-effort writes were dropped, whether the
    // write guard is in its cooldown, and the current table sizes. This is the
    // page the owner opens when "D1 لیمیت خورد" happens.
    if (path === '/api/admin/db-health' && method === 'GET') {
      const [health, tables] = await Promise.all([
        Promise.resolve(dbHealth()),
        env.DB.prepare(
          `SELECT (SELECT COUNT(*) FROM deployments) deployments,
                  (SELECT COUNT(*) FROM activity_logs) activity_logs,
                  (SELECT COUNT(*) FROM sessions) sessions,
                  (SELECT COUNT(*) FROM bot_sessions) bot_sessions,
                  (SELECT value FROM db_meta WHERE key = 'schema_version') schema_version`,
        )
          .first()
          .catch(() => null),
      ])
      return json({ data: { ...health, ...(tables ?? {}) } })
    }
    // On-demand housekeeping (the cron does the same every 6 hours).
    if (path === '/api/admin/db-maintenance' && method === 'POST') {
      return json({ data: await runDbMaintenance(env) })
    }
      const adminTarget = path.match(/^\/api\/admin\/users\/([^/]+)$/)
      if (adminTarget && method === 'PATCH') {
        const body = safeJsonParse<{ role?: string; max_deployments?: number }>(await request.text().catch(() => ''), {})
        if (body.role !== undefined) {
          if (!['admin', 'user'].includes(body.role)) return apiError('نقش نامعتبر است')
          await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, adminTarget[1]).run()
        }
        if (body.max_deployments !== undefined) {
          const quota = Math.min(Math.max(1, Number(body.max_deployments) || 1), 1000)
          await env.DB.prepare('UPDATE users SET max_deployments = ? WHERE id = ?').bind(quota, adminTarget[1]).run()
        }
        const row = await env.DB.prepare('SELECT id, email, role, max_deployments FROM users WHERE id = ?').bind(adminTarget[1]).first()
        if (!row) return apiError('کاربر پیدا نشد', 404)
        return json({ data: row })
      }
      if (adminTarget && method === 'DELETE') {
        const targetId = adminTarget[1]
        if (targetId === user.id || (await isOwner(env, targetId))) {
          return apiError('حساب مالک یا حساب فعلی قابل حذف نیست', 400)
        }
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId).run().catch(() => null)
        await env.DB.prepare('DELETE FROM cf_tokens WHERE user_id = ?').bind(targetId).run().catch(() => null)
        await env.DB.prepare('DELETE FROM deployments WHERE user_id = ?').bind(targetId).run().catch(() => null)
        await env.DB.prepare('DELETE FROM bot_tenants WHERE user_id = ?').bind(targetId).run().catch(() => null)
        const del = await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run()
        if (!del.meta.changes) return apiError('کاربر پیدا نشد', 404)
        return json({ success: true })
      }
    }

    return apiError('مسیر API پیدا نشد', 404)
  }

  // Static assets (SPA).
  //
  // On Workers the asset layer already falls back to index.html for unknown
  // paths (`not_found_handling` in wrangler.toml) and never invokes this
  // handler for them. On Cloudflare Pages (`_worker.js` advanced mode) the
  // worker receives *every* request, so a bookmarked SPA path (an old
  // non-hash URL, a PWA shortcut, a crawler) would otherwise hit a bare 404.
  // Serve the app shell instead — never for /api/*, which are handled above.
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return new Response('<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"><title>miliconfigpro</title></head><body style="background:#06060b;color:#f8fafc;font-family:system-ui;padding:2rem;text-align:center"><h2>سرویس استقرارکننده فعال است</h2><p>فایل‌های استاتیک (ASSETS) متصل نیستند؛ لطفاً با دستور sh ./scripts/deploy.sh مستقر کنید.</p></body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
  try {
    const asset = await env.ASSETS.fetch(request)
    const isNavigation =
      (method === 'GET' || method === 'HEAD') &&
      (request.headers.get('Accept') ?? '').includes('text/html')
    if (asset.status === 404 && isNavigation) {
      const shell = await env.ASSETS.fetch(new Request(new URL('/index.html', url), { method: 'GET' }))
      if (shell.ok) return new Response(shell.body, { status: 200, headers: shell.headers })
    }
    return asset
  } catch {
    return new Response('<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"><meta http-equiv="refresh" content="1"><title>miliconfigpro</title></head><body style="background:#09080f;color:#f8fafc;font-family:system-ui;padding:2rem;text-align:center">در حال بارگذاری پنل...</body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const origin = url.origin
    const method = request.method
    const cors = corsHeaders(request)

    // CORS preflight
    if (method === 'OPTIONS' && path.startsWith('/api')) {
      return new Response(null, { status: 204, headers: cors })
    }

    try {
      // D1 is attached via dashboard bindings; until it is, answer the API
      // with a clear one-time setup hint instead of crashing.
      if (path.startsWith('/api')) {
        if (!env.DB) {
          return withCors(
            json(
              {
                error:
                  'اتصال دیتابیس هنوز برقرار نیست. در داشبورد کلودفلر: Workers & Pages → miliconfigpro-v1 → Settings → Bindings → Add → D1 database، نام متغیر: DB',
                setup_required: 'd1_binding',
              },
              503,
            ),
            cors,
          )
        }
        await ensureSchema(env)
        // Housekeeping is request-driven because a Pages deployment has no cron
        // trigger; it no-ops unless six hours have passed.
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(maybeRunMaintenance(env).catch(() => null))
        else await maybeRunMaintenance(env).catch(() => null)
        // Deploy, version probe and bot all resolve the panel's source through
        // the shared catalog, so the admin's override is applied first.
        await syncPanelSource(env)
      }
      const response = await handleRouted(request, env, ctx, path, origin, method)
      return withCors(response, cors)
    } catch (err) {
      console.error('API error:', err)
      // A capped D1 returns a raw SQLite error. Say what happened and what the
      // owner can do, and mark it so the UI can show a banner instead of a red
      // toast full of `D1_ERROR`.
      if (isDbLimitError(err)) {
        return json(
          {
            error:
              'سهمیهٔ D1 تمام شده — خواندن/نوشتن این دیتابیس موقتاً محدود شده است. ' +
              'نوشتن‌های غیرضروری خودکار متوقف شده‌اند؛ سهمیهٔ روزانه نیمه‌شب UTC ریست می‌شود.',
            db_limit: true,
          },
          503,
        )
      }
      return apiError(err instanceof Error ? err.message : 'خطای داخلی سرور', 500)
    }
  },

  /**
   * Cron collector (see `[triggers]` in wrangler.toml): keep the deployments
   * that opted in on the newest upstream version without waiting for someone to
   * open the panel. Everything it does is also reachable from the UI, so a
   * failure here costs nothing but a log line.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.DB) return
    ctx.waitUntil(
      (async () => {
        try {
          await ensureSchema(env)
          await syncPanelSource(env)
          // Keep the tables bounded before the version sweep so a big log table
          // does not make every listing query more expensive than it needs to be.
          const maintenance = await runDbMaintenance(env)
          console.log('db maintenance:', JSON.stringify(maintenance))
          const summary = await autoUpdatePanels(env)
          if (summary.updated || summary.failed) {
            console.log('panel auto-update:', JSON.stringify(summary))
          }
        } catch (err) {
          console.error('panel auto-update failed:', err)
        }
      })(),
    )
  },
}
