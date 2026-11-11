import type { Env } from './env'
import { genId, nowIso, safeJsonParse } from './util'
import { PANELS, panelsForTarget, panelOriginLabel, panelVerifiedLabel, RAILWAY_REGIONS, railwayRegionFromCode, railwayRegionLabel, resolvePanel, resolveRailwayRegion } from '../shared/panels'
import { autoWorkerSources } from '../shared/worker-sources'
import { parseGithubSourceUrl } from '../shared/github-source'
import { startDeployment } from './deploy'
import { runDeploymentUpdate } from './update'
import {
  startPanelDeploy,
  updatePanelSettings,
  watchPanelDeploy,
  type PanelSettingsPatch,
  type PanelWatchResult,
  type StartPanelDeployResult,
} from './panel-deploy'
import {
  deleteTokenRow,
  findToken,
  handleTokenPaste,
  isTokenKind,
  kindSpec,
  tokenAddScreen,
  tokenDeleteScreen,
  tokensScreen,
  toggleTokenRow,
} from './bot-tokens'
import {
  type BotConfigRow, type BotSession, type BotTenant, type Screen, type ScreenCtx, type TgButton,
  clearSession, diagnoseDeployError, faDate, FORCE_JOIN_CHANNEL, FORCE_JOIN_URL, loadSession, renderProgressBar, renderScreen, saveSession, sendMsg, statusIcon, subUrlOf, tenantByToken,
} from './telegram-core'

// ══════════════════════════════════════════════════════════════════════════════
//  Telegram UI — every screen of the bot plus the router that turns a command
//  or a button press into exactly one screen.
//
//  Design rules:
//   • Every screen is ONE message, edited in place (no chat spam).
//   • Persistent reply keyboard = the app's tabs, inline keyboard = actions.
//   • Callback payloads carry row ids (never names) so `callback_data` stays
//     well inside Telegram's 64-byte limit.
//   • Data screens are owner/admin only; strangers get a polite gate with a
//     "request access" button that pings the owner.
// ══════════════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 6

/**
 * Display names of sources that left the catalog but still have deployments in
 * the field. Without them a card would print the raw `worker_source` id.
 */
const RETIRED_SOURCE_NAMES: Record<string, string> = { miliconfigosv3: 'miliconfigOS v3 (پیشین)' }

const sourceName = (id: string | null | undefined): string =>
  autoWorkerSources().find((s) => s.id === (id ?? ''))?.name ?? RETIRED_SOURCE_NAMES[id ?? ''] ?? id ?? '—'

/**
 * Telegram rejects any `callback_data` longer than 64 bytes with
 * BUTTON_DATA_INVALID — and it rejects the whole message, so one oversized
 * button silently removes the entire keyboard. Every payload this module builds
 * has to stay inside the limit, which is why ids in payloads are short codes and
 * `scripts/smoke-bot-keyboards.ts` asserts the length of every button it renders.
 */
export const CALLBACK_LIMIT = 64

/** Byte length of a callback payload, counted the way Telegram counts it. */
export function callbackBytes(data: string): number {
  return new TextEncoder().encode(data).length
}

// ── Persistent reply keyboard = the app tabs ─────────────────────────────────

/**
 * The bot is a standalone **deployer**: its tabs are deployment-only.
 * Panel management screens (dashboard, optimizer, subscribers, panel users,
 * settings) deliberately do not exist here — the bot has no other job and no
 * other connection to the panel.
 */
export const MENU = {
  workers: '📋 ورکرها',
  panels: '🧩 پنل‌ها',
  servers: '🖥 سرورها',
  tokens: '🔑 توکن‌ها',
  profile: '👤 پروفایل من',
  help: '📖 راهنما',
} as const

export function replyKeyboard(): Record<string, unknown> {
  return {
    keyboard: [
      [MENU.workers, MENU.tokens],
      [MENU.panels, MENU.servers],
      [MENU.profile, MENU.help],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'یک گزینه را انتخاب کنید',
  }
}

const homeButton = (): TgButton => ({ text: '🏠 منوی اصلی', callback_data: 'n:menu' })
const backButton = (target: string, label = '🔙 بازگشت'): TgButton => ({ text: label, callback_data: target })

/**
 * The forced-membership gate shown before any bot feature is reachable.
 *
 * The only way past it is the "✅ عضو شدم" button, which re-runs the live
 * `getChatMember` check (see `handleTelegramWebhook`) — a user cannot dismiss it
 * by typing anything, so the channel join really is a precondition.
 */
export function joinRequiredScreen(): Screen {
  return {
    text:
      '🔒 <b>عضویت اجباری در کانال</b>\n\n' +
      'برای استفاده از ربات ابتدا باید در کانال زیر عضو شوید:\n\n' +
      `📢 <a href="${FORCE_JOIN_URL}">@${FORCE_JOIN_CHANNEL}</a>\n\n` +
      'بعد از عضویت، دکمهٔ «✅ عضو شدم» را بزنید تا امکانات ربات باز شود.',
    keyboard: {
      inline_keyboard: [
        [{ text: '📢 عضویت در کانال', url: FORCE_JOIN_URL, style: 'primary' }],
        [{ text: '✅ عضو شدم', callback_data: 'join:check', style: 'success' }],
      ],
    },
  }
}

function paginate<T>(rows: T[], page: number): { slice: T[]; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safe = Math.min(Math.max(0, page), pages - 1)
  return { slice: rows.slice(safe * PAGE_SIZE, safe * PAGE_SIZE + PAGE_SIZE), pages, page: safe }
}

function pagerRow(kind: string, page: number, pages: number): TgButton[] | null {
  if (pages <= 1) return null
  return [
    { text: '◀️', callback_data: `l:${kind}:${Math.max(0, page - 1)}` },
    { text: `صفحهٔ ${page + 1} از ${pages}`, callback_data: 'noop' },
    { text: '▶️', callback_data: `l:${kind}:${Math.min(pages - 1, page + 1)}` },
  ]
}

// ── Screens ──────────────────────────────────────────────────────────────────

export function menuScreen(ctx: ScreenCtx): Screen {
  const welcome = ctx.cfg.welcome_message?.trim() || '🚀 به ربات استقرار میلی‌کانفیگ خوش آمدید.'
  // Colour carries meaning, so it stays rare: green = the one action that
  // creates something, blue = every navigation button, and nothing else.
  const rows: TgButton[][] = [
    [{ text: '🚀 استقرار جدید', callback_data: 'dpl:start', style: 'success' }],
    [
      { text: '📋 ورکرها', callback_data: 'l:workers:0', style: 'primary' },
      { text: '🔑 توکن‌های من', callback_data: 'n:tokens', style: 'primary' },
    ],
    [
      { text: '🧩 پنل‌های آماده', callback_data: 'l:panels:0', style: 'primary' },
      { text: '🖥 سرورها', callback_data: 'l:servers:0', style: 'primary' },
    ],
    [
      { text: '👤 پروفایل من', callback_data: 'n:profile', style: 'primary' },
      { text: '♻️ بازیابی ۱۱۰۱', callback_data: 'n:recover', style: 'primary' },
    ],
    [
      { text: '📖 راهنما', callback_data: 'n:help', style: 'primary' },
      { text: '🔍 جست‌وجو', callback_data: 'n:search', style: 'primary' },
    ],
  ]
  return {
    text:
      `${welcome}\n\n` +
      '<b>منوی اصلی</b>\n' +
      '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n' +
      'این ربات فقط برای <b>استقرار</b> است: ورکر کلودفلر یا پنل روی Railway/Render — با توکن خودتان.\n' +
      'هر صفحه در همین پیام به‌روز می‌شود.',
    keyboard: { inline_keyboard: rows },
  }
}

/**
 * The user's own space: their unique token + personal deep link and their
 * deployment counters. The bot has no panel account, so this — and the deploy
 * screens — is the whole relationship between the bot and its users.
 */
export async function profileScreen(ctx: ScreenCtx): Promise<Screen> {
  const { env } = ctx
  const [tokens, deployed, failed, rails, renders, me, latest] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS c FROM cf_tokens WHERE user_id = ?').bind(ctx.userId).first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM deployments WHERE user_id = ? AND status = 'deployed'").bind(ctx.userId).first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM deployments WHERE user_id = ? AND status = 'failed'").bind(ctx.userId).first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS c FROM railway_deploys WHERE user_id = ?').bind(ctx.userId).first<{ c: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS c FROM render_deploys WHERE user_id = ?').bind(ctx.userId).first<{ c: number }>(),
    env.DB.prepare('SELECT access_token, created_at FROM bot_tenants WHERE telegram_id = ?')
      .bind(ctx.telegramId).first<{ access_token: string; created_at: string }>(),
    env.DB.prepare('SELECT id, name, status, created_at FROM deployments WHERE user_id = ? ORDER BY created_at DESC LIMIT 3')
      .bind(ctx.userId).all<{ id: string; name: string; status: string; created_at: string }>(),
  ])

  const token = ctx.tenant?.access_token ?? me?.access_token ?? '—'
  const link = ctx.botUsername ? `https://t.me/${ctx.botUsername}?start=${token}` : `t.me/<bot>?start=${token}`
  let text =
    '👤 <b>فضای استقرار شما</b>\n\n' +
    `🆔 شناسهٔ تلگرام: <code>${ctx.telegramId}</code>\n` +
    `🔑 توکن اختصاصی شما: <code>${token}</code>\n` +
    `🔗 لینک اختصاصی: <code>${link}</code>\n\n` +
    '<i>این لینک و توکن فقط مال شماست؛ با آن همیشه به فضای خودتان برمی‌گردید. توکن‌ها، ورکرها و استقرارهای هیچ کاربر دیگری برای شما نمایش داده نمی‌شود و شما هم به آن‌ها دسترسی ندارید.</i>\n\n' +
    `🔑 توکن‌های ثبت‌شده: <b>${tokens?.c ?? 0}</b>\n` +
    `🚀 ورکرهای فعال: <b>${deployed?.c ?? 0}</b>${failed?.c ? ` · ناموفق: ${failed.c}` : ''}\n` +
    `🏗 پنل Railway: <b>${rails?.c ?? 0}</b> · ☁️ پنل Render: <b>${renders?.c ?? 0}</b>\n`
  if (latest.results.length) {
    text += '\n<b>آخرین استقرارها</b>\n'
    for (const d of latest.results) text += `${statusIcon(d.status)} <code>${d.name}</code> · ${faDate(d.created_at)}\n`
  }
  if (me?.created_at) text += `\n📅 عضویت: ${faDate(me.created_at)}`

  return {
    text,
    keyboard: {
      inline_keyboard: [
        [{ text: '📋 کپی لینک اختصاصی', callback_data: `cpf:${token}`, style: 'success' }],
        [
          { text: '🔄 بروزرسانی', callback_data: 'n:profile', style: 'primary' },
          { text: '🔑 توکن‌های من', callback_data: 'n:tokens', style: 'primary' },
        ],
        [
          { text: '📋 ورکرها', callback_data: 'l:workers:0', style: 'primary' },
          { ...homeButton(), style: 'primary' },
        ],
      ],
    },
  }
}

