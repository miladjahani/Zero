import type { Env } from './env'
import { apiError, json } from './util'
import { kvGet, kvPut } from './cfapi'
import { workerSourceConfig } from './deploy'

/**
 * KV keys per worker source, read from that source's own deploy spec instead of
 * a second hand-kept table. The previous copy listed only four ids and silently
 * fell back to edgetunnel's `config.json` for everything else, so an unknown or
 * D1-backed source (nova, zeus, miliconfigzeus) was read with the wrong key —
 * the config shown in the panel was simply not that worker's config.
 *
 * `addTxt` stays `ADD.txt` for every KV-backed source (it is the key all the
 * cmliu-family workers and CFnew use for the custom-IP list).
 */
function getKvKeys(workerSource: string | null): { config: string; addTxt: string } | null {
  const spec = workerSourceConfig(workerSource)
  // Sources without a config KV entry (zeus-style D1 panels) must not be read
  // with another source's key at all.
  if (!spec.configKey) return null
  return { config: spec.configKey, addTxt: 'ADD.txt' }
}

/** Strip admin secrets from an edgetunnel config before it leaves the server. */
function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const safe = { ...config }
  if (safe.CF && typeof safe.CF === 'object') {
    safe.CF = { ...(safe.CF as Record<string, unknown>), Email: null, GlobalAPIKey: null, AccountID: null, APIToken: null, UsageAPI: null }
  }
  if (safe.TG && typeof safe.TG === 'object') {
    const tg = safe.TG as Record<string, unknown>
    safe.TG = { 启用: tg.启用 ?? false, BotToken: tg.BotToken ? '****' : null, ChatID: tg.ChatID ?? null }
  }
  delete safe.ADMIN
  delete safe.admin
  delete safe.PASSWORD
  delete safe.password
  delete safe.pswd
  return safe
}

interface WorkerConfigBody {
  deployment_id?: string
  action?: 'get' | 'set' | 'toggle' | 'set_addtxt'
  config?: Record<string, unknown>
  addTxt?: string
}

