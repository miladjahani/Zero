import type { Env } from './env'
import { apiError, genId, json, nowIso, safeJsonParse } from './util'
import {
  buildGithubSourceConfig,
  fetchPinnedWorkerSource,
  fetchWorkerSource,
  lookupWorkerSource,
  optimizeWorkerSourceForColdStart,
  generateUniqueDeploymentSeed,
  readBundledAsset,
  patchDeploymentConfig,
  recordSourceFingerprint,
  uploadPagesDeployment,
  waitForWorkerLive,
  type WorkerSourceConfig,
} from './deploy'

// ── "به‌روزرسانی از مخزن" + "بازیابی" ────────────────────────────────────
// Every worker this panel deploys is a *copy* of an upstream repository file.
// This module pulls that repository again and pushes the new file over the
// existing Cloudflare Worker — without touching the D1 database, the R2 bucket
// or any variable, because the current bindings are read back from Cloudflare
// and re-sent unchanged with the new code.
//
// Two rules make it safe to run unattended:
//
//   1. NOTHING IS UPLOADED THAT WAS NOT VERIFIED. The download is matched
//      against the published checksum of the upstream revision (see
//      worker/source-verify.ts). The old screen — "bigger than 1000 bytes and
//      has the marker" — accepted a file that the network cut in half, and a
//      truncated module does not fail loudly: Cloudflare stores it, the isolate
//      cannot parse it and every request answers `error code: 1101` from then
//      on. That is a deployment that can never update itself again, because the
//      code that would run the updater is the code that is broken.
//
//   2. EVERY UPDATE CHECKS ITS OWN RESULT. After the upload the worker is
//      probed until it answers; a failure is retried once with the same
//      verified bytes, and then rolled back to the last revision that was seen
//      running. A failed update is reported as failed — it is never left
//      looking like a healthy deployment, so it can never propagate to the
//      other panels that follow the same upstream file.
//
// The upstream file's ETag (a sha256 of its content) is stored on the
// deployment, so pressing the button on an unchanged repo costs one small GET
// and uploads nothing at all.

const API_BASE = 'https://api.cloudflare.com/client/v4'

interface UpdateBody {
  deployment_id?: string
  /** Re-deploy even when upstream did not change (the /recover path). */
  force?: boolean
}

interface ScriptSettings {
  main_module?: string
  compatibility_date?: string
  compatibility_flags?: string[]
  bindings?: unknown[]
}

/** How a caller may steer one update run. */
export interface DeploymentUpdateOptions {
  /** Ignore the "upstream unchanged" shortcut and deploy anyway. */
  force?: boolean
  /**
   * Where the run came from. `recover` additionally accepts a deployment whose
   * last status is `failed` — a worker stuck on 1101 has to be re-deployable,
   * that is the whole point of the command.
   */
  reason?: 'manual' | 'recover' | 'auto'
}

/**
 * How a newer upstream version can reach this deployment.
 *
 *   `api`    — this panel still has the Cloudflare token it deployed with, so
 *              it uploads the new file itself (nothing to enter).
 *   `auto`   — the deployment was created from a GitHub repository, so the
 *              repository's own build (Workers Builds / Actions) deploys every
 *              push; nobody has to do anything here.
 *   `self`   — the deployed panel carries its own `CF_API_TOKEN`, so it can
 *              install the new version from inside its own dashboard.
 *   `manual` — none of the above: hand out the fresh file and a ready-to-run
 *              deploy command, and say how to switch the `self` path on.
 */
export type UpdateChannel = 'api' | 'auto' | 'self' | 'manual'

/** Everything the caller (API, Telegram bot) needs to report the outcome. */
export interface DeploymentUpdateResult {
  ok: boolean
  /** Which path applies to this deployment (see {@link UpdateChannel}). */
  channel?: UpdateChannel
  /** Upstream has a different file than the one that is deployed. */
  changed?: boolean
  /** Direct link to the fresh worker file (manual path). */
  download_url?: string
  /** Ready-to-run CLI recipe that redeploys the fresh file (manual path). */
  deploy_command?: string
  /** The deployed panel's own dashboard, where the `self` path lives. */
  panel_url?: string
  /** The deployment's own settings carry `CF_API_TOKEN`. */
  self_update?: boolean
  /** Upstream revision of the checked file. */
  latest_commit?: string | null
  /** The worker was re-uploaded with a new upstream revision. */
  updated: boolean
  /** Upstream had nothing new (nothing was uploaded). */
  up_to_date: boolean
  /** The downloaded file passed checksum verification against upstream. */
  verified: boolean
  /** Result of the probe that runs after the upload. */
  self_check: 'passed' | 'failed' | 'skipped'
  /** The update failed and the last known-good revision was restored. */
  rolled_back: boolean
  bytes: number
  source_url: string
  synced_at: string
  message: string
  /** Persian error text when `ok` is false. */
  error?: string
  /** Lines appended to the deployment log, in order (the bot shows them). */
  logs: string[]
}