interface DeploymentRow {
  id: string
  name: string
  status: string
  worker_url: string | null
  panel_url: string | null
  sub_url?: string | null
  error_message?: string | null
  uuid: string | null
  custom_path: string | null
  method: string | null
  worker_source: string | null
  created_at: string
}

const DEPLOYMENT_COLUMNS = 'id, name, status, worker_url, panel_url, sub_url, error_message, uuid, custom_path, method, worker_source, created_at'

export async function workersScreen(ctx: ScreenCtx, page: number): Promise<Screen> {
  const rows = await ctx.env.DB.prepare(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
  ).bind(ctx.userId).all<DeploymentRow>()
  if (!rows.results.length) {
    return {
      text: '📋 <b>ورکرها</b>\n\nهنوز ورکری مستقر نکرده‌اید.\nبا دکمهٔ «🚀 استقرار ورکر جدید» اولین ورکر را بسازید.',
      keyboard: { inline_keyboard: [[{ text: '🚀 استقرار ورکر جدید', callback_data: 'dpl:start' }], [homeButton()]] },
    }
  }
  const { slice, pages, page: current } = paginate(rows.results, page)
  const keyboard: TgButton[][] = slice.map((d) => {
    const hasSub = !!subUrlOf(d)
    const quickLabel = d.status !== 'deployed' ? '⏳' : hasSub ? '📋 ساب' : '🔐 پنل'
    const quickCb = d.status !== 'deployed' ? 'noop' : hasSub ? `cp:${d.id}:sub` : `cp:${d.id}:panel`
    return [
      { text: `${statusIcon(d.status)} ${d.name}`, callback_data: `w:${d.id}`, style: 'primary' },
      { text: quickLabel, callback_data: quickCb },
    ]
  })
  const pager = pagerRow('workers', current, pages)
  if (pager) keyboard.push(pager)
  keyboard.push([
    { text: '🔄 بروزرسانی', callback_data: `l:workers:${current}`, style: 'primary' },
    { text: '🚀 استقرار جدید', callback_data: 'dpl:start', style: 'success' },
  ])
  keyboard.push([homeButton()])
  return {
    text: `📋 <b>ورکرها</b> — ${rows.results.length} مورد\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\nروی هر ورکر بزنید تا ساب، پنل و جزئیاتش را ببینید.`,
    keyboard: { inline_keyboard: keyboard },
  }
}

export async function workerScreen(ctx: ScreenCtx, id: string): Promise<Screen> {
  const d = await ctx.env.DB.prepare(
    `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = ? AND user_id = ?`,
  ).bind(id, ctx.userId).first<DeploymentRow>()
  if (!d) {
    return { text: '❌ این ورکر پیدا نشد یا حذف شده است.', keyboard: { inline_keyboard: [[{ text: '📋 ورکرها', callback_data: 'l:workers:0' }], [homeButton()]] } }
  }
  const sub = subUrlOf(d)
  const source = sourceName(d.worker_source)

  let text =
    `${statusIcon(d.status)} <b>${d.name}</b>\n` +
    `<i>${d.status === 'deployed' ? 'مستقر' : d.status === 'failed' ? 'ناموفق' : 'در حال استقرار'}</i>\n\n` +
    `🧬 سورس: ${source}\n` +
    `🛠 روش: ${d.method === 'pages' ? 'Cloudflare Pages' : 'Cloudflare Workers'}\n` +
    `📅 ساخته‌شده: ${faDate(d.created_at)}\n`
  // The deployment's own address is always shown, whatever the source or the
  // method: a Pages project and a D1 panel have no CFnew-style sub path, so
  // keying the card off the sub link left those deployments with no link at
  // all — the one thing the user opens the card for.
  const resolvedPanelUrl = d.panel_url || (d.worker_url && d.uuid && d.worker_source !== 'zeus' && d.worker_source !== 'miliconfigzeus' && d.worker_source !== 'github'
    ? `${d.worker_url.replace(/\/+$/, '')}/${(d.custom_path || d.uuid).replace(/^\/+/, '')}`
    : d.worker_url)
  if (d.status === 'deploying' || d.status === 'pending') {
    text += `\n${renderProgressBar(60)}\n⏳ <i>در حال تکمیل مراحل استقرار روی کلودفلر...</i>\n`
  }
  if (d.worker_url) text += `\n🌐 <b>لینک مستقیم ${d.method === 'pages' ? 'Pages' : 'ورکر'}:</b>\n<code>${d.worker_url}</code>\n`
  if (resolvedPanelUrl) text += `\n🔐 <b>آدرس پنل مدیریت:</b>\n<code>${resolvedPanelUrl}</code>\n`
  if (sub) text += `\n📡 <b>لینک اشتراک (Sub):</b>\n<code>${sub}</code>\n`
  if (d.status === 'failed') {
    text += `\n⚠️ <b>خطا:</b> <code>${escapeHtml(d.error_message ?? 'نامشخص')}</code>\n\n🧠 <b>تحلیل هوشمند:</b>\n${diagnoseDeployError(d.error_message)}\n`
  }

  const rows: TgButton[][] = []
  if (d.status === 'deploying' || d.status === 'pending') {
    rows.push([{ text: '🔄 بررسی وضعیت زنده', callback_data: `w:${d.id}`, style: 'primary' }])
  }
  const linkRow: TgButton[] = []
  if (d.worker_url) linkRow.push({ text: '🌐 باز کردن ورکر', url: d.worker_url, style: 'success' })
  if (resolvedPanelUrl) linkRow.push({ text: '🔐 ورود به پنل', url: resolvedPanelUrl, style: 'primary' })
  if (linkRow.length) rows.push(linkRow)
  if (sub) rows.push([{ text: '📡 باز کردن لینک ساب', url: sub, style: 'success' }])

  const copyRow: TgButton[] = []
  if (d.worker_url) copyRow.push({ text: '📋 کپی لینک', callback_data: `cp:${d.id}:worker`, style: 'primary' })
  if (sub) copyRow.push({ text: '📋 کپی ساب', callback_data: `cp:${d.id}:sub`, style: 'primary' })
  if (d.panel_url) copyRow.push({ text: '📋 کپی پنل', callback_data: `cp:${d.id}:panel`, style: 'primary' })
  if (copyRow.length) rows.push(copyRow)

  rows.push([
    { text: '🔄 به‌روزرسانی', callback_data: `upd:${d.id}`, style: 'primary' },
    { text: '♻️ بازیابی', callback_data: `rc:${d.id}`, style: 'primary' },
  ])
  rows.push([{ text: '🔗 کانفیگ‌ها', callback_data: 'l:configs:0', style: 'primary' }])
  // Red is reserved for the only irreversible action in the bot.
  rows.push([{ text: '🗑 حذف ورکر', callback_data: `del:${d.id}`, style: 'danger' }])
  rows.push([
    backButton('l:workers:0', '🔙 ورکرها'),
    { ...homeButton(), style: 'primary' },
  ])

  return { text, keyboard: { inline_keyboard: rows } }
}

// ── ♻️ Recovery ──────────────────────────────────────────────────────────────

/**
 * The recovery screen — workers that may be stuck on `error code: 1101`.
 *
 * A worker whose uploaded script cannot parse answers every request with 1101
 * and can never update itself: the code that would run the updater *is* the code
 * that is broken, so an automatic update is impossible by construction and only
 * a fresh re-deploy can bring it back. That re-deploy is what this screen does:
 *
 *   • the source is downloaded again and matched against the published checksum
 *     of the upstream revision (a half file is never deployed — that is exactly
 *     how a worker ends up stuck in the first place);
 *   • the file is uploaded over the existing script with its bindings, database
 *     and variables untouched;
 *   • the worker is probed until it answers, and if it still does not, the last
 *     revision that was seen running is restored.
 *
 * Workers whose self-check failed are listed first, because they are the ones
 * that need this.
 */
export async function recoverScreen(ctx: ScreenCtx): Promise<Screen> {
  const rows = await ctx.env.DB.prepare(
    `SELECT id, name, status, config, worker_source FROM deployments
      WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 20`,
  ).bind(ctx.userId).all<{
    id: string
    name: string
    status: string
    config: string | null
    worker_source: string | null
  }>()
  const items = (rows.results ?? []).map((row) => {
    const cfg = safeJsonParse<Record<string, unknown>>(row.config ?? '', {})
    // Anything not confirmed to be answering is a recovery candidate: a failed
    // deploy, a worker whose own self-check failed, or one that was deployed
    // before this panel started recording self-checks at all.
    const stuck = row.status !== 'deployed' || cfg.self_check === 'failed'
    return { ...row, stuck, selfCheck: String(cfg.self_check ?? '') }
  }).sort((a, b) => Number(b.stuck) - Number(a.stuck))

  if (!items.length) {
    return {
      text: '♻️ <b>بازیابی</b>\n\nورکر Cloudflare Workersی برای بازیابی ندارید. با «🚀 استقرار جدید» یکی بسازید.',
      keyboard: { inline_keyboard: [[{ text: '🚀 استقرار جدید', callback_data: 'dpl:start' }], [homeButton()]] },
    }
  }

  let text =
    '♻️ <b>بازیابی ورکر</b>\n\n' +
    'اگر ورکر با <code>error code: 1101</code> از کار افتاده باشد، خودش نمی‌تواند آپدیت شود (کد ورکر خراب است). ' +
    'این دکمه سورس را دوباره می‌گیرد، <b>چک‌سام رسمی</b> را بررسی می‌کند، روی همان ورکر مستقر می‌کند و بعد از آپلود یک تست زنده می‌گیرد. ' +
    'دیتابیس، کاربران و رمزها دست‌نخورده می‌مانند.\n\n'
  const keyboard: TgButton[][] = []
  for (const item of items) {
    const state = item.stuck
      ? item.status !== 'deployed'
        ? `ناتمام (${item.status})`
        : 'تست سلامت ناموفق'
      : 'سالم'
    text += `${statusIcon(item.status)} <b>${item.name}</b> — ${state}\n`
    keyboard.push([{ text: `♻️ بازیابی ${item.name}`, callback_data: `rc:${item.id}` }])
  }
  keyboard.push([{ text: '📋 ورکرها', callback_data: 'l:workers:0' }, homeButton()])
  return { text, keyboard: { inline_keyboard: keyboard } }
}