export async function handleWorkerConfig(env: Env, userId: string, body: WorkerConfigBody): Promise<Response> {
  if (!body.deployment_id) return apiError('deployment_id الزامی است', 400)

  const dep = await env.DB.prepare(
    `SELECT id, cf_account_id, kv_namespace_id, config FROM deployments WHERE id = ? AND user_id = ?`,
  )
    .bind(body.deployment_id, userId)
    .first<{ id: string; cf_account_id: string | null; kv_namespace_id: string | null; config: string }>()
  if (!dep) return apiError('ورکر پیدا نشد', 404)

  const accountId = dep.cf_account_id ?? ''
  const kvNs = dep.kv_namespace_id ?? ''
  const workerSource = (JSON.parse(dep.config || '{}') as Record<string, unknown>).worker_source as string ?? 'edgetunnel'
  const keys = getKvKeys(workerSource)
  if (!keys) {
    return apiError('این سورس تنظیمات KV ندارد (پنل D1-محور است) — کاربران و کانفیگ‌ها را داخل پنل خودش مدیریت کنید.', 400)
  }

  if (!accountId || !kvNs) {
    return apiError('این ورکر account_id یا kv_namespace_id ندارد. ابتدا از طریق پنل استقرار مجدد انجام دهید.', 400)
  }

  // Use the most recent active token (same policy as deploy).
  const tokenRow = await env.DB.prepare(
    `SELECT token FROM cf_tokens WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(userId)
    .first<{ token: string }>()
  if (!tokenRow?.token) {
    return apiError('هیچ توکن فعال Cloudflare وجود ندارد. ابتدا یک توکن با دسترسی Workers KV Storage:Read+Edit اضافه کنید.', 400)
  }
  const cfToken = tokenRow.token

  // ── GET ────────────────────────────────────────────────────────────────
  if (body.action === 'get') {
    const r = await kvGet(accountId, kvNs, keys.config, cfToken)
    if (r.status === 404) return json({ success: true, config: {}, addTxt: '' })
    if (!r.ok) {
      const hint =
        r.status === 401 ? ' — توکن شما دسترسی Workers KV Storage:Read ندارد؛ از تب «توکن‌ها» یک توکن با لینک از پیش پر شدهٔ کلودفلر بسازید'
        : r.status === 403 ? ' — دسترسی رد شد، namespace ID را بررسی کنید'
        : ''
      return apiError(`KV read failed ${r.status}${hint}`, 502)
    }
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(r.text) } catch { /* keep empty */ }
    const addResp = await kvGet(accountId, kvNs, keys.addTxt, cfToken)
    return json({ success: true, config: sanitizeConfig(parsed), addTxt: addResp.ok ? addResp.text : '' })
  }

  // ── SET ────────────────────────────────────────────────────────────────
  if (body.action === 'set') {
    if (!body.config) return apiError('config الزامی است', 400)

    const safeConfig: Record<string, unknown> = { ...body.config }
    if (safeConfig.CF && typeof safeConfig.CF === 'object') {
      safeConfig.CF = { ...(safeConfig.CF as Record<string, unknown>), Email: null, GlobalAPIKey: null, AccountID: null, APIToken: null, UsageAPI: null }
    }
    // Preserve the real Telegram bot token when the frontend sends the masked value.
    if (safeConfig.TG && typeof safeConfig.TG === 'object') {
      const tg = safeConfig.TG as Record<string, unknown>
      if (tg.BotToken === '****' || tg.BotToken === null) {
        const existing = await kvGet(accountId, kvNs, keys.config, cfToken)
        if (existing.ok) {
          try { tg.BotToken = (JSON.parse(existing.text) as { TG?: { BotToken?: string | null } })?.TG?.BotToken ?? null } catch { /* keep masked */ }
        }
      }
    }
    delete safeConfig.ADMIN
    delete safeConfig.admin
    delete safeConfig.PASSWORD
    delete safeConfig.password
    delete safeConfig.pswd

    const wr = await kvPut(accountId, kvNs, keys.config, JSON.stringify(safeConfig, null, 2), cfToken)
    if (!wr.ok) {
      const hint =
        wr.status === 401 ? ' — توکن شما نیاز به دسترسی Workers KV Storage:Edit دارد؛ از تب «توکن‌ها» یک توکن با لینک از پیش پر شدهٔ کلودفلر بسازید'
        : wr.status === 403 ? ' — دسترسی رد شد'
        : ''
      return apiError(`KV write failed ${wr.status}${hint}`, 502)
    }

    await env.DB.prepare('UPDATE deployments SET config = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(sanitizeConfig(safeConfig)), new Date().toISOString(), body.deployment_id)
      .run()
    return json({ success: true, message: 'تنظیمات در KV ورکر ذخیره شد' })
  }

  // ── SET ADD.txt ────────────────────────────────────────────────────────
  if (body.action === 'set_addtxt') {
    const wr = await kvPut(accountId, kvNs, keys.addTxt, body.addTxt ?? '', cfToken, 'text/plain')
    if (!wr.ok) return apiError(`KV write failed ${wr.status}`, 502)
    return json({ success: true, message: 'لیست IPهای سفارشی ذخیره شد' })
  }

  // ── TOGGLE ─────────────────────────────────────────────────────────────
  if (body.action === 'toggle') {
    const r = await kvGet(accountId, kvNs, keys.config, cfToken)
    let current: Record<string, unknown> = {}
    if (r.ok) { try { current = JSON.parse(r.text) } catch { /* start fresh */ } }

    const newDisabled = !(current.disabled === true)
    const next = { ...current, disabled: newDisabled }

    const wr = await kvPut(accountId, kvNs, keys.config, JSON.stringify(next, null, 2), cfToken)
    if (!wr.ok) return apiError(`KV write failed ${wr.status}`, 502)
    return json({ success: true, disabled: newDisabled })
  }

  return apiError('action نامعتبر است', 400)
}