async function appendLog(env: Env, id: string, line: string): Promise<void> {
  const row = await env.DB.prepare('SELECT logs FROM deployments WHERE id = ?').bind(id).first<{ logs: string | null }>()
  await env.DB.prepare('UPDATE deployments SET logs = ? WHERE id = ?')
    .bind((row?.logs ?? '') + line + '\n', id)
    .run()
}

interface DeploymentRow {
  id: string
  user_id: string
  name: string
  uuid: string | null
  status: string
  method: string
  worker_source: string
  config: string | null
  worker_url: string | null
  cf_account_id: string | null
  cf_token_row_id: string | null
  kv_namespace_id?: string | null
  panel_url?: string | null
}

/**
 * Re-fetch a deployment's worker source from its upstream repository, verify it
 * and deploy it — with a self-check that can roll the deployment back.
 *
 * Shared by `POST /api/deployments/update` and the bot's `/recover`, so the two
 * can never disagree about what "update" means.
 */
export async function runDeploymentUpdate(
  env: Env,
  userId: string,
  id: string,
  options: DeploymentUpdateOptions = {},
): Promise<DeploymentUpdateResult> {
  const logs: string[] = []
  const log = async (line: string): Promise<void> => {
    logs.push(line)
    await appendLog(env, id, line)
  }
  const result = (patch: Partial<DeploymentUpdateResult> & { message: string }): DeploymentUpdateResult => ({
    ok: false,
    updated: false,
    up_to_date: false,
    verified: false,
    self_check: 'skipped',
    rolled_back: false,
    bytes: 0,
    source_url: '',
    synced_at: nowIso(),
    logs,
    ...patch,
  })

  const dep = await env.DB.prepare(
    `SELECT id, user_id, name, uuid, status, method, worker_source, config, worker_url, cf_account_id, cf_token_row_id,
            kv_namespace_id, panel_url
       FROM deployments WHERE id = ? AND user_id = ?`,
  ).bind(id, userId).first<DeploymentRow>()
  if (!dep) return result({ message: 'ورکر پیدا نشد', error: 'ورکر پیدا نشد' })
  if (options.reason !== 'recover' && dep.status !== 'deployed') {
    return result({ message: 'این ورکر هنوز مستقر نشده است', error: 'این ورکر هنوز مستقر نشده است' })
  }
  // ── Which repository do these bytes come from? ──────────────────────────
  // A GitHub deployment re-reads the URL it was created from; a catalogued
  // source is looked up *exactly*. An id this build does not know is a hard
  // failure — the old `?? edgetunnel` fallback is how a Worker created as
  // "Nova" ended up running cmliu's code and could never update itself out of
  // that state, because every "update" re-deployed the wrong project.
  const storedCfg = safeJsonParse<Record<string, unknown>>(dep.config ?? '', {})
  const repoUrl = typeof storedCfg.repo_url === 'string' ? storedCfg.repo_url.trim() : ''
  // Records written before `repo_url` existed (or by an older panel build) may
  // only have the fetched file URL; a GitHub URL there is still re-resolvable.
  const legacySourceUrl =
    typeof storedCfg.source_url === 'string' && /github\.com|raw\.githubusercontent\.com/i.test(storedCfg.source_url)
      ? storedCfg.source_url.trim()
      : ''
  const storedSourceUrl = repoUrl || legacySourceUrl
  let sourceConfig: WorkerSourceConfig
  if (storedSourceUrl) {
    const resolved = await buildGithubSourceConfig(storedSourceUrl)
    if (!resolved.ok) return result({ message: resolved.error, error: resolved.error })
    sourceConfig = resolved.config
  } else {
    const known = lookupWorkerSource(dep.worker_source)
    if (!known) {
      const msg =
        `منبع ورکر «${dep.worker_source}» در این نسخه از پنل شناخته‌شده نیست — به‌روزرسانی انجام نشد تا پنل اشتباهی روی این ورکر نرود.`
      return result({ message: msg, error: msg })
    }
    sourceConfig = known
  }
  if (!sourceConfig.url) {
    return result({ message: 'این منبع ورکر از مخزن قابل به‌روزرسانی نیست', error: 'این منبع ورکر از مخزن قابل به‌روزرسانی نیست' })
  }

  const tokenRow = dep.cf_token_row_id
    ? await env.DB.prepare('SELECT token FROM cf_tokens WHERE id = ? AND user_id = ?')
        .bind(dep.cf_token_row_id, dep.user_id).first<{ token: string }>()
    : await env.DB.prepare(`SELECT token FROM cf_tokens WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`)
        .bind(dep.user_id).first<{ token: string }>()
  // ── No stored token is NOT a dead end ──────────────────────────────────
  // The check above needs no Cloudflare credentials at all (the source comes
  // from this panel's own records, the version from GitHub), so a deployment
  // whose token was removed — or one that was never deployed from here — still
  // gets a real answer: which of the three update paths applies, the fresh file
  // and a ready-to-run command. Previously this was the dead end
  // «توکن فعال Cloudflare برای این ورکر پیدا نشد», which asked the owner for
  // credentials just to find out whether a new version existed.
  if (!tokenRow?.token) {
    return await buildUpdatePlan(env, dep, sourceConfig, { force: options.force === true })
  }
  // Only the upload needs the account id; the check above (and the plan it
  // returns) never did, which is why this guard runs here instead of first.
  if (!dep.cf_account_id) {
    return result({
      message: 'این ورکر account_id ندارد — با «بازیابی» دوباره مستقرش کنید',
      error: 'این ورکر account_id ندارد — با «بازیابی» دوباره مستقرش کنید',
    })
  }

  // ── Pages deployments update too ─────────────────────────────────────
  // Bindings live in the Pages project config; a new main-branch deployment
  // inherits them, so only the source file needs re-uploading. This branch
  // duplicates the guard/skip/self-check/rollback rules of the Workers path so
  // the two can never disagree about what an "update" is.
  if (dep.method === 'pages') {
    return await runPagesDeploymentUpdate(env, dep, sourceConfig, tokenRow.token, options)
  }
  const headers = { Authorization: `Bearer ${tokenRow.token}` }
  const cfg = safeJsonParse<Record<string, unknown>>(dep.config ?? '', {})

  // The bundled copy (`/repo/nexus.js`, …) is read from this deployment's own
  // assets. Passing the relative path to `fetch()` — the old behaviour — threw
  // “Failed to parse URL”, so a CFnew / NEXUS update could never use the copy
  // that is the only one available (both upstream repos are private).
  const fetchResult = await fetchWorkerSource(
    sourceConfig,
    sourceConfig.fallbackUrls ?? [],
    (path) => readBundledAsset(env, path),
  )
  const fetched = fetchResult.source
  for (const line of fetchResult.errors) await log(`⚠ ${line}`)
  if (!fetched) {
    const detail = fetchResult.errors.join(' · ').slice(0, 300)
    await log('✗ no verified upstream source to deploy')
    return result({
      message: 'دریافت سورس سالم از مخزن ناموفق بود — فایل ناقص یا بدون چک‌سام معتبر هرگز مستقر نمی‌شود.',
      error: detail ? `دریافت سورس ناموفق: ${detail}` : 'دریافت سورس از مخزن ناموفق بود',
    })
  }
  await log(
    `✓ source verified (${fetched.code.length} bytes` +
      (fetched.checksumVerified
        ? `, checksum matched upstream ${fetched.commitSha?.slice(0, 8) ?? fetched.blobSha?.slice(0, 8) ?? ''})`
        : ', local checks only — no published checksum for this copy)'),
  )

  const previousEtag = String(cfg.source_etag ?? '')
  const previousSyncedAt = String(cfg.source_synced_at ?? '')

  // Nothing new upstream — say so instead of pushing an identical script.
  if (!options.force && previousEtag && fetched.etag && fetched.etag === previousEtag) {
    await log(`✓ already up to date (${previousSyncedAt || 'unknown sync time'})`)
    return result({
      ok: true,
      up_to_date: true,
      channel: 'api',
      changed: false,
      verified: fetched.checksumVerified,
      self_check: 'passed',
      bytes: fetched.code.length,
      source_url: fetched.url,
      latest_commit: fetched.commitSha ?? null,
      message: 'نسخهٔ مخزن تغییری نکرده — ورکر هم‌اکنون به‌روز است.',
    })
  }

  // Read the live bindings so D1 / R2 / KV / variables survive the re-upload.
  const settingsResp = await fetch(
    `${API_BASE}/accounts/${dep.cf_account_id}/workers/scripts/${dep.name}/settings`,
    { headers },
  )
  const settingsData = (await settingsResp.json().catch(() => ({}))) as {
    success?: boolean
    result?: ScriptSettings
    errors?: Array<{ message: string }>
  }
  const live = settingsData.result
  if (!settingsData.success || !live?.bindings) {
    const msg = settingsData.errors?.[0]?.message ?? `failed to read worker settings (${settingsResp.status})`
    await log(`✗ ${msg}`)
    return result({ message: msg, error: msg })
  }

  // Does the deployed worker carry its own updater? Read from the live
  // bindings, which is the authoritative answer (the owner may have added the
  // variable in the dashboard after this panel deployed it).
  const selfUpdate = (live.bindings as Array<{ name?: string }>).some((b) => b?.name === 'CF_API_TOKEN')

  const meta = {
    main_module: live.main_module || 'worker.js',
    compatibility_date: live.compatibility_date || sourceConfig.compat,
    compatibility_flags: live.compatibility_flags?.length
      ? live.compatibility_flags
      : (sourceConfig.compatFlags ?? ['nodejs_compat', 'global_fetch_strictly_public']),
    bindings: live.bindings,
  }

  /** PUT one verified body over the live script, keeping its bindings. */
  const uploadSource = async (rawCode: string, note: string): Promise<boolean> => {
    const code = optimizeWorkerSourceForColdStart(rawCode, generateUniqueDeploymentSeed(`${dep.id}:${dep.name}:${note}`))
    await log(`${note} uploading source (${rawCode.length} bytes with ${meta.bindings.length} bindings kept)...`)
    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }))
    form.append(meta.main_module, new Blob([code], { type: 'application/javascript+module' }), meta.main_module)
    const uploadResp = await fetch(
      `${API_BASE}/accounts/${dep.cf_account_id}/workers/scripts/${dep.name}`,
      { method: 'PUT', headers, body: form },
    )
    const uploadData = (await uploadResp.json().catch(() => ({}))) as {
      success?: boolean
      errors?: Array<{ message: string }>
    }
    if (!uploadData.success) {
      await log(`✗ ${uploadData.errors?.[0]?.message ?? `upload failed (${uploadResp.status})`}`)
      return false
    }
    return true
  }

  // The source goes up exactly as upstream publishes it: the per-deployment
  // "obfuscated format" was removed entirely (it was incompatible with the
  // Workers runtime and made Cloudflare refuse to run the uploaded script).
  if (!(await uploadSource(fetched.code, '✓'))) {
    return result({
      message: 'آپلود سورس جدید روی ورکر ناموفق بود — نسخهٔ فعلی دست‌نخورده ماند.',
      error: 'آپلود سورس جدید روی ورکر ناموفق بود',
    })
  }

  // ── Self-check: the worker we just replaced has to answer ──────────────
  // Without this, a broken update looks exactly like a good one, and the next
  // panel that follows the same upstream file inherits the breakage.
  const probeUrl = dep.worker_url ?? ''
  let alive = false
  if (probeUrl) {
    await log('self-check: waiting for the worker to answer...')
    alive = await waitForWorkerLive(probeUrl, 12, 1500)
    if (!alive) {
      // One clean retry with the same verified bytes: Cloudflare can leave a
      // freshly written script in a state only a second PUT clears.
      await log('⚠ self-check failed — re-uploading the same verified source once...')
      if (await uploadSource(fetched.code, '↻')) alive = await waitForWorkerLive(probeUrl, 12, 1500)
    }
  } else {
    await log('ℹ no worker URL on record — self-check skipped')
  }

  if (probeUrl && !alive) {
    await log('✗ self-check failed: the worker does not answer after the update')
    // ── Rollback to the revision that was last seen running ───────────────
    // The checksum we store at every successful deploy (and every successful
    // update) is what makes this possible: the same file, at a pinned commit,
    // re-verified before it is sent.
    const goodCommit = String(cfg.source_last_good_commit ?? '')
    const goodUrl = String(cfg.source_last_good_url ?? fetched.url)
    if (goodCommit && goodCommit !== fetched.commitSha) {
      await log(`↩ rolling back to the last known-good revision ${goodCommit.slice(0, 8)}...`)
      const pinned = await fetchPinnedWorkerSource(goodUrl, goodCommit, sourceConfig.expectMarker)
      if (pinned && (await uploadSource(pinned.code, '↩'))) {
        const recovered = await waitForWorkerLive(probeUrl, 12, 1500)
        if (recovered) {
          await log(`✓ rolled back to ${goodCommit.slice(0, 8)} — the worker answers again`)
          await patchDeploymentConfig(env, id, { self_check: 'failed', self_check_at: nowIso() })
          return result({
            verified: true,
            self_check: 'failed',
            rolled_back: true,
            bytes: fetched.code.length,
            source_url: fetched.url,
            message:
              'استقرار نسخهٔ جدید ناموفق بود و ورکر پاسخ نداد؛ نسخهٔ سالم قبلی برگردانده شد. ' +
              'به‌روزرسانی ناموفق ثبت شد تا به بقیهٔ پنل‌های متصل منتقل نشود.',
            error: 'self-check failed — rolled back to the last known-good revision',
          })
        }
        await log('✗ rollback did not bring the worker back')
      } else {
        await log('✗ last known-good revision could not be fetched/verified')
      }
    } else {
      await log('ℹ no previous known-good revision recorded — nothing to roll back to')
    }
    await patchDeploymentConfig(env, id, { self_check: 'failed', self_check_at: nowIso() })
    return result({
      verified: fetched.checksumVerified,
      self_check: 'failed',
      bytes: fetched.code.length,
      source_url: fetched.url,
      message: 'ورکر بعد از به‌روزرسانی پاسخ نداد. در ربات /recover را بزنید یا سورس را دستی روی کلودفلر مستقر کنید.',
      error: 'self-check failed: worker did not answer after the update',
    })
  }

  // ── Success: remember the revision, and that it actually runs ──────────
  await recordSourceFingerprint(env, id, {
    url: fetched.url,
    etag: fetched.etag,
    bytes: fetched.code.length,
    sha256: fetched.sha256,
    commitSha: fetched.commitSha,
    blobSha: fetched.blobSha,
    checksumVerified: fetched.checksumVerified,
    markGood: alive,
  })
  await patchDeploymentConfig(env, id, { self_check: alive ? 'passed' : 'skipped', self_check_at: nowIso() })
  await log(`✓ updated from repository (${fetched.code.length} bytes, bindings preserved)`)

  await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(genId(), userId, 'deployment_updated', 'deployment', dep.name,
      JSON.stringify({ bytes: fetched.code.length, source: fetched.url, checksum_verified: fetched.checksumVerified }), nowIso())
    .run()

  return result({
    ok: true,
    updated: true,
    verified: fetched.checksumVerified,
    self_check: alive ? 'passed' : 'skipped',
    bytes: fetched.code.length,
    source_url: fetched.url,
    channel: 'api',
    changed: true,
    self_update: selfUpdate,
    message: `ورکر از مخزن به‌روز شد (${fetched.code.length} بایت) — چک‌سام تأیید شد و دیتابیس و متغیرها دست‌نخورده ماندند.`,
  })
}