/** Escape the little HTML the bot's messages allow, before showing raw log lines. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Run one recovery and turn the engine's report into a screen. */
async function recoveryScreen(env: Env, userId: string, id: string): Promise<Screen> {
  const out = await runDeploymentUpdate(env, userId, id, { force: true, reason: 'recover' })
  const tail = out.logs.slice(-5).map((line) => escapeHtml(line)).join('\n')
  const header = out.ok
    ? '✅ <b>بازیابی انجام شد</b>'
    : out.rolled_back
      ? '↩️ <b>نسخهٔ جدید بالا نیامد — نسخهٔ سالم قبلی برگشت</b>'
      : '❌ <b>بازیابی ناموفق بود</b>'
  return {
    text: `${header}\n\n${escapeHtml(out.message)}\n\n<pre>${tail}</pre>`,
    keyboard: {
      inline_keyboard: [
        [{ text: '♻️ تلاش دوباره', callback_data: `rc:${id}` }],
        [{ text: '📋 ورکرها', callback_data: 'l:workers:0' }, homeButton()],
      ],
    },
  }
}

/**
 * «به‌روزرسانی» — checks the upstream repository and reports the ONE path that
 * can install a newer version, without ever asking for Cloudflare credentials:
 *
 *   • `auto`   — the worker is linked to a GitHub repo, so a push deploys it;
 *   • `self`   — the deployed panel has its own `CF_API_TOKEN`, so it installs
 *                the new version from its own dashboard (button → panel);
 *   • `api`    — this panel still holds the deploy token, so the update just
 *                ran and the message says so;
 *   • `manual` — fresh file + a ready-to-run `wrangler` recipe the owner can
 *                paste locally, plus how to switch the `self` path on.
 */
export async function updateScreen(env: Env, userId: string, id: string): Promise<Screen> {
  const out = await runDeploymentUpdate(env, userId, id, { reason: 'manual' })
  const tail = out.logs.slice(-3).map((line) => escapeHtml(line)).join('\n')
  const header = !out.ok
    ? '❌ <b>بررسی به‌روزرسانی ناموفق بود</b>'
    : out.updated
      ? '✅ <b>نسخهٔ تازه مستقر شد</b>'
      : out.up_to_date
        ? '✅ <b>همین حالا به‌روز است</b>'
        : out.channel === 'auto'
          ? '🔗 <b>وصل به مخزن گیت‌هاب</b>'
          : out.channel === 'self'
            ? '🔐 <b>به‌روزرسانی از داخل پنل</b>'
            : '⬇️ <b>به‌روزرسانی دستی</b>'

  let text = `${header}\n\n${escapeHtml(out.message)}\n`
  // The manual recipe goes in a <pre> so Telegram copies the whole block,
  // including the wrangler.toml header it writes before deploying.
  if (!out.updated && out.deploy_command) text += `\n<pre>${escapeHtml(out.deploy_command)}</pre>\n`
  if (tail) text += `\n<pre>${tail}</pre>`

  const rows: TgButton[][] = []
  if (out.channel === 'self' && out.panel_url) {
    rows.push([{ text: '🔐 باز کردن پنل برای به‌روزرسانی', url: out.panel_url, style: 'primary' }])
  }
  if (out.download_url) {
    rows.push([{ text: '⬇️ دانلود فایل تازه', url: out.download_url, style: 'primary' }])
  }
  if (out.channel === 'api' && out.changed === false) {
    rows.push([{ text: '♻️ استقرار دوباره', callback_data: `rc:${id}`, style: 'primary' }])
  }
  rows.push([{ text: '📦 این ورکر', callback_data: `w:${id}`, style: 'primary' }, homeButton()])
  return { text, keyboard: { inline_keyboard: rows } }
}

export async function configsScreen(ctx: ScreenCtx, page: number): Promise<Screen> {
  const rows = await ctx.env.DB.prepare(
    "SELECT id, name, worker_url, uuid, custom_path FROM deployments WHERE user_id = ? AND status = 'deployed' ORDER BY created_at DESC LIMIT 100",
  ).bind(ctx.userId).all<{ id: string; name: string; worker_url: string; uuid: string | null; custom_path: string | null }>()
  if (!rows.results.length) {
    return { text: '🔗 هنوز کانفیگی آماده نیست — اول یک ورکر مستقر کنید.', keyboard: { inline_keyboard: [[{ text: '🚀 استقرار جدید', callback_data: 'dpl:start' }], [homeButton()]] } }
  }
  const { slice, pages, page: current } = paginate(rows.results, page)
  let text = '🔗 <b>کانفیگ‌های آماده</b>\n\n'
  const keyboard: TgButton[][] = []
  for (const d of slice) {
    const sub = `${d.worker_url}/${d.custom_path || d.uuid || ''}`
    text += `📦 <b>${d.name}</b>\n<code>${sub}</code>\n\n`
    keyboard.push([{ text: `📋 کپی ساب ${d.name}`, callback_data: `cp:${d.id}:sub` }])
  }
  const pager = pagerRow('configs', current, pages)
  if (pager) keyboard.push(pager)
  keyboard.push([homeButton()])
  return { text, keyboard: { inline_keyboard: keyboard } }
}

export function panelsScreen(page: number): Screen {
  const { slice, pages, page: current } = paginate(PANELS, page)
  let text = '🧩 <b>کاتالوگ پنل‌ها</b>\n<i>همهٔ مخازن قبل از افزودن بررسی شده و فعال بودنشان تأیید شده است.</i>\n\n'
  const keyboard: TgButton[][] = []
  for (const p of slice) {
    text += `${panelOriginLabel(p)} <b>${p.name}</b>\n${p.tagline}\n\n`
    keyboard.push([{ text: `ℹ️ ${p.name}`, callback_data: `p:${p.id}` }])
  }
  const pager = pagerRow('panels', current, pages)
  if (pager) keyboard.push(pager)
  keyboard.push([{ text: '🖥 سرورهای من', callback_data: 'l:servers:0' }, homeButton()])
  return { text, keyboard: { inline_keyboard: keyboard } }
}

export function panelScreen(id: string, origin: string): Screen {
  const panel = PANELS.find((p) => p.id === id)
  if (!panel) {
    return { text: '❌ پنل پیدا نشد.', keyboard: { inline_keyboard: [[{ text: '🧩 کاتالوگ', callback_data: 'l:panels:0' }], [homeButton()]] } }
  }
  const p = resolvePanel(panel.id)
  const targets = p.targets.map((t) => (t === 'railway' ? 'Railway' : t === 'render' ? 'Render' : 'VPS')).join(' · ')
  let text =
    `${panelOriginLabel(p)} <b>${p.name}</b>\n<i>${p.tagline}</i>\n\n` +
    `🐳 اجرا: ${p.runtime === 'docker' ? 'Docker' : 'Python'}\n` +
    `🔢 پورت: <code>${p.port}</code> · مسیر پنل: <code>${p.panelPath}</code>\n` +
    `🎯 هدف‌ها: ${targets}\n` +
    `📦 مخزن: <code>${p.repo}</code>\n`
  if (p.dockerImage) text += `🏷 ایمیج: <code>${p.dockerImage}</code>\n`
  if (p.lastCommit) text += `✅ آخرین کامیت مخزن: <code>${p.lastCommit}</code> · ${panelVerifiedLabel(p)}\n`
  if (p.notes) text += `\n⚠️ ${p.notes}\n`

  return {
    text,
    keyboard: {
      inline_keyboard: [
        [{ text: '↗ صفحهٔ GitHub', url: p.url }],
        [{ text: '🚀 استقرار از پنل وب', url: `${origin}/#/deploy` }],
        [backButton('l:panels:0', '🔙 کاتالوگ'), homeButton()],
      ],
    },
  }
}

interface ServerItem {
  label: string
  panelName: string
  meta: string
  base: string | null
  path: string
  admin: string | null
  /** Callback that opens this deployment's service-settings screen (Railway). */
  settings?: string
}

export async function serversScreen(ctx: ScreenCtx, page: number): Promise<Screen> {
  const [rails, renders] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT id, name, panel, region, domain, admin_username, created_at FROM railway_deploys
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(ctx.userId).all<{ id: string; name: string | null; panel: string | null; region: string; domain: string | null; admin_username: string | null; created_at: string }>(),
    ctx.env.DB.prepare(
      `SELECT id, name, panel, url, admin_username, created_at FROM render_deploys
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(ctx.userId).all<{ id: string; name: string | null; panel: string | null; url: string | null; admin_username: string | null; created_at: string }>(),
  ])

  const items: ServerItem[] = []
  for (const r of rails.results) {
    const panel = resolvePanel(r.panel)
    items.push({
      label: r.name ?? panel.name,
      panelName: panel.name,
      meta: `🏗 Railway · 📍 ${railwayRegionLabel(r.region)} · ${faDate(r.created_at)}`,
      base: r.domain ? `https://${r.domain}` : null,
      path: panel.panelPath,
      admin: r.admin_username,
      settings: `srvset:o:${r.id}`,
    })
  }
  for (const r of renders.results) {
    const panel = resolvePanel(r.panel)
    items.push({
      label: r.name ?? panel.name,
      panelName: panel.name,
      meta: `☁️ Render · 📅 ${faDate(r.created_at)}`,
      base: r.url,
      path: panel.panelPath,
      admin: r.admin_username,
    })
  }

  if (!items.length) {
    return {
      text: '🖥 <b>سرورها</b>\n\nهنوز پنلی روی Railway یا Render مستقر نشده است.\nهمین‌جا با «🚀 استقرار جدید → پنل Railway/Render» مستقر کنید یا از پنل وب استفاده کنید.',
      keyboard: { inline_keyboard: [[{ text: '🚀 استقرار پنل', callback_data: 'dpl:start' }, { text: '🧩 پنل‌های آماده', callback_data: 'l:panels:0' }], [homeButton()]] },
    }
  }

  const { slice, pages, page: current } = paginate(items, page)
  let text = `🖥 <b>سرورهای مستقرشده</b> — ${items.length} مورد\n\n`
  const keyboard: TgButton[][] = []
  for (const s of slice) {
    text += `<b>${s.label}</b> — ${s.panelName}\n${s.meta}\n`
    if (s.admin) text += `👤 ادمین: <code>${s.admin}</code>\n`
    if (s.base) {
      text += `🔐 <code>${s.base}${s.path}</code>\n\n`
      const row: TgButton[] = [{ text: `🔐 پنل ${s.panelName}`, url: `${s.base}${s.path}` }]
      if (s.settings) row.push({ text: '⚙️ تنظیمات', callback_data: s.settings })
      keyboard.push(row)
    } else {
      text += '⏳ دامنهٔ عمومی هنوز فعال نشده\n\n'
      if (s.settings) keyboard.push([{ text: '⚙️ تنظیمات سرویس', callback_data: s.settings }])
    }
  }
  const pager = pagerRow('servers', current, pages)
  if (pager) keyboard.push(pager)
  keyboard.push([homeButton()])
  return { text, keyboard: { inline_keyboard: keyboard } }
}

/**
 * Service settings for one Railway deployment — the same knobs the Railway
 * dashboard exposes (region, Serverless, outbound IPv6, CDN caching).
 *
 * Every button applies its change immediately (see the `srvset` handler) and
 * this screen re-renders from the record the engine just updated, so it can
 * never show a setting the platform refused. `notice` carries the outcome of
 * the change that was just made (including a non-fatal caveat).
 */
async function serverSettingsScreen(env: Env, userId: string, deployId: string, notice?: string): Promise<Screen> {
  const row = await env.DB.prepare(
    'SELECT id, name, panel, region, sleep_application, ipv6_egress, cdn_enabled FROM railway_deploys WHERE id = ? AND user_id = ?',
  )
    .bind(deployId, userId)
    .first<{
      id: string
      name: string | null
      panel: string | null
      region: string | null
      sleep_application: number | null
      ipv6_egress: number | null
      cdn_enabled: number | null
    }>()
  if (!row) {
    return {
      text: '❌ این سرور در فهرست شما نیست.',
      keyboard: { inline_keyboard: [[{ text: '🖥 سرورها', callback_data: 'l:servers:0' }], [homeButton()]] },
    }
  }
  const panel = resolvePanel(row.panel)
  const state = (v: number | null) => (v ? '🟢 روشن' : '⚪️ خاموش')

  const text =
    '⚙️ <b>تنظیمات سرویس</b>\n\n' +
    (notice ? `${notice}\n\n` : '') +
    `🧩 ${panel.name}\n` +
    `📦 <code>${row.name ?? deployId}</code>\n\n` +
    `📍 منطقه: <b>${railwayRegionLabel(row.region)}</b>\n` +
    `💤 Serverless: ${state(row.sleep_application)}\n` +
    `🌐 Outbound IPv6: ${state(row.ipv6_egress)}\n` +
    `⚡️ CDN Caching: ${state(row.cdn_enabled)}\n\n` +
    'برای تغییر، گزینه‌ها را بزنید.\n<i>تغییر منطقه روی پنل‌هایی که Volume دارند کمی طول می‌کشد.</i>'

  // Compare canonically: a record written before Railway renamed its regions
  // still holds the short code and must still show as the selected one.
  const currentRegion = resolveRailwayRegion(row.region) ?? row.region
  // The payload carries the region's short `code`, never its id: Telegram caps
  // `callback_data` at 64 bytes and drops the *whole* keyboard when one button
  // exceeds it, so `srvset:g:<36-char id>:europe-west4-drams3a` (66 bytes) meant
  // this screen never rendered and the Netherlands was unselectable.
  const regionButtons: TgButton[] = RAILWAY_REGIONS.map((r) => ({
    text: `${r.id === currentRegion ? '✅ ' : ''}📍 ${r.label}`,
    callback_data: `srvset:g:${deployId}:${r.code}`,
  }))
  const rows: TgButton[][] = []
  for (let i = 0; i < regionButtons.length; i += 2) rows.push(regionButtons.slice(i, i + 2))
  rows.push([{ text: `💤 Serverless: ${state(row.sleep_application)}`, callback_data: `srvset:t:${deployId}:s` }])
  rows.push([{ text: `🌐 IPv6: ${state(row.ipv6_egress)}`, callback_data: `srvset:t:${deployId}:6` }])
  rows.push([{ text: `⚡️ CDN: ${state(row.cdn_enabled)}`, callback_data: `srvset:t:${deployId}:c` }])
  rows.push([{ text: '🖥 سرورها', callback_data: 'l:servers:0' }, homeButton()])
  return { text, keyboard: { inline_keyboard: rows } }
}

export function helpScreen(): Screen {
  return {
    text:
      '📖 <b>راهنمای ربات استقرار</b>\n\n' +
      'این ربات <b>عمومی و فقط برای استقرار</b> است: ورکر کلودفلر بسازید یا پنل را روی Railway/Render بالا بیاورید. هیچ بخش مدیریت پنل (داشبورد، کاربران، تنظیمات) در آن نیست.\n\n' +
      '<b>دستورات</b>\n' +
      '/start — شروع و منوی اصلی\n' +
      '/deploy — استقرار ورکر یا پنل Railway/Render (ویزارد)\n' +
      '/profile — توکن و لینک اختصاصی شما\n' +
      '/quickstart — چند قدم تا اولین استقرار\n' +
      '/workers — لیست ورکرهای خودتان\n' +
      '/panels — کاتالوگ پنل‌ها\n' +
      '/servers — پنل‌های Railway و Render شما\n' +
      '/tokens — توکن‌ها (افزودن/غیرفعال‌کردن/حذف از همین‌جا)\n' +
      '/config &lt;name&gt; — لینک پنل و ساب یک ورکر\n' +
      '/sub &lt;name&gt; — لینک ساب\n' +
      '/update &lt;name&gt; — بررسی نسخهٔ تازه در گیت‌هاب و مسیر به‌روزرسانی (بدون نیاز به توکن کلودفلر)\n' +
      '/recover — بازیابی ورکری که با خطای ۱۱۰۱ از کار افتاده\n' +
      '/menu — نمایش منو\n' +
      '/help — همین راهنما\n\n' +
      '<b>توکن‌ها و امنیت</b>\n' +
      '• هر کاربر توکن و لینک اختصاصی خودش را دارد؛ توکن‌ها، ورکرها و استقرارهای شما با هیچ کاربر دیگری مشترک نیست.\n' +
      '• توکن‌ها را در «🔑 توکن‌ها» همین‌جا اضافه کنید؛ قبل از ذخیره با خود سرویس بررسی می‌شود و پیام حاوی توکن پاک می‌گردد.\n\n' +
      '<b>نکته‌ها</b>\n' +
      '• همهٔ صفحه‌ها در یک پیام به‌روز می‌شوند تا چت شلوغ نشود.\n' +
      '• دکمهٔ «📋 کپی …» لینک را به‌صورت متن کدشده می‌فرستد؛ با یک لمس کپی می‌شود.',
    keyboard: {
      inline_keyboard: [
        [{ text: '🧩 پنل‌های آماده', callback_data: 'l:panels:0' }, { text: '👤 پروفایل من', callback_data: 'n:profile' }],
        [homeButton()],
      ],
    },
  }
}

// ── Deploy wizard ────────────────────────────────────────────────────────────

/** `Record<string, unknown>` so it can also be persisted as a bot session. */
interface WizardData extends Record<string, unknown> {
  /** Cloudflare branch — worker execution method. */
  method?: 'workers' | 'pages'
  source?: string
  /** Row id + name of whichever token the deploy runs with (CF/Railway/Render). */
  tokenId?: string
  tokenName?: string
  name?: string
  uuid?: string
  /** Railway/Render branch — destination platform + catalog panel id. */
  target?: 'railway' | 'render'
  panel?: string
  /** "Deploy any GitHub repository" — the URL the user pasted. */
  sourceUrl?: string
}

function randomName(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return `mil-${out}`
}

export function deployStartScreen(): Screen {
  return {
    text:
      '🚀 <b>استقرار جدید</b>\n\n' +
      'چه چیزی مستقر کنیم؟\n\n' +
      '⚡ <b>ورکر کلودفلر (Workers)</b> — ورکر روی حساب خودتان، با پنل داخلی، ساب و KV خودکار.\n' +
      '📄 <b>ورکر کلودفلر (Pages)</b> — همان منابع روی پروژهٔ Pages؛ برای دسترسی بدون فیلترشکن دامنهٔ شخصی به آن وصل کنید.\n' +
      '🏗 <b>پنل روی Railway</b> — پنل‌های کاتالوگ با دامنهٔ رایگان <code>*.up.railway.app</code>.\n' +
      '☁️ <b>پنل روی Render</b> — همان پنل‌ها روی Render.com.\n\n' +
      'هر دو محیط Workers و Pages همهٔ منابع فهرست را مستقر می‌کنند — انتخاب با خودتان است.',
    keyboard: {
      inline_keyboard: [
        [{ text: '⚡ ورکر کلودفلر (Workers)', callback_data: 'dpl:m:workers' }],
        [{ text: '📄 ورکر کلودفلر (Pages)', callback_data: 'dpl:m:pages' }],
        [{ text: '🏗 پنل روی Railway', callback_data: 'dpl:T:railway' }, { text: '☁️ Render', callback_data: 'dpl:T:render' }],
        [backButton('n:menu')],
      ],
    },
  }
}