/**
 * The update path for deployments that run on Cloudflare Pages (`method: pages`).
 *
 * Same contract as the Workers path — verified source, “upstream unchanged”
 * shortcut, live self-check and a rollback to the last known-good revision —
 * but the upload targets the Pages project instead of the Workers script API.
 * Bindings (KV/D1/vars) live in the project config and are inherited by the new
 * main-branch deployment, so bindings never need to be read back.
 */
/**
 * A CLI recipe that redeploys the fresh upstream file with the SAME bindings
 * the deployment runs with. Printed (never executed) when this panel has no
 * token for the account: the owner runs it with their own `wrangler login`.
 */
function buildDeployCommand(input: {
  method: string
  name: string
  url: string
  compat: string
  uuid: string
  uuidEnv: string
  d1Id: string
  d1Name: string
  kvId: string
  kvBinding: string
}): string {
  const d1 = input.d1Id
    ? `\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${input.d1Name || `${input.name}-db`}"\ndatabase_id = "${input.d1Id}"`
    : ''
  const kv = input.kvId && input.kvBinding
    ? `\n[[kv_namespaces]]\nbinding = "${input.kvBinding}"\nid = "${input.kvId}"`
    : ''
  const uuidVar = input.uuidEnv && input.uuid
    ? `\n[vars]\n${input.uuidEnv} = "${input.uuid}"`
    : ''
  if (input.method === 'pages') {
    // Pages keeps bindings in the project config, so only the new `_worker.js`
    // has to be uploaded — the same "advanced mode" layout this panel builds.
    return `mkdir -p panel && cd panel
curl -L -o _worker.js "${input.url}"
npx wrangler pages deploy . --project-name "${input.name}" --commit-dirty=true`
  }
  return `curl -L -o _worker.js "${input.url}"
cat > wrangler.toml <<'TOML'
name = "${input.name}"
main = "_worker.js"
compatibility_date = "${input.compat}"${d1}${kv}${uuidVar}
TOML
npx wrangler deploy`
}