/** Railway/Render branch — pick a panel from the shared catalog. */
export function deployPanelScreen(data: WizardData): Screen {
  const target = data.target === 'render' ? 'render' : 'railway'
  const panels = panelsForTarget(target)
  const keyboard: TgButton[][] = panels.map((p) => [{ text: `🧩 ${p.name}`, callback_data: `dpl:p:${p.id}` }])
  keyboard.push([backButton('dpl:start', '🔙 روش استقرار')])
  return {
    text:
      `<b>استقرار پنل روی ${target === 'render' ? 'Render' : 'Railway'} — انتخاب پنل</b>\n\n` +
      panels
        .map((p) => {
          const verified = panelVerifiedLabel(p)
          return `• <b>${p.name}</b> — <i>${p.tagline}</i>${verified ? `\n  ${verified}` : ''}`
        })
        .join('\n'),
    keyboard: { inline_keyboard: keyboard },
  }
}

export function deploySourceScreen(): Screen {
  // The exact same list the site and the mini app show (one catalog,
  // `shared/worker-sources.ts`) plus the "any GitHub repository" entry — so the
  // bot can never offer a different set of sources than the web wizard.
  const sources = autoWorkerSources()
  // Mili leads the list (the catalog puts it first) and is the only green
  // button here: Telegram's palette has no arbitrary hex, so `success` — the
  // green every client theme ships — plus the 🟢 marker is the neon-green
  // look the owner asked for, and it stays readable in light and dark.
  const keyboard: TgButton[][] = sources.map((s) => [
    s.id === 'milios'
      ? { text: '🟢 Mili', callback_data: `dpl:s:${s.id}`, style: 'success' }
      : { text: `🧬 ${s.name}`, callback_data: `dpl:s:${s.id}` },
  ])
  keyboard.push([{ text: '🐙 از هر مخزن گیت‌هاب — آدرس را می‌دهم', callback_data: 'dpl:s:github' }])
  let text = '<b>مرحلهٔ ۲ از ۴ — منبع ورکر</b>\n\n'
  for (const s of sources) text += `• <b>${s.name}</b>\n  <i>${s.description}</i>\n`
  text += '• <b>از هر مخزن گیت‌هاب</b>\n  <i>آدرس مخزن یا خود فایل ورکر را می‌فرستید — چک‌سام همان ریویژن بررسی می‌شود و فایل ناقص مستقر نمی‌شود.</i>\n'
  keyboard.push([backButton('dpl:start', '🔙 روش اجرا')])
  return { text, keyboard: { inline_keyboard: keyboard } }
}

export async function deployTokenScreen(ctx: ScreenCtx, data: WizardData): Promise<Screen> {
  // Railway/Render branch — the platform token decides where the panel lands.
  if (data.target === 'railway' || data.target === 'render') {
    const table = data.target === 'railway' ? 'railway_tokens' : 'render_tokens'
    const label = data.target === 'railway' ? 'Railway' : 'Render'
    const ts = await ctx.env.DB.prepare(`SELECT id, name FROM ${table} WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 20`)
      .bind(ctx.userId).all<{ id: string; name: string }>()
    if (!ts.results.length) {
      return {
        text: `🔑 <b>توکن ${label} لازم است</b>\n\nروی این حساب هیچ توکن فعال ${label}ی ثبت نشده است. همین‌جا اضافه کنید — توکن روی حساب خودتان ذخیره می‌شود و به هیچ حساب دیگری وصل نیست.`,
        keyboard: {
          inline_keyboard: [
            [{ text: `➕ افزودن توکن ${label}`, callback_data: `tok:add:${data.target}:dpl` }],
            [{ text: '🌐 مدیریت توکن‌ها در پنل وب', url: `${ctx.origin}/#/tokens` }],
            [backButton('dpl:p:', '🔙 انتخاب پنل')],
          ],
        },
      }
    }
    const keyboard: TgButton[][] = ts.results.map((t) => [{ text: `🔑 ${t.name}`, callback_data: `dpl:t:${t.id}` }])
    keyboard.push([{ text: `➕ افزودن توکن ${label}`, callback_data: `tok:add:${data.target}:dpl` }])
    keyboard.push([backButton('dpl:p:', '🔙 انتخاب پنل')])
    return { text: `<b>توکن ${label}</b>\n\nاستقرار پنل با این حساب انجام می‌شود؛ یکی را انتخاب کنید (این توکن‌ها فقط مال حساب خودتان هستند):`, keyboard: { inline_keyboard: keyboard } }
  }

  const ts = await ctx.env.DB.prepare("SELECT id, name FROM cf_tokens WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 20")
    .bind(ctx.userId).all<{ id: string; name: string }>()
  if (!ts.results.length) {
    return {
      text: '🔑 <b>توکن کلودفلر لازم است</b>\n\nروی این حساب هیچ توکن فعال کلودفلری ثبت نشده است. همین‌جا اضافه کنید — توکن روی حساب خودتان ذخیره می‌شود و با توکن هیچ حساب دیگری مشترک نیست.',
      keyboard: {
        inline_keyboard: [
          [{ text: '➕ افزودن توکن کلودفلر', callback_data: 'tok:add:cf:dpl' }],
          [{ text: '🌐 مدیریت توکن‌ها در پنل وب', url: `${ctx.origin}/#/tokens` }],
          [backButton('dpl:start', '🔙 روش اجرا')],
        ],
      },
    }
  }
  const keyboard: TgButton[][] = ts.results.map((t) => [{ text: `🔑 ${t.name}`, callback_data: `dpl:t:${t.id}` }])
  keyboard.push([{ text: '➕ افزودن توکن کلودفلر', callback_data: 'tok:add:cf:dpl' }])
  keyboard.push([backButton('dpl:start', '🔙 روش اجرا')])
  return { text: '<b>مرحلهٔ ۳ از ۴ — انتخاب توکن</b>\n\nتوکنی که استقرار با آن انجام می‌شود را انتخاب کنید (فقط توکن‌های حساب خودتان نمایش داده می‌شود):', keyboard: { inline_keyboard: keyboard } }
}