/**
 * Answer an update request that this panel cannot upload itself: what changed,
 * which path applies, the fresh file and a ready-to-run command. Needs no
 * Cloudflare credentials — only this panel's records and GitHub.
 */
async function buildUpdatePlan(
  env: Env,
  dep: DeploymentRow,
  sourceConfig: WorkerSourceConfig,
  options: { force: boolean },
): Promise<DeploymentUpdateResult> {
  const logs: string[] = []
  const log = async (line: string): Promise<void> => {
    logs.push(line)
    await appendLog(env, dep.id, line)
  }
  const result = (patch: Partial<DeploymentUpdateResult> & { message: string }): DeploymentUpdateResult => ({
    ok: false,
    updated: false,
    up_to_date: false,
    verified: false,
    self_check: 'skipped',
    rolled_back: false,
    bytes: 0,
    source_url: '',
    synced_at: nowIso(),
    logs,
    ...patch,
  })

  const cfg = safeJsonParse<Record<string, unknown>>(dep.config ?? '', {})
  const fetchResult = await fetchWorkerSource(
    sourceConfig,
    sourceConfig.fallbackUrls ?? [],
    (path) => readBundledAsset(env, path),
  )
  const fetched = fetchResult.source
  if (!fetched) {
    const detail = fetchResult.errors.join(' · ').slice(0, 300)
    await log('✗ no verified upstream source to read')
    return result({
      message: 'خواندن نسخهٔ تازه از مخزن ناموفق بود — دوباره تلاش کنید.',
      error: detail ? `دریافت سورس ناموفق: ${detail}` : 'دریافت سورس از مخزن ناموفق بود',
    })
  }

  const previousEtag = String(cfg.source_etag ?? '')
  const previousSyncedAt = String(cfg.source_synced_at ?? '')
  const changed = !previousEtag || !fetched.etag || fetched.etag !== previousEtag
  const downloadUrl = fetched.url
  const panelUrl = dep.panel_url || dep.worker_url || String(cfg.panel_url ?? '')
  // `self` is reported from this panel's own record of what it deployed (the
  // flag written at deploy time), because reading it live would need exactly
  // the token this path does not have.
  const selfUpdate = cfg.self_update_token === true
  const githubLinked = typeof cfg.repo_url === 'string' && cfg.repo_url.trim().length > 0
  const channel: UpdateChannel = githubLinked ? 'auto' : selfUpdate ? 'self' : 'manual'
  const deployCommand = buildDeployCommand({
    method: dep.method,
    name: dep.name,
    url: downloadUrl,
    compat: sourceConfig.compat,
    uuid: dep.uuid ?? '',
    uuidEnv: sourceConfig.uuidEnvName,
    d1Id: String(cfg.d1_database_id ?? ''),
    d1Name: String(cfg.d1_database_name ?? ''),
    kvId: String(dep.kv_namespace_id ?? ''),
    kvBinding: sourceConfig.kvBinding,
  })

  const version = fetched.commitSha ? fetched.commitSha.slice(0, 8) : 'آخرین نسخهٔ مخزن'
  const state = changed
    ? `نسخهٔ تازه در مخزن هست (${version})`
    : 'نسخهٔ مخزن نسبت به آنچه مستقر است تغییری نکرده'
  const how =
    channel === 'auto'
      ? 'این ورکر به مخزن گیت‌هاب وصل است، پس نسخهٔ تازه خودکار با پوش جدید مستقر می‌شود — کاری لازم نیست. اگر خودکار بالا نیامد، فایل تازه یا دستور زیر را اجرا کنید.'
      : channel === 'self'
        ? 'این استقرار متغیر CF_API_TOKEN را در تنظیمات خود ورکر دارد، پس خودِ پنل می‌تواند نسخهٔ تازه را از داخل خودش نصب کند — لینک پنل را باز کنید و گزینهٔ به‌روزرسانی را بزنید.'
        : 'فایل تازه را دانلود کنید یا دستور آمادهٔ زیر را اجرا کنید. برای فعال‌شدن نصب خودکار از داخل پنل، متغیر CF_API_TOKEN را در تنظیمات همین ورکر تعریف کنید.'
  await log(`↻ update check (${channel}): ${changed ? `new upstream ${version}` : 'upstream unchanged'}${previousSyncedAt ? ` · last sync ${previousSyncedAt}` : ''}`)

  return result({
    ok: true,
    channel,
    changed,
    up_to_date: !changed && !options.force,
    verified: fetched.checksumVerified,
    bytes: fetched.code.length,
    source_url: fetched.url,
    download_url: downloadUrl,
    deploy_command: deployCommand,
    panel_url: panelUrl,
    self_update: selfUpdate,
    latest_commit: fetched.commitSha ?? null,
    message: `${state}. ${how}`,
  })
}

async function runPagesDeploymentUpdate(
  env: Env,
  dep: DeploymentRow,
  sourceConfig: WorkerSourceConfig,
  cfToken: string,
  options: DeploymentUpdateOptions,
): Promise<DeploymentUpdateResult> {
  const logs: string[] = []
  const log = async (line: string): Promise<void> => {
    logs.push(line)
    await appendLog(env, dep.id, line)
  }
  const result = (patch: Partial<DeploymentUpdateResult> & { message: string }): DeploymentUpdateResult => ({
    ok: false,
    updated: false,
    up_to_date: false,
    verified: false,
    self_check: 'skipped',
    rolled_back: false,
    bytes: 0,
    source_url: '',
    synced_at: nowIso(),
    logs,
    ...patch,
  })
  const id = dep.id
  const headers = { Authorization: `Bearer ${cfToken}` }
  const cfg = safeJsonParse<Record<string, unknown>>(dep.config ?? '', {})

  await log(options.reason === 'recover' ? '♻ recovering Pages deployment from its source repository...' : '↻ checking upstream repository...')
  const fetchResult = await fetchWorkerSource(
    sourceConfig,
    sourceConfig.fallbackUrls ?? [],
    (path) => readBundledAsset(env, path),
  )
  const fetched = fetchResult.source
  for (const line of fetchResult.errors) await log(`⚠ ${line}`)
  if (!fetched) {
    const detail = fetchResult.errors.join(' · ').slice(0, 300)
    await log('✗ no verified upstream source to deploy')
    return result({
      message: 'دریافت سورس سالم از مخزن ناموفق بود — فایل ناقص یا بدون چک‌سام معتبر هرگز روی Pages مستقر نمی‌شود.',
      error: detail ? `دریافت سورس ناموفق: ${detail}` : 'دریافت سورس از مخزن ناموفق بود',
    })
  }
  await log(
    `✓ source verified (${fetched.code.length} bytes` +
      (fetched.checksumVerified
        ? `, checksum matched upstream ${fetched.commitSha?.slice(0, 8) ?? fetched.blobSha?.slice(0, 8) ?? ''})`
        : ', local checks only — no published checksum for this copy)'),
  )

  const previousEtag = String(cfg.source_etag ?? '')
  const previousSyncedAt = String(cfg.source_synced_at ?? '')
  if (!options.force && previousEtag && fetched.etag && fetched.etag === previousEtag) {
    await log(`✓ already up to date (${previousSyncedAt || 'unknown sync time'})`)
    return result({
      ok: true,
      up_to_date: true,
      channel: 'api',
      changed: false,
      verified: fetched.checksumVerified,
      self_check: 'passed',
      bytes: fetched.code.length,
      source_url: fetched.url,
      latest_commit: fetched.commitSha ?? null,
      message: 'نسخهٔ مخزن تغییری نکرده — این استقرار هم‌اکنون به‌روز است.',
    })
  }

  /** One Pages deployment of the given verified bytes. */
  const upload = async (rawCode: string, note: string): Promise<boolean> => {
    const code = optimizeWorkerSourceForColdStart(rawCode, generateUniqueDeploymentSeed(`${dep.id}:${dep.name}:${note}`))
    await log(`${note} uploading source to Pages (${rawCode.length} bytes)...`)
    const up = await uploadPagesDeployment(dep.cf_account_id ?? '', dep.name, code, headers, sourceConfig.compat, sourceConfig.compatFlags ?? ['nodejs_compat', 'global_fetch_strictly_public'])
    if (!up.ok) {
      await log(`✗ ${up.error ?? 'Pages deployment failed'}`)
      return false
    }
    return true
  }

  if (!(await upload(fetched.code, '✓'))) {
    return result({
      message: 'آپلود نسخهٔ جدید روی Pages ناموفق بود — استقرار فعلی دست‌نخورده ماند.',
      error: 'آپلود سورس جدید روی Pages ناموفق بود',
    })
  }

  // ── Self-check: the project has to answer after the redeployment ──────
  const probeUrl = dep.worker_url ?? ''
  let alive = false
  if (probeUrl && dep.cf_account_id) {
    await log('self-check: waiting for the Pages deployment to answer...')
    alive = await waitForWorkerLive(probeUrl, 8, 2000)
    if (!alive) {
      await log('⚠ self-check failed — re-uploading the same verified source once...')
      if (await upload(fetched.code, '↻')) alive = await waitForWorkerLive(probeUrl, 8, 2000)
    }
  } else {
    await log('ℹ no public URL on record — self-check skipped')
  }

  if (probeUrl && !alive) {
    await log('✗ self-check failed: the Pages deployment does not answer after the update')
    // Rollback to the revision that was last seen running — same pinned-commit
    // re-verification as the Workers path.
    const goodCommit = String(cfg.source_last_good_commit ?? '')
    const goodUrl = String(cfg.source_last_good_url ?? fetched.url)
    if (goodCommit && goodCommit !== fetched.commitSha) {
      await log(`↩ rolling back to the last known-good revision ${goodCommit.slice(0, 8)}...`)
      const pinned = await fetchPinnedWorkerSource(goodUrl, goodCommit, sourceConfig.expectMarker)
      if (pinned && (await upload(pinned.code, '↩'))) {
        const recovered = await waitForWorkerLive(probeUrl, 8, 2000)
        if (recovered) {
          await log(`✓ rolled back to ${goodCommit.slice(0, 8)} — the deployment answers again`)
          await patchDeploymentConfig(env, id, { self_check: 'failed', self_check_at: nowIso() })
          return result({
            verified: true,
            self_check: 'failed',
            rolled_back: true,
            bytes: fetched.code.length,
            source_url: fetched.url,
            message:
              'استقرار نسخهٔ جدید روی Pages ناموفق بود و سرویس پاسخ نداد؛ نسخهٔ سالم قبلی برگردانده شد.',
            error: 'self-check failed — rolled back to the last known-good revision',
          })
        }
        await log('✗ rollback did not bring the deployment back')
      } else {
        await log('✗ last known-good revision could not be fetched/verified')
      }
    } else {
      await log('ℹ no previous known-good revision recorded — nothing to roll back to')
    }
    await patchDeploymentConfig(env, id, { self_check: 'failed', self_check_at: nowIso() })
    return result({
      verified: fetched.checksumVerified,
      self_check: 'failed',
      bytes: fetched.code.length,
      source_url: fetched.url,
      message: 'استقرار Pages بعد از به‌روزرسانی پاسخ نداد. چند دقیقه بعد دوباره تست کنید یا /recover را بزنید.',
      error: 'self-check failed: Pages deployment did not answer after the update',
    })
  }

  await recordSourceFingerprint(env, id, {
    url: fetched.url,
    etag: fetched.etag,
    bytes: fetched.code.length,
    sha256: fetched.sha256,
    commitSha: fetched.commitSha,
    blobSha: fetched.blobSha,
    checksumVerified: fetched.checksumVerified,
    markGood: alive,
  })
  await patchDeploymentConfig(env, id, { self_check: alive ? 'passed' : 'skipped', self_check_at: nowIso() })
  await log(`✓ updated from repository (${fetched.code.length} bytes, Pages project bindings preserved)`)

  await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(genId(), dep.user_id, 'deployment_updated', 'deployment', dep.name,
      JSON.stringify({ bytes: fetched.code.length, source: fetched.url, checksum_verified: fetched.checksumVerified, platform: 'pages' }), nowIso())
    .run()

  return result({
    ok: true,
    updated: true,
    verified: fetched.checksumVerified,
    self_check: alive ? 'passed' : 'skipped',
    bytes: fetched.code.length,
    source_url: fetched.url,
    channel: 'api',
    changed: true,
    message: `استقرار Pages از مخزن به‌روز شد (${fetched.code.length} بایت) — چک‌سام تأیید شد و بایندینگ‌ها دست‌نخورده ماندند.`,
  })
}