export function deployConfirmScreen(data: WizardData, uuid: string): Screen {
  // Railway/Render branch — panel + platform + token summary.
  if (data.target === 'railway' || data.target === 'render') {
    const panel = resolvePanel(data.panel)
    const label = data.target === 'railway' ? 'Railway' : 'Render'
    return {
      text:
        `<b>تأیید نهایی — پنل روی ${label}</b>\n\n` +
        `🧩 پنل: <b>${panel.name}</b>\n` +
        `📦 نام پروژه: <code>${data.name ?? ''}</code>\n` +
        `🔑 توکن: <code>${data.tokenName ?? ''}</code>\n\n` +
        'رمز ادمین به‌صورت تصادفی ساخته و به‌عنوان متغیر محیطی سرویس ست می‌شود؛ بعد از آماده‌شدن فقط همین‌جا یک‌بار نمایش داده می‌شود.\n' +
        'با تأیید، استقرار شروع می‌شود و نتیجه همین‌جا اعلام خواهد شد.',
      keyboard: {
        inline_keyboard: [
          [{ text: '✅ شروع استقرار پنل', callback_data: 'dpl:go' }],
          [{ text: '✏️ تغییر نام', callback_data: 'dpl:name' }],
          [backButton('dpl:p:', '❌ لغو / تغییر پنل')],
        ],
      },
    }
  }

  const source =
    data.source === 'github'
      ? `از هر مخزن گیت‌هاب — ${data.sourceUrl ?? ''}`
      : sourceName(data.source)
  return {
    text:
      '<b>مرحلهٔ ۴ از ۴ — تأیید نهایی</b>\n\n' +
      `📦 نام ورکر: <code>${data.name ?? ''}</code>\n` +
      `🆔 UUID: <code>${uuid}</code>\n` +
      `🧬 منبع: ${source}\n` +
      `🛠 روش: ${data.method === 'pages' ? 'Cloudflare Pages' : 'Cloudflare Workers'}\n` +
      `🔑 توکن: <code>${data.tokenName ?? ''}</code>\n\n` +
      'با تأیید، استقرار شروع می‌شود و نتیجه همین‌جا اعلام خواهد شد.',
    keyboard: {
      inline_keyboard: [
        [{ text: '✅ شروع استقرار', callback_data: 'dpl:go' }],
        [{ text: '✏️ تغییر نام', callback_data: 'dpl:name' }, { text: '🎲 UUID جدید', callback_data: 'dpl:uuid' }],
        [backButton('dpl:start', '❌ لغو')],
      ],
    },
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export interface RouterArgs {
  env: Env
  /** Worker execution context — the deploy wizard needs it for waitUntil(). */
  exec: ExecutionContext
  cfg: BotConfigRow
  chatId: number | string
  telegramId: string
  /** The Telegram user's isolated space — the bot's only data scope. */
  userId: string
  tenant?: BotTenant | null
  /** Bot @username, used to build the user's personal deep link. */
  botUsername?: string | null
  origin: string
  session: BotSession | null
  data: string
  /** Message that produced this update — lets the bot delete pasted secrets. */
  messageId?: number | null
}

const screenCtx = (args: RouterArgs): ScreenCtx => ({
  env: args.env,
  cfg: args.cfg,
  chatId: args.chatId,
  telegramId: args.telegramId,
  userId: args.userId,
  tenant: args.tenant,
  botUsername: args.botUsername,
  origin: args.origin,
})

export async function routeCallback(args: RouterArgs): Promise<Screen | null> {
  const { env, cfg } = args
  const ctx = screenCtx(args)
  const [kind, a, b] = args.data.split(':')

  if (args.data === 'noop') return null

  // ── Public screens (available before access is granted) ──
  if (kind === 'n') {
    if (a === 'menu') return menuScreen(ctx)
    if (a === 'help') return helpScreen()
    if (a === 'search') {
      await saveSession(env, args.userId, args.telegramId, { state: 'await_search', data: {} })
      return { text: '🔍 <b>جست‌وجو</b>\n\nنام ورکر یا پنل را در پیام بعدی بفرستید.', keyboard: { inline_keyboard: [[{ text: '❌ لغو', callback_data: 'n:menu' }]] } }
    }
    if (a === 'tokens') return tokensScreen(ctx)
    if (a === 'profile' || a === 'status') return profileScreen(ctx)
    if (a === 'recover') return recoverScreen(ctx)
  }
  if (kind === 'l' && a === 'panels') return panelsScreen(Number(b ?? 0))
  if (kind === 'p') return panelScreen(a ?? '', args.origin)

  // ── Everything below is open to every user: this bot is a public deployer ──

  // ── Token management ──
  // Tokens always belong to the panel user who owns this bot (args.userId);
  // "tok:add:cf", "tok:del:cf:<id>", "tok:rm:cf:<id>", "tok:tgl:cf:<id>" and
  // "tok:add:cf:dpl" (return to the deploy wizard once stored).
  if (kind === 'tok') {
    // `tok:add:<kind>[:dpl]` carries the return hint in the id slot (there is no
    // row id yet); `tok:del|rm|tgl:<kind>:<id>` carries the row id instead.
    const parts = args.data.split(':')
    const action = parts[1] ?? ''
    const rawKind = parts[2] ?? 'cf'
    const id = parts[3]
    const ret = action === 'add' ? id : parts[4]
    const spec = kindSpec(rawKind)
    if (action === 'add') {
      if (!isTokenKind(rawKind)) return tokensScreen(ctx)
      const data: Record<string, unknown> = { kind: spec.id }
      if (ret === 'dpl') {
        // Come back to the deploy wizard once the token is stored.
        data.ret = 'dpl'
        data.wizard = args.session?.data ?? null
      }
      await saveSession(env, args.userId, args.telegramId, { state: 'await_token', data })
      return tokenAddScreen(spec, ret === 'dpl' ? 'dpl' : undefined)
    }
    if (action === 'del') {
      const t = id ? await findToken(env, spec, args.userId, id) : null
      return t ? tokenDeleteScreen(spec, t) : tokensScreen(ctx)
    }
    if (action === 'rm') return id ? deleteTokenRow(ctx, spec, id) : tokensScreen(ctx)
    if (action === 'tgl') return id ? toggleTokenRow(ctx, spec, id) : tokensScreen(ctx)
    return tokensScreen(ctx)
  }

  if (kind === 'l') {
    const page = Number(b ?? 0)
    if (a === 'workers') return workersScreen(ctx, page)
    if (a === 'configs') return configsScreen(ctx, page)
    if (a === 'servers') return serversScreen(ctx, page)
  }
  if (kind === 'w') return workerScreen(ctx, a ?? '')

  // ♻️ Recovery: re-fetch + re-verify + re-deploy a worker that is not
  // answering (see recoverScreen). The payload is the deployment id.
  if (kind === 'rc') return a ? recoveryScreen(env, args.userId, a) : recoverScreen(ctx)
  if (kind === 'upd') return updateScreen(env, args.userId, a ?? '')

  // Live status check for a Railway/Render panel deploy started in the wizard.
  if (kind === 'srv') {
    const platform = a === 'render' ? 'render' : 'railway'
    const id = b ?? ''
    const watched: PanelWatchResult = await watchPanelDeploy(env, args.userId, platform, id)
    if (watched.state === 'live') {
      const kb: TgButton[][] = [[{ text: `🔐 باز کردن پنل ${watched.panelName}`, url: `${watched.url}${watched.panelPath}` }], [{ text: '🖥 سرورها', callback_data: 'l:servers:0' }], [homeButton()]]
      let text =
        `🟢 <b>پنل ${watched.panelName} زنده است</b>\n\n` +
        `🔗 <code>${watched.url}${watched.panelPath}</code>\n`
      if (watched.firstLive && watched.adminUsername) {
        text +=
          `\n👤 ادمین: <code>${watched.adminUsername}</code>\n🔐 رمز: <code>${watched.adminPassword ?? '—'}</code>\n\n` +
          '⚠️ این رمز فقط همین‌جا نمایش داده می‌شود — ذخیره‌اش کنید.'
      } else {
        text += '\n⏳ بوت‌استرپ ادمین قبلاً انجام شده است.'
      }
      // What the app applied on the deployment itself right after it answered
      // (region, panel switches) — reported instead of left implicit.
      if (watched.settingsNote) text += `\n\n⚙️ ${watched.settingsNote}`
      return { text, keyboard: { inline_keyboard: kb } }
    }
    if (watched.state === 'failed') {
      return {
        text: `❌ <b>استقرار ناموفق بود</b>\n\nوضعیت Railway/Render: <code>${watched.status}</code>\nاز داشبورد پلتفرم لاگها را ببینید و دوباره تلاش کنید.`,
        keyboard: { inline_keyboard: [[{ text: '🚀 استقرار جدید', callback_data: 'dpl:start' }], [{ text: '🖥 سرورها', callback_data: 'l:servers:0' }], [homeButton()]] },
      }
    }
    return {
      text: `⏳ <b>هنوز در حال استقرار است…</b>\n\nوضعیت: <code>${watched.status}</code>\n\nچند لحظه دیگر دوباره «بررسی وضعیت» را بزنید.`,
      keyboard: { inline_keyboard: [[{ text: '🔄 بررسی دوباره', callback_data: `srv:${platform}:${id}` }], [{ text: '🖥 سرورها', callback_data: 'l:servers:0' }], [homeButton()]] },
    }
  }

  // ── Service settings for a Railway deployment (region, Serverless, IPv6, CDN) ──
  if (kind === 'srvset') {
    const parts = args.data.split(':')
    const action = parts[1] ?? 'o'
    const deployId = parts[2] ?? ''
    if (!deployId) return serversScreen(ctx, 0)
    // Any non-`o` action first applies the change, then the screen re-renders
    // from the record the engine just updated.
    if (action === 'g' || action === 't') {
      const current = await env.DB.prepare('SELECT sleep_application, ipv6_egress, cdn_enabled FROM railway_deploys WHERE id = ? AND user_id = ?')
        .bind(deployId, args.userId)
        .first<{ sleep_application: number | null; ipv6_egress: number | null; cdn_enabled: number | null }>()
      if (!current) return serversScreen(ctx, 0)
      const patch: PanelSettingsPatch = {}
      // A short region code from the button, or a full region id from a keyboard
      // that was sent before the payload shrank — both resolve to one region.
      if (action === 'g') patch.region = railwayRegionFromCode(parts[3])?.id ?? parts[3] ?? ''
      if (action === 't') {
        const field = parts[3]
        if (field === 's') patch.sleepApplication = !current.sleep_application
        if (field === '6') patch.ipv6Egress = !current.ipv6_egress
        if (field === 'c') patch.cdnEnabled = !current.cdn_enabled
      }
      const applied = await updatePanelSettings(env, args.userId, 'railway', deployId, patch)
      if (!applied.ok) {
        return {
          text: `❌ <b>تغییر تنظیمات ناموفق بود</b>\n\n⚠️ ${applied.error}`,
          keyboard: { inline_keyboard: [[{ text: '🔙 تنظیمات', callback_data: `srvset:o:${deployId}` }], [homeButton()]] },
        }
      }
      // Tell the truth about what Railway confirmed: a region change that was
      // applied also started the deployment that moves the container, and a
      // caveat (applied but not yet in effect) is never hidden.
      if (applied.warning) return serverSettingsScreen(env, args.userId, deployId, `⚠️ ${applied.warning}`)
      if (action === 'g' && applied.region) {
        return serverSettingsScreen(
          env,
          args.userId,
          deployId,
          `✅ منطقه روی <b>${railwayRegionLabel(applied.region)}</b> ثبت شد` +
            (applied.redeployId ? ' و استقرار تازه برای اعمال آن شروع شد.' : '.'),
        )
      }
    }
    return serverSettingsScreen(env, args.userId, deployId)
  }

  if (kind === 'cp') {
    const d = await env.DB.prepare('SELECT id, name, worker_url, panel_url, sub_url, uuid, custom_path, worker_source FROM deployments WHERE id = ? AND user_id = ?')
      .bind(a ?? '', args.userId)
      .first<{ id: string; name: string; worker_url: string | null; panel_url: string | null; sub_url?: string | null; uuid: string | null; custom_path: string | null; worker_source?: string | null }>()
    if (!d) return { text: '❌ مورد پیدا نشد.', keyboard: { inline_keyboard: [[homeButton()]] } }
    const value = b === 'worker' ? d.worker_url : b === 'panel' ? (d.panel_url || d.worker_url) : (subUrlOf(d) || d.panel_url || d.worker_url)
    if (!value) return { text: '⏳ این مورد هنوز آماده نیست.', keyboard: { inline_keyboard: [[{ text: '🔙 ورکر', callback_data: `w:${d.id}` }], [homeButton()]] } }
    await sendMsg(cfg.bot_token, args.chatId, `📋 <b>${d.name}</b>\n\n<code>${value}</code>\n\n<i>برای کپی، روی متن بالا بزنید.</i>`)
    return null
  }

  if (kind === 'del' || kind === 'delok') {
    const d = await env.DB.prepare('SELECT id, name FROM deployments WHERE id = ? AND user_id = ?')
      .bind(a ?? '', args.userId)
      .first<{ id: string; name: string }>()
    if (!d) return { text: '❌ ورکر پیدا نشد.', keyboard: { inline_keyboard: [[{ text: '📋 ورکرها', callback_data: 'l:workers:0' }]] } }
    if (kind === 'del') {
      return {
        text: `🗑 <b>حذف ${d.name}</b>\n\nآیا مطمئن هستید؟ این رکورد از پنل حذف می‌شود (خود ورکر باید از داشبورد کلودفلر حذف شود).`,
        keyboard: { inline_keyboard: [[{ text: '✅ بله، حذف کن', callback_data: `delok:${d.id}` }], [backButton(`w:${d.id}`, '❌ انصراف')]] },
      }
    }
    await env.DB.prepare('DELETE FROM deployments WHERE id = ? AND user_id = ?').bind(d.id, args.userId).run()
    await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(genId(), args.userId, 'deployment_deleted', 'deployment', d.name, nowIso())
      .run()
    return workersScreen(ctx, 0)
  }

  // Personal link/token copy — the user's own unique route into the bot.
  if (kind === 'cpf') {
    await sendMsg(
      cfg.bot_token,
      args.chatId,
      `🔗 <b>لینک اختصاصی شما</b>\n\n<code>https://t.me/${args.botUsername ?? 'bot'}?start=${a ?? ''}</code>\n\n<i>برای کپی روی متن بالا بزنید.</i>`,
    )
    return null
  }

  // ── Deploy wizard ──
  if (kind === 'dpl') return deployWizard(args, a ?? '', b ?? '')
  return null
}

async function deployWizard(args: RouterArgs, a: string, b: string): Promise<Screen | null> {
  const { env, cfg } = args
  const ctx = screenCtx(args)
  const data: WizardData = (args.session?.data as WizardData) ?? {}

  if (a === 'start') {
    await clearSession(env, args.userId, args.telegramId)
    return deployStartScreen()
  }

  // ── Railway/Render panel branch ──
  if (a === 'T') {
    data.target = b === 'render' ? 'render' : 'railway'
    data.panel = undefined
    data.tokenId = undefined
    data.name = undefined
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployPanelScreen(data)
  }
  if (a === 'p' && data.target) {
    const panel = resolvePanel(b)
    if (!panel.targets.includes(data.target)) return deployPanelScreen(data)
    data.panel = panel.id
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployTokenScreen(ctx, data)
  }
  if (a === 't' && data.target && data.panel) {
    const table = data.target === 'railway' ? 'railway_tokens' : 'render_tokens'
    const token = await env.DB.prepare(`SELECT id, name FROM ${table} WHERE id = ? AND user_id = ? AND status = 'active'`)
      .bind(b, args.userId)
      .first<{ id: string; name: string }>()
    if (!token) return deployTokenScreen(ctx, data)
    data.tokenId = token.id
    data.tokenName = token.name
    data.name = data.name ?? randomName()
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployConfirmScreen(data, String(data.uuid ?? ''))
  }

  // ── Shared steps ──
  if (a === 'name') {
    await saveSession(env, args.userId, args.telegramId, { state: 'await_name', data })
    return {
      text: '✏️ <b>نام پروژه/ورکر</b>\n\nنام جدید را بفرستید (حروف کوچک انگلیسی، عدد و خط تیره — مثل <code>mil-ab12cd</code>).',
      keyboard: { inline_keyboard: [[backButton('dpl:confirm', '❌ لغو')]] },
    }
  }
  if (a === 'confirm') return deployConfirmScreen(data, String(data.uuid ?? crypto.randomUUID()))

  // ── Cloudflare branch ──
  if (a === 'm') {
    data.method = b === 'pages' ? 'pages' : 'workers'
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deploySourceScreen()
  }
  if (a === 's') {
    if (!data.method) return deployStartScreen()
    // "Any GitHub repository": the URL is collected in the next message, the
    // same way the site's wizard takes it.
    if (b === 'github') {
      await saveSession(env, args.userId, args.telegramId, { state: 'await_github_url', data })
      return {
        text:
          '🐙 <b>مخزن گیت‌هاب</b>\n\n' +
          'آدرس مخزن یا فایل ورکر را بفرستید؛ برای نمونه:\n' +
          '<code>https://github.com/owner/repo</code>\n' +
          '<code>https://github.com/owner/repo/blob/main/_worker.js</code>\n\n' +
          'فایل باید یک ماژول تک‌فایلی آماده باشد و با چک‌سام رسمی همان ریویژن بررسی می‌شود.',
        keyboard: { inline_keyboard: [[backButton('dpl:start', '❌ لغو')]] },
      }
    }
    data.source = b || 'edgetunnel'
    data.sourceUrl = undefined
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployTokenScreen(ctx, data)
  }
  if (a === 't') {
    if (!data.source) return deployStartScreen()
    const token = await env.DB.prepare("SELECT id, name FROM cf_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
      .bind(b, args.userId)
      .first<{ id: string; name: string }>()
    if (!token) return deployTokenScreen(ctx, data)
    data.tokenId = token.id
    data.tokenName = token.name
    data.name = data.name ?? randomName()
    data.uuid = data.uuid ?? crypto.randomUUID()
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployConfirmScreen(data, data.uuid)
  }
  if (a === 'uuid') {
    data.uuid = crypto.randomUUID()
    await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
    return deployConfirmScreen(data, data.uuid)
  }

  if (a === 'go') {
    // Panel branch: Railway or Render via the shared engine.
    if (data.target && data.panel && data.tokenId && data.name) {
      const started: StartPanelDeployResult = await startPanelDeploy(env, {
        userId: args.userId,
        tokenId: data.tokenId,
        name: data.name,
        panel: resolvePanel(data.panel),
      })
      await clearSession(env, args.userId, args.telegramId)
      if (!started.ok) {
        return {
          text: `❌ <b>استقرار پنل شروع نشد</b>\n\n${started.error}`,
          keyboard: { inline_keyboard: [[{ text: '🔁 تلاش دوباره', callback_data: 'dpl:start' }], [homeButton()]] },
        }
      }
      const label = started.platform === 'render' ? 'Render' : 'Railway'
      return {
        text:
          `🚀 <b>استقرار پنل روی ${label} شروع شد</b>\n\n` +
          `🧩 ${resolvePanel(data.panel).name}\n` +
          `📦 <code>${started.projectName}</code>\n\n` +
          'پروژه ساخته می‌شود، مخزن پنل متصل و متغیرهای محیطی ست می‌شوند. معمولاً ۲ تا ۵ دقیقه طول می‌کشد؛ به محض آماده‌شدن، نتیجه و رمز ادمین همین‌جا اعلام می‌شود.',
        keyboard: {
          inline_keyboard: [
            [{ text: started.platform === 'render' ? '☁️ داشبورد Render' : '🏗 داشبورد Railway', url: started.dashboardUrl }],
            [{ text: '🖥 سرورها', callback_data: 'l:servers:0' }, { text: '👤 فضای من', callback_data: 'n:profile' }],
            [{ text: '🔄 بررسی وضعیت', callback_data: `srv:${started.platform}:${started.id}` }],
            [homeButton()],
          ],
        },
      }
    }

    // Cloudflare worker branch.
    if (!data.method || !data.source || !data.tokenId || !data.name) return deployStartScreen()
    const initialProgressScreen: Screen = {
      text:
        '⏳ <b>در حال استقرار هوشمند ورکر...</b>\n\n' +
        `📦 ورکر: <code>${data.name}</code>\n` +
        `${renderProgressBar(15)}\n\n` +
        '🔹 <b>وضعیت فعلی:</b> آماده‌سازی استقرار و بررسی اولیه توکن...',
      keyboard: {
        inline_keyboard: [
          [{ text: '📋 ورکرهای من', callback_data: 'l:workers:0' }, { text: '👤 فضای من', callback_data: 'n:profile' }],
          [homeButton()],
        ],
      },
    }
    const progressMsgId = await renderScreen(cfg.bot_token, args.chatId, args.messageId ?? null, initialProgressScreen)
    const started = await startDeployment(env, args.exec, {
      userId: args.userId,
      name: data.name,
      uuid: String(data.uuid ?? crypto.randomUUID()),
      cfTokenId: data.tokenId,
      method: data.method,
      workerSource: data.source,
      sourceUrl: data.source === 'github' ? data.sourceUrl : undefined,
      origin: args.origin,
      notifyChat: String(args.chatId),
      notifyBotToken: cfg.bot_token,
      notifyMessageId: progressMsgId ?? args.messageId ?? null,
    })
    await clearSession(env, args.userId, args.telegramId)
    if (!started.ok) {
      const errScreen: Screen = {
        text:
          `❌ <b>استقرار شروع نشد (اخطار خطای هوشمند)</b>\n\n` +
          `⚠️ <code>${started.error}</code>\n\n` +
          `🧠 <b>تحلیل هوشمند:</b>\n${diagnoseDeployError(started.error)}`,
        keyboard: {
          inline_keyboard: [
            [{ text: '🔁 تلاش دوباره', callback_data: 'dpl:start' }, { text: '🔑 توکن‌ها', callback_data: 'n:tokens' }],
            [homeButton()],
          ],
        },
      }
      await renderScreen(cfg.bot_token, args.chatId, progressMsgId ?? args.messageId ?? null, errScreen)
      return null
    }
    return null
  }
  return null
}

// ── Text routing ─────────────────────────────────────────────────────────────

export async function routeText(args: RouterArgs, text: string): Promise<Screen | null> {
  const { env, cfg } = args
  const ctx = screenCtx(args)

  // Conversation states win over everything else.
  if (args.session) {
    if (args.session.state === 'await_token') {
      const res = await handleTokenPaste({
        env,
        cfg,
        chatId: args.chatId,
        telegramId: args.telegramId,
        session: args.session,
        text,
        messageId: args.messageId,
      })
      const wizard = (args.session.data.wizard ?? null) as WizardData | null
      if (res.resumeWizard && wizard) {
        await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data: wizard })
        const step = await deployTokenScreen(ctx, wizard)
        return { ...step, text: `${res.screen.text}\n\n${step.text}` }
      }
      await clearSession(env, args.userId, args.telegramId)
      return res.screen
    }
    if (args.session.state === 'await_name') {
      const name = text.trim().toLowerCase()
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
        return { text: '❌ نام نامعتبر است. فقط حروف کوچک انگلیسی، عدد و خط تیره (۲ تا ۶۳ کاراکتر).', keyboard: { inline_keyboard: [[backButton('dpl:confirm', '❌ لغو')]] } }
      }
      const data = { ...(args.session.data as WizardData), name }
      await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
      return deployConfirmScreen(data, String(data.uuid ?? crypto.randomUUID()))
    }
    if (args.session.state === 'await_github_url') {
      const parsed = parseGithubSourceUrl(text)
      if (!parsed.ok) {
        return {
          text: `❌ ${parsed.error}`,
          keyboard: { inline_keyboard: [[backButton('dpl:start', '❌ لغو')]] },
        }
      }
      // The trimmed text is kept verbatim (branch/path included), exactly like
      // the site's wizard: `buildGithubSourceConfig` re-reads it at deploy and
      // at every update.
      const data = { ...(args.session.data as WizardData), source: 'github', sourceUrl: text.trim() }
      await saveSession(env, args.userId, args.telegramId, { state: 'deploy', data })
      return deployTokenScreen(ctx, data)
    }
    if (args.session.state === 'await_search') {
      await clearSession(env, args.userId, args.telegramId)
      const q = text.trim().toLowerCase()
      const rows = await env.DB.prepare(
        'SELECT id, name, status FROM deployments WHERE user_id = ? AND name LIKE ? ORDER BY created_at DESC LIMIT 10',
      ).bind(args.userId, `%${q}%`).all<{ id: string; name: string; status: string }>()
      const panels = PANELS.filter((p) => p.name.toLowerCase().includes(q) || p.repo.toLowerCase().includes(q) || p.id.includes(q))
      let out = `🔍 <b>نتیجهٔ جست‌وجو</b>\n\n`
      const keyboard: TgButton[][] = []
      if (!rows.results.length && !panels.length) out += 'چیزی پیدا نشد.'
      for (const r of rows.results) {
        out += `📦 ${statusIcon(r.status)} <code>${r.name}</code>\n`
        keyboard.push([{ text: `📦 ${r.name}`, callback_data: `w:${r.id}` }])
      }
      for (const p of panels) {
        out += `🧩 ${panelOriginLabel(p)} <b>${p.name}</b>\n`
        keyboard.push([{ text: `ℹ️ ${p.name}`, callback_data: `p:${p.id}` }])
      }
      keyboard.push([homeButton()])
      return { text: out, keyboard: { inline_keyboard: keyboard } }
    }
  }

  // Reply-keyboard tabs — open to every user, no access levels.
  if (text === MENU.workers) return workersScreen(ctx, 0)
  if (text === MENU.panels) return panelsScreen(0)
  if (text === MENU.servers) return serversScreen(ctx, 0)
  if (text === MENU.tokens) return tokensScreen(ctx)
  if (text === MENU.profile) return profileScreen(ctx)
  if (text === MENU.help) return helpScreen()

  const [cmd, ...rest] = text.split(/\s+/)
  const arg = rest.join(' ')

  if (cmd === '/start') {
    // `/start <token>`: the payload is the user's own unique route token. A
    // token belonging to another Telegram account is refused — spaces never
    // cross over, so nobody can step into someone else's deploys or tokens.
    const payload = (rest[0] ?? '').trim()
    const owner = payload ? await tenantByToken(env, payload) : null
    if (owner && owner.telegram_id !== args.telegramId) {
      return {
        text:
          '🔐 <b>این توکن/لینک به حساب دیگری تعلق دارد.</b>\n\n' +
          'هر کاربر توکن و فضای اختصاصی خودش را دارد. اگر می‌خواهید خودتان استقرار انجام دهید، همین /start را بزنید تا فضای شما ساخته شود.',
        keyboard: { inline_keyboard: [[{ text: '👤 فضای من', callback_data: 'n:profile' }, { text: '📖 راهنما', callback_data: 'n:help' }]] },
      }
    }
    return menuScreen(ctx)
  }
  if (cmd === '/menu') return menuScreen(ctx)
  if (cmd === '/help') return helpScreen()
  if (cmd === '/panels') return panelsScreen(0)
  if (cmd === '/quickstart') {
    return {
      text:
        '⚡ <b>شروع سریع</b>\n\n' +
        '۱) توکن Cloudflare خودتان را در «🔑 توکن‌ها» همین‌جا اضافه کنید.\n' +
        '۲) در همین ربات /deploy را بزنید.\n' +
        '۳) روش را انتخاب کنید: ورکر کلودفلر، یا پنل روی Railway/Render.\n' +
        '۴) منبع/پنل، توکن و نام را انتخاب و تأیید کنید.\n' +
        '۵) نتیجهٔ استقرار خودکار همین‌جا اعلام می‌شود.\n\n' +
        'استقرار پنل VPS از پنل وب است؛ کاتالوگ کامل در «🧩 پنل‌ها».',
      keyboard: { inline_keyboard: [[{ text: '🚀 استقرار جدید', callback_data: 'dpl:start' }], [homeButton()]] },
    }
  }

  if (cmd === '/profile' || cmd === '/me') return profileScreen(ctx)
  if (cmd === '/workers') return workersScreen(ctx, 0)
  if (cmd === '/configs') return configsScreen(ctx, 0)
  if (cmd === '/servers') return serversScreen(ctx, 0)
  if (cmd === '/tokens') return tokensScreen(ctx)
  if (cmd === '/id') return { text: `🆔 شناسهٔ شما: <code>${args.telegramId}</code>`, keyboard: { inline_keyboard: [[{ text: '👤 فضای من', callback_data: 'n:profile' }]] } }
  if (cmd === '/deploy') return deployStartScreen()

  if (cmd === '/config' || cmd === '/sub' || cmd === '/panel') {
    if (!arg) return workersScreen(ctx, 0)
    const wn = arg.toLowerCase().replace(/[^a-z0-9-]/g, '')
    const d = await env.DB.prepare('SELECT id, name, status FROM deployments WHERE user_id = ? AND name = ?')
      .bind(args.userId, wn)
      .first<{ id: string; name: string; status: string }>()
    if (!d) return { text: `❌ ورکری با نام <code>${wn}</code> پیدا نشد.`, keyboard: { inline_keyboard: [[{ text: '📋 ورکرها', callback_data: 'l:workers:0' }], [homeButton()]] } }
    return workerScreen(ctx, d.id)
  }

  // ♻️ Recovery: `/recover` lists them, `/recover <name>` repairs one worker
  // directly (the same path the inline button uses).
  if (cmd === '/recover') {
    if (!arg) return recoverScreen(ctx)
    const target = arg.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    const d = await env.DB.prepare('SELECT id, name FROM deployments WHERE user_id = ? AND name = ?')
      .bind(args.userId, target)
      .first<{ id: string; name: string }>()
    if (!d) {
      return {
        text: `❌ ورکری با نام <code>${target}</code> پیدا نشد.`,
        keyboard: { inline_keyboard: [[{ text: '♻️ فهرست بازیابی', callback_data: 'n:recover' }], [homeButton()]] },
      }
    }
    return recoveryScreen(env, args.userId, d.id)
  }

  // 🔄 Update: `/update <name>` checks GitHub for a newer version and reports
  // the path that installs it (auto / in-panel / fresh file + command). No
  // Cloudflare credential is ever requested here.
  if (cmd === '/update') {
    const target = arg.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (!target) {
      const rows = await env.DB.prepare(
        'SELECT id, name, status FROM deployments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      ).bind(args.userId).all<{ id: string; name: string; status: string }>()
      const keyboard: TgButton[][] = (rows.results ?? []).map((d) => [{ text: `🔄 ${d.name}`, callback_data: `upd:${d.id}` }])
      keyboard.push([{ text: '📋 ورکرها', callback_data: 'l:workers:0' }, homeButton()])
      return {
        text: '🔄 <b>به‌روزرسانی</b>\n\nکدام ورکر را بررسی کنم؟ (یا <code>/update نام-ورکر</code>)',
        keyboard: { inline_keyboard: keyboard },
      }
    }
    const d = await env.DB.prepare('SELECT id FROM deployments WHERE user_id = ? AND name = ?')
      .bind(args.userId, target)
      .first<{ id: string }>()
    if (!d) return { text: `❌ ورکری با نام <code>${target}</code> پیدا نشد.`, keyboard: { inline_keyboard: [[{ text: '📋 ورکرها', callback_data: 'l:workers:0' }], [homeButton()]] } }
    return updateScreen(env, args.userId, d.id)
  }

  if (cmd === '/set') {
    const parts = arg.split(/\s+/)
    if (parts.length < 3) {
      return { text: '⚙️ استفاده: <code>/set worker key value</code>\nکلیدهای مجاز: path, proxyip, region, homepage', keyboard: { inline_keyboard: [[homeButton()]] } }
    }
    const [wn, key, ...valueParts] = parts
    const value = valueParts.join(' ')
    if (!['path', 'proxyip', 'region', 'homepage'].includes(key.toLowerCase())) {
      return { text: '❌ کلید نامعتبر. کلیدهای مجاز: path, proxyip, region, homepage', keyboard: { inline_keyboard: [[homeButton()]] } }
    }
    const target = wn.toLowerCase().replace(/[^a-z0-9-]/g, '')
    const d = await env.DB.prepare('SELECT id, name, config FROM deployments WHERE user_id = ? AND name = ?')
      .bind(args.userId, target)
      .first<{ id: string; name: string; config: string | null }>()
    if (!d) return { text: `❌ ورکر <code>${wn}</code> پیدا نشد.`, keyboard: { inline_keyboard: [[homeButton()]] } }
    const stored = safeJsonParse<Record<string, unknown>>(d.config ?? '{}', {})
    stored[key.toLowerCase()] = value
    await env.DB.prepare('UPDATE deployments SET config = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(stored), nowIso(), d.id).run()
    return { text: `✅ <code>${d.name}</code> به‌روز شد.\n${key.toLowerCase()}: <code>${value}</code>`, keyboard: { inline_keyboard: [[{ text: '📦 ورکر', callback_data: `w:${d.id}` }], [homeButton()]] } }
  }

  if (cmd === '/id') return { text: `🆔 شناسهٔ شما: <code>${args.telegramId}</code>`, keyboard: { inline_keyboard: [[homeButton()]] } }

  return {
    text: 'متوجه نشدم 🤔\nاز منوی پایین استفاده کنید یا /help را بزنید.',
    keyboard: { inline_keyboard: [[{ text: '📖 راهنما', callback_data: 'n:help' }], [homeButton()]] },
  }
}