/**
 * POST /api/deployments/update — re-fetch the deployment's worker source from
 * its upstream repository and deploy it if it changed.
 */
export async function handleDeploymentUpdate(env: Env, userId: string, request: Request): Promise<Response> {
  const body = safeJsonParse<UpdateBody>(await request.text().catch(() => ''), {})
  const id = body.deployment_id ?? ''
  if (!id) return apiError('deployment_id الزامی است', 400)

  // `force` is the same switch the bot's /recover uses: re-deploy even when
  // upstream did not change, and accept a deployment that is not marked
  // `deployed` — a worker stuck on 1101 is exactly that, and re-deploying its
  // source is the only thing that can bring it back.
  const out = await runDeploymentUpdate(env, userId, id, {
    force: body.force === true,
    reason: body.force === true ? 'recover' : 'manual',
  })

  if (!out.ok) {
    // The failure text is what the UI shows, so it carries the reason (checksum
    // mismatch, self-check failure, rollback) instead of a generic message.
    return apiError(out.error ?? out.message, 502)
  }
  return json({
    success: true,
    updated: out.updated,
    up_to_date: out.up_to_date,
    checksum_verified: out.verified,
    self_check: out.self_check,
    rolled_back: out.rolled_back,
    bytes: out.bytes,
    source_url: out.source_url,
    synced_at: out.synced_at,
    message: out.message,
    // The three update paths: which one applies, and everything the UI needs to
    // render the manual one (fresh file + ready-to-run command) without asking
    // the owner for any Cloudflare credentials.
    channel: out.channel,
    changed: out.changed,
    download_url: out.download_url,
    deploy_command: out.deploy_command,
    panel_url: out.panel_url,
    self_update: out.self_update,
    latest_commit: out.latest_commit,
  })
}
