import type { Env } from './env'
import {
  obfuscateWorkerWithEdgetunnelMethod,
  generateUniqueDeploymentSeed,
  encodeEdgetunnelPolymorphic,
  decodeEdgetunnelPolymorphic,
} from './obfuscate'
export {
  obfuscateWorkerWithEdgetunnelMethod,
  generateUniqueDeploymentSeed,
  encodeEdgetunnelPolymorphic,
  decodeEdgetunnelPolymorphic,
}
import { nowIso, genId, edgetunnelSubToken, safeJsonParse } from './util'
import { notifyDeployment } from './telegram'
import { notifyDeploymentProgress } from './telegram-core'
import {
  commitPinnedRawUrl,
  fetchGithubHeadCommit,
  parseRawGithubUrl,
  verifyWorkerSource,
  type RawGithubRef,
} from './source-verify'
import { WORKER_SOURCE_KIND, type WorkerSourceKind } from '../shared/worker-links'
import {
  GITHUB_ENTRY_CANDIDATES,
  WRANGLER_CONFIG_FILES,
  githubRepoLabel,
  isWorkerEntryPath,
  parseGithubSourceUrl,
  rawGithubFileUrl,
} from '../shared/github-source'

// ── Ported 1:1 from the original cf-deploy function (Supabase → D1) ────────
// The deploy steps, source URLs, bindings and fallbacks are identical to the
// version the project originally shipped with.

const API_BASE = 'https://api.cloudflare.com/client/v4'

/**
 * Update a worker script's settings.
 *
 * The settings endpoint only accepts `multipart/form-data` now: a JSON body is
 * rejected with `10001 Content-Type must be one of: multipart/form-data`. The
 * old JSON call failed silently, which is why Smart Placement used to be logged
 * as ON while the script was still running at the edge.
 */
async function patchScriptSettings(
  accountId: string,
  authHeader: string,
  scriptName: string,
  settings: Record<string, unknown>,
): Promise<boolean> {
  const form = new FormData()
  form.append('settings', new Blob([JSON.stringify(settings)], { type: 'application/json' }))
  const resp = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/settings`, {
    method: 'PATCH',
    headers: { Authorization: authHeader },
    body: form,
  }).catch(() => null)
  if (!resp?.ok) return false
  const data = (await resp.json().catch(() => null)) as { success?: boolean } | null
  return !!data?.success
}

export interface WorkerSourceConfig {
  url: string
  label: string
  compat: string
  kvBinding: string
  configKey: string
  configFormat: 'edgetunnel' | 'custom'
  uuidEnvName: string
  fallbackUrls?: string[]
  /** Optional per-source compatibility flags override (defaults to the panel's). */
  compatFlags?: string[]
  /**
   * Identity marker: a short string this project's own upstream always
   * contains. The downloaded file has to contain it before it is uploaded, so
   * a source can never deploy *another* project's worker under its name (see
   * `expectMarker` in worker/source-verify.ts). Empty = no check (only for
   * arbitrary GitHub repos, whose content we cannot know in advance).
   */
  expectMarker?: string
  /**
   * Provision a D1 database for this source and bind it as `DB`.
   *
   * Zeus-style panels ask for it through their `kind`; a panel of another
   * lineage has to say so explicitly, because its routing model may be the
   * plain `custom` one. Defaults to off, so an entry that omits it behaves
   * exactly as before.
   */
  provisionD1?: boolean
  /**
   * Bind the deploy token itself to the worker as `CF_API_TOKEN` (+ account id
   * and worker name), so the *deployed* panel can install a new version from
   * GitHub on its own — the "update from inside the panel" path.
   *
   * This is a deliberate, per-source decision: it means a third-party panel
   * receives the token the deployment was made with. Sources that do not ask
   * for it (edgetunnel, CFnew, NEXUS, miliconfigOS v4) never see it, and the
   * panel's own update screen states plainly that in-panel auto-install is only
   * available when that variable exists in the worker's settings.
   */
  selfUpdate?: boolean
  /**
   * Which routing model the worker implements — this is what decides the
   * panel path and the subscription link, so the two can never be guessed
   * wrong again:
   *
   *  - `edgetunnel` (cmliu): the dashboard lives at a FIXED `/admin` (or
   *    `/login`), and the subscription is `/sub?token=<md5(host+uuid)>`.
   *  - `custom` / `nexus` (CFnew): the dashboard and the subscription are both
   *    served under the UUID path — `/<uuid>` is the panel, `/<uuid>/sub` the
   *    raw sub link. There is no `/sub` at the worker root.
   *  - `zeus`: the whole worker is a D1-backed panel; a user's subscription is
   *    `/sub/<username>`, which only exists after an account is created in the
   *    panel — there is no deploy-time sub link at all.
   */
  kind: WorkerSourceKind
}

const WORKER_SOURCES: Record<string, WorkerSourceConfig> = {
  edgetunnel: {
    url: 'https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
    label: 'cmliu/edgetunnel',
    compat: '2025-11-04',
    kvBinding: 'KV',
    configKey: 'config.json',
    configFormat: 'edgetunnel',
    uuidEnvName: 'UUID',
    kind: WORKER_SOURCE_KIND.edgetunnel,
    compatFlags: [],
    // Present 214× in cmliu's file (its KV config object). A file without it is
    // not edgetunnel — the check exists so a wrong URL can never masquerade as
    // this source and overwrite a live worker.
    expectMarker: 'config_JSON',
  },
  edgetunnel_kv: {
    url: 'https://raw.githubusercontent.com/cmliu/edgetunnel/main/_worker.js',
    label: 'cmliu/edgetunnel (KV mode)',
    compat: '2025-11-04',
    kvBinding: 'KV',
    configKey: 'config.json',
    configFormat: 'edgetunnel',
    uuidEnvName: 'UUID',
    kind: WORKER_SOURCE_KIND.edgetunnel_kv,
    compatFlags: [],
    expectMarker: 'config_JSON',
  },
  custom: {
    url: 'https://raw.githubusercontent.com/Alibakhshi-qr/miliconfig-pro/main/public/repo/worker-source.js',
    label: 'Custom worker (CFnew v2.9.8c)',
    compat: '2025-01-01',
    kvBinding: 'C',
    configKey: 'c',
    configFormat: 'custom',
    uuidEnvName: 'u',
    // The public mirrors of this (private-repo) source 404, so the copy
    // bundled with the panel is always tried as the fallback.
    fallbackUrls: [
      'https://raw.githubusercontent.com/miladjahani/miliconfigpro-v1/main/public/repo/worker-source.js',
      '/repo/worker-source.js',
    ],
    kind: WORKER_SOURCE_KIND.custom,
    compatFlags: [],
    // CFnew's own header — every copy of this worker (mirror and bundled) has it.
    expectMarker: 'CFnew',
  },
  nexus: {
    url: 'https://raw.githubusercontent.com/miladjahani/miliconfigpro-v1/main/public/repo/nexus.js',
    label: 'NEXUS — نسل جدید (پنل داخلی + نقشه زنده + ساب‌نویس خودکار)',
    compat: '2025-01-01',
    kvBinding: 'C',
    configKey: 'c',
    configFormat: 'custom',
    uuidEnvName: 'u',
    // The repo is private, so every raw mirror 404s. Without the bundled copy
    // as a fallback the deploy dies with "failed to fetch worker source".
    fallbackUrls: [
      'https://raw.githubusercontent.com/Alibakhshi-qr/miliconfig-pro/main/public/repo/nexus.js',
      '/repo/nexus.js',
    ],
    kind: WORKER_SOURCE_KIND.nexus,
    compatFlags: [],
    expectMarker: 'NEXUS',
  },
  zeus: {
    // ZEUS PANEL (panel-zeus/Z-E-U-S) — full D1 panel, anti-censorship core:
    // TLS fragmentation, ClientHello fingerprint spoofing, D1-backed users.
    url: 'https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/main/Source.js',
    label: 'ZEUS PANEL (panel-zeus/Z-E-U-S)',
    // Read from the panel's own source (compatibility_date: "2026-07-10").
    compat: '2026-07-10',
    kvBinding: '',
    configKey: '',
    configFormat: 'custom',
    uuidEnvName: '',
    kind: WORKER_SOURCE_KIND.zeus,
    compatFlags: [],
    expectMarker: 'GLOBAL_TRAFFIC_CACHE',
    // Its bindings already carry CF_API_TOKEN (zeus branch below); the flag is
    // what lets the update screen say so instead of guessing.
    selfUpdate: true,
  },
  miliconfigzeus: {
    url: 'https://raw.githubusercontent.com/miladjahani/miliconfigzeus/main/Source-2.js',
    label: 'miliconfig zeus (full D1 panel)',
    compat: '2025-01-01',
    kvBinding: '',
    configKey: '',
    configFormat: 'custom',
    uuidEnvName: '',
    kind: WORKER_SOURCE_KIND.miliconfigzeus,
    compatFlags: [],
    expectMarker: 'GLOBAL_TRAFFIC_CACHE',
    selfUpdate: true,
  },
  nova: {
    url: 'https://raw.githubusercontent.com/IRNova/Nova-Proxy/main/worker.js',
    label: 'Nova Proxy (full D1+KV panel)',
    compat: '2026-07-30',
    kvBinding: 'KV',
    configKey: '',
    configFormat: 'custom',
    uuidEnvName: '',
    // Routing like zeus: the whole worker is a self-contained admin panel.
    // The dashboard lives at a fixed /admin (setup wizard on first visit),
    // login at /login, and a user subscription is /sub?token=… issued by
    // the panel per user — there is no deploy-time sub link.
    kind: WORKER_SOURCE_KIND.nova,
    selfUpdate: true,
    // Nova's own wrangler.jsonc: nodejs_compat only — with nova's own
    // compat date given above. global_fetch_strictly_public is NOT set so
    // nova keeps its own fetch behaviour.
    compatFlags: ['nodejs_compat'],
    // Nova's protected release banner (`/*! Nova 4.9.4 protected release …`).
    // This is the check that makes "the deployment said Nova but shipped
    // edgetunnel" impossible: cmliu's file does not contain it, so a wrong
    // URL/mapping now stops the deployment instead of overwriting the worker.
    expectMarker: 'Nova',
  },
  milios: {
    // miladjahani/Milios3.10.2 — the "Mili" panel (miliconfigOS 3.10.2). The
    // repo publishes its finished worker as one ES module at the root
    // (`_worker.js`, byte-identical to `dist/_worker.js`); its `src/` is
    // modular and would need a build, so the published file is the only
    // deployable entry.
    // `dist/_worker.js` is the repo's published build output (`howinstall.md`
    // explains it is regenerated by `node scripts/build.js` together with the
    // root copy — the two files are byte-identical, same blob SHA). We pull the
    // dist copy because that is the artifact the repo itself deploys, and keep
    // the root file as a fallback for the case where only one of them survives
    // a future commit.
    url: 'https://raw.githubusercontent.com/miladjahani/Milios3.10.2/main/dist/_worker.js',
    label: 'Mili (miladjahani/Milios3.10.2)',
    fallbackUrls: ['https://raw.githubusercontent.com/miladjahani/Milios3.10.2/main/_worker.js', '/repo/milios.js'],
    // `compatibility_date` from the repo's own wrangler.toml / wrangler.worker.toml;
    // it declares no compatibility flags, so none are added here either.
    compat: '2024-11-06',
    // Everything lives in D1 (the schema migrates itself on the first request);
    // KV is optional upstream and therefore not bound.
    kvBinding: '',
    configKey: '',
    configFormat: 'custom',
    // `env.u` is the admin path (the worker reads u/U/UUID/uuid and only then a
    // stored admin_path), so the deployment's UUID becomes the panel address.
    uuidEnvName: 'u',
    kind: WORKER_SOURCE_KIND.milios,
    // The panel's brand constant. It is present in every miliconfig build — so
    // an update and a rollback to an older commit of this source both pass —
    // and in none of the other sources here (edgetunnel, zeus, nova, NEXUS),
    // so a foreign file can never be deployed or updated into this worker.
    expectMarker: 'MILICONFIG',
    // Without a database the panel degrades to memory and loses every user on
    // a restart, so a deployment always gets its own D1 database.
    provisionD1: true,
    // The panel reads CF_API_TOKEN to pull and install a newer version from
    // GitHub by itself; with the variable bound, the in-panel updater works.
    selfUpdate: true,
    compatFlags: [],
  },
  miliconfigosv3: {
    // LEGACY — no longer offered in the wizard/bot pickers (it was replaced by
    // "Mili" above). The entry stays so the deployments already running this
    // source can still be verified, updated and rolled back: dropping it would
    // strand them and every update would be refused as an unknown id.
    //
    // miladjahani/Miliconfigpro (miliconfig v3.1) — publishes its finished
    // worker as one ES module at the repo root (`_worker.js`). Its `src/` is
    // modular and would need a build, so the published file is the only
    // deployable entry.
    url: 'https://raw.githubusercontent.com/miladjahani/Miliconfigpro/main/_worker.js',
    label: 'miliconfigOS v3 (miladjahani/Miliconfigpro)',
    // `compatibility_date` from the repo's own wrangler.worker.toml (and
    // wrangler.toml); it declares no compatibility flags, so none are added.
    compat: '2024-09-23',
    // Everything lives in D1 (the schema migrates itself on the first
    // request); KV is only an optional upstream fallback and is not bound.
    kvBinding: '',
    configKey: '',
    configFormat: 'custom',
    // `env.u` is the admin path (getOrCreateAdminPath), so the deployment's
    // UUID becomes the panel address.
    uuidEnvName: 'u',
    kind: WORKER_SOURCE_KIND.miliconfigosv3,
    // The panel's own brand constant — a file without it is not this project,
    // so it can never overwrite a worker deployed here. (It used to be the
    // `miliconfig v3.1` version banner, which the repo dropped when it moved on
    // to a newer build; that left every deployment of this source unable to
    // update, so the marker is the brand string now.)
    expectMarker: 'MILICONFIG',
    // Without a database the panel falls back to memory and loses every user on
    // a restart, so a deployment always gets its own D1 database.
    provisionD1: true,
    // `CF_API_TOKEN` is what lets this panel pull and install a newer version
    // from GitHub without the owner entering anything: with the variable in its
    // settings the in-panel updater runs, without it the panel can only hand
    // out the fresh file. That is why it is bound here (and only here, plus the
    // zeus-family panels below).
    selfUpdate: true,
    compatFlags: [],
  },
}

/**
 * Exact lookup: `null` when this build does not know the id.
 *
 * Deliberately NOT a fallback. `WORKER_SOURCES[id] ?? WORKER_SOURCES.edgetunnel`
 * (the old behaviour of both the deploy and the update path) turned any unknown
 * id — an older panel's source, a typo, a source removed in a later version —
 * into a silent edgetunnel deployment: the row said "Nova", the code on
 * Cloudflare was cmliu's worker, and the panel could not update itself out of
 * that state. An empty id still means "nothing chosen" and gets the default.
 */
export function lookupWorkerSource(workerSource: string | null | undefined): WorkerSourceConfig | null {
  if (!workerSource) return WORKER_SOURCES.edgetunnel
  return WORKER_SOURCES[workerSource] ?? null
}

/**
 * Source config for display/legacy callers. Only valid for ids that exist —
 * the deploy and update engines use {@link lookupWorkerSource} and refuse an
 * unknown one.
 */
export function workerSourceConfig(workerSource: string | null | undefined): WorkerSourceConfig {
  return lookupWorkerSource(workerSource) ?? WORKER_SOURCES.edgetunnel
}

export interface FetchedSource {
  code: string
  url: string
  /** raw.githubusercontent ETag = sha256 of the file — a perfect "did upstream
   *  change?" fingerprint, so a re-deploy never pushes an identical script. */
  etag: string
  usedFallback: boolean
  /** SHA-256 of the verified bytes. */
  sha256: string
  /** Upstream revision the bytes were proven against (null when unverified). */
  commitSha: string | null
  /** Published blob checksum that matched these bytes (null when unverified). */
  blobSha: string | null
  /** True only when GitHub's published checksum confirmed these exact bytes. */
  checksumVerified: boolean
  /** Non-fatal remark (checksum unavailable, local checks only). */
  note?: string
}

export interface FetchWorkerSourceResult {
  /** The first candidate that downloaded *and* passed integrity verification. */
  source: FetchedSource | null
  /** One line per rejected candidate, for the deployment log. */
  errors: string[]
}

/**
 * Download a worker source from its upstream repository, trying the primary
 * URL first and then any fallback (mirrors / the copy bundled with this panel)
 * so a moved or renamed repo can never 404 a deployment.
 *
 * Every candidate is verified before it is accepted (see worker/source-verify.ts):
 * a download that stopped halfway is exactly what turns a healthy worker into a
 * permanent `error code: 1101`, so a file that fails the size, marker or
 * checksum screen is dropped and the next candidate is tried — never uploaded.
 */
/**
 * Read a downloaded source as text **byte-exactly**.
 *
 * `resp.text()` follows the WHATWG encoding rules and strips a leading UTF-8
 * BOM, so every check in `source-verify.ts` then ran over 3 bytes fewer than
 * the file actually has — while GitHub's published `size` and git-blob SHA do
 * include the BOM. A *complete* download of any BOM-prefixed source was
 * therefore rejected as incomplete: cmliu/edgetunnel's `_worker.js` starts with
 * `EF BB BF`, so every edgetunnel deployment died with
 * “چک‌سام فایل دانلودشده با نسخهٔ منتشرشده مطابقت ندارد (5142232/5142235 بایت)”
 * and could never be deployed. `ignoreBOM: true` keeps those bytes, so the size,
 * the blob SHA and the recorded fingerprint describe the file exactly as it is
 * upstream.
 */
async function readSourceText(resp: Response): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await resp.arrayBuffer())
}

/**
 * Read one of the panel's own bundled files (`/repo/nexus.js`) straight out of
 * this deployment's asset bundle.
 *
 * The copy shipped in `public/repo/` is the only one that exists: both upstream
 * repositories are private, so every `raw.githubusercontent.com` mirror 404s.
 * The bundled copy used to be reached by fetching `${origin}/repo/…` — i.e. by
 * asking this very host to serve its own asset over HTTP again. That tied the
 * deploy engine to the public host serving `/repo/*`: when the file was missing
 * from the build (or the panel is served from a host that does not expose it),
 * the only working copy of the source answered 404 and every CFnew / NEXUS
 * deployment died with “failed to fetch worker source”. Reading it through the
 * `ASSETS` binding is the same bytes with no network, no self-fetch and no
 * dependency on the panel's public URL.
 */
export async function readBundledAsset(env: Env, path: string): Promise<string | null> {
  const assetPath = path.startsWith('/') ? path : `/${path}`
  try {
    const resp = await env.ASSETS.fetch(new Request(`https://panel.internal${assetPath}`))
    if (!resp.ok) return null
    const text = await readSourceText(resp)
    return text.trim() ? text : null
  } catch {
    return null
  }
}

export async function fetchWorkerSource(
  sourceConfig: WorkerSourceConfig,
  fallbackUrls: string[],
  /**
   * Reads a panel-relative candidate (`/repo/worker-source.js`) from this
   * build's own assets. Without it a relative candidate is reported as
   * unavailable instead of being fetched as a broken URL.
   */
  readLocal?: (path: string) => Promise<string | null>,
): Promise<FetchWorkerSourceResult> {
  const errors: string[] = []
  const candidates = [sourceConfig.url, ...fallbackUrls]
  // ── Candidates bundled with the panel come FIRST ─────────────────────
  // The upstream repositories of the CFnew / NEXUS sources are private, so
  // every `raw.githubusercontent.com` URL for them answers 404 to an
  // unauthenticated fetch — always, not occasionally. Trying those first spent
  // a round trip per candidate and, when the host serving the panel did not
  // expose `/repo/*`, produced the misleading
  // “failed to fetch worker source: … (HTTP 404)” for a source that was sitting
  // in the deployment the whole time. The bundled copy is the same bytes with
  // no network at all, so it is tried before any remote mirror; the remote
  // candidates stay as the fallback for hosts that ship without the asset.
  const ordered = [
    ...candidates.filter((u) => !/^https?:\/\//i.test(u)),
    ...candidates.filter((u) => /^https?:\/\//i.test(u)),
  ]
  for (const url of ordered) {
    const isBundled = !/^https?:\/\//i.test(url)
    const label = `${sourceConfig.label}${isBundled ? ' (نسخهٔ باندل‌شده)' : url === sourceConfig.url ? '' : ' (fallback)'}`
    try {
      let text: string
      let etag = ''
      if (/^https?:\/\//i.test(url)) {
        const resp = await fetch(url)
        if (!resp.ok || Number(resp.headers.get('content-length') ?? '1') === 0) {
          errors.push(`${label}: دریافت نشد (HTTP ${resp.status})`)
          continue
        }
        text = await readSourceText(resp)
        etag = (resp.headers.get('etag') ?? '').trim()
      } else {
        const local = readLocal ? await readLocal(url) : null
        if (local === null) {
          errors.push(`${label}: نسخهٔ باندل‌شده در این استقرار پیدا نشد (${url})`)
          continue
        }
        text = local
      }
      if (!text.trim().length) {
        errors.push(`${label}: پاسخ خالی بود`)
        continue
      }
      const ref: RawGithubRef | null = parseRawGithubUrl(url)
      // Pin the check to an exact revision: the branch's current commit. The
      // checksum and the rollback target then refer to the same commit instead
      // of a branch name that moves under us. When the commit lookup fails
      // (rate limit), the checksum is still verified — against the branch head
      // as it is right now — and the branch is what gets recorded.
      const revision = ref ? (await fetchGithubHeadCommit(ref)) ?? undefined : undefined
      const verified = await verifyWorkerSource(text, { ref, revision, expectMarker: sourceConfig.expectMarker })
      if (!verified.ok) {
        errors.push(`${label}: ${verified.reason ?? 'بررسی صحت فایل ناموفق بود'}`)
        continue
      }
      return {
        source: {
          code: text,
          url,
          etag,
          usedFallback: url !== sourceConfig.url,
          sha256: verified.sha256,
          commitSha: verified.commitSha,
          blobSha: verified.blobSha,
          checksumVerified: verified.checksumVerified,
          note: verified.note,
        },
        errors,
      }
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : 'خطای شبکه'}`)
      // try next candidate
    }
  }
  return { source: null, errors }
}

/**
 * The exact same file at a pinned revision — the rollback path of the updater.
 *
 * The checksum of that revision is re-verified before the bytes are returned,
 * so a rolled-back deployment is as verified as a fresh one.
 */
export async function fetchPinnedWorkerSource(
  sourceUrl: string,
  commit: string,
  /** Identity marker of the source, so a rollback cannot land a foreign file either. */
  expectMarker?: string,
): Promise<FetchedSource | null> {
  const ref = parseRawGithubUrl(sourceUrl)
  if (!ref || !commit) return null
  const url = commitPinnedRawUrl(ref, commit)
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const text = await readSourceText(resp)
    const verified = await verifyWorkerSource(text, { ref, revision: commit, expectMarker })
    if (!verified.ok) return null
    return {
      code: text,
      url,
      etag: (resp.headers.get('etag') ?? '').trim(),
      usedFallback: true,
      sha256: verified.sha256,
      commitSha: verified.commitSha ?? commit,
      blobSha: verified.blobSha,
      checksumVerified: verified.checksumVerified,
      note: verified.note,
    }
  } catch {
    return null
  }
}

// ── «استقرار از هر مخزن گیت‌هاب» ────────────────────────────────────────
//
// The user may paste any GitHub repository (or a file inside one) and have it
// deployed as a Cloudflare Worker. Two things make that possible without
// guessing:
//
//   1. the worker entry file is resolved from the repo itself — the `main`
//      field of its own wrangler config first (that is the file Cloudflare
//      would build), then the conventional single-file worker paths;
//   2. the file is verified exactly like a catalogued source: GitHub's
//      published blob checksum for the revision that was read, so a truncated
//      download is refused instead of being uploaded as a broken script.
//
// No identity marker is set for this mode — we cannot know a stranger's
// project in advance — but the checksum still pins the bytes to that repo and
// revision, which is what the other sources' markers add on top.

/** Ask the GitHub API for a repo's default branch (`main` when unavailable). */
async function fetchGithubDefaultBranch(owner: string, repo: string): Promise<string> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'miliconfig-pro' },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return 'main'
    const data = (await resp.json().catch(() => null)) as { default_branch?: string } | null
    return data?.default_branch?.trim() || 'main'
  } catch {
    return 'main'
  }
}

/** True when `path` exists as a file at `branch` in the repo. */
async function githubFileExists(owner: string, repo: string, branch: string, path: string): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'miliconfig-pro' },
        signal: AbortSignal.timeout(8000),
      },
    )
    if (!resp.ok) return false
    const data = (await resp.json().catch(() => null)) as { type?: string } | null
    return data?.type === 'file'
  } catch {
    return false
  }
}

/** Read one file of a repo as text (used for the wrangler config). */
async function readGithubFile(owner: string, repo: string, branch: string, path: string): Promise<string> {
  try {
    const resp = await fetch(rawGithubFileUrl({ owner, repo, branch, path }, path), {
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return ''
    return await resp.text()
  } catch {
    return ''
  }
}

/** What a repo's own wrangler config says about the worker it builds. */
interface WranglerHints {
  main?: string
  compatDate?: string
  compatFlags?: string[]
}

/**
 * Parse the entry/compat fields out of `wrangler.toml`, `.jsonc` or `.json`.
 *
 * Only the three fields that matter here are read, and a config that cannot be
 * parsed simply yields nothing — the caller falls back to the conventional
 * entry-file list instead of failing the deployment.
 */
export function parseWranglerHints(text: string): WranglerHints {
  if (!text.trim()) return {}
  const hints: WranglerHints = {}
  const fromJson = (): WranglerHints | null => {
    try {
      // JSONC allows // comments; strip them before parsing.
      const cleaned = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
      const data = JSON.parse(cleaned) as { main?: unknown; compatibility_date?: unknown; compatibility_flags?: unknown }
      const out: WranglerHints = {}
      if (typeof data.main === 'string') out.main = data.main
      if (typeof data.compatibility_date === 'string') out.compatDate = data.compatibility_date
      if (Array.isArray(data.compatibility_flags)) {
        out.compatFlags = data.compatibility_flags.filter((f): f is string => typeof f === 'string')
      }
      return out
    } catch {
      return null
    }
  }
  const json = fromJson()
  if (json) return json
  const main = text.match(/^\s*main\s*=\s*["']([^"']+)["']/m)
  const compatDate = text.match(/^\s*compatibility_date\s*=\s*["']([^"']+)["']/m)
  const flags = text.match(/^\s*compatibility_flags\s*=\s*\[([^\]]*)\]/m)
  if (main?.[1]) hints.main = main[1]
  if (compatDate?.[1]) hints.compatDate = compatDate[1]
  if (flags?.[1]) {
    hints.compatFlags = flags[1]
      .split(',')
      .map((f) => f.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
  }
  return hints
}

/** Result of turning a pasted GitHub URL into a deployable source. */
export type GithubSourceResolution =
  | { ok: true; config: WorkerSourceConfig; entryPath: string; repoLabel: string; branch: string }
  | { ok: false; error: string }

/**
 * Turn a GitHub URL into a verified-deployable worker source.
 *
 * Rejects anything that cannot be resolved to a single file with a message
 * that names what was tried — the user sees the reason in the deploy log and
 * in the wizard, not a network error.
 */
export async function buildGithubSourceConfig(sourceUrl: string): Promise<GithubSourceResolution> {
  const parsed = parseGithubSourceUrl(sourceUrl)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const ref = parsed.ref
  const repoLabel = githubRepoLabel(ref)
  const branch = ref.branch || (await fetchGithubDefaultBranch(ref.owner, ref.repo))

  // ── Entry file: explicit path first, then wrangler `main`, then the usual
  // single-file worker locations.
  let entryPath = ''
  let hints: WranglerHints = {}
  if (ref.path && isWorkerEntryPath(ref.path) && (await githubFileExists(ref.owner, ref.repo, branch, ref.path))) {
    entryPath = ref.path
  } else {
    const dir = ref.path ? `${ref.path.replace(/\/+$/, '')}/` : ''
    for (const file of WRANGLER_CONFIG_FILES) {
      const text = await readGithubFile(ref.owner, ref.repo, branch, `${dir}${file}`)
      if (!text) continue
      hints = parseWranglerHints(text)
      if (hints.main) break
    }
    if (hints.main) {
      const main = hints.main.replace(/^\.\//, '')
      const candidates = isWorkerEntryPath(main) ? [`${dir}${main}`] : [`${dir}${main}.js`, `${dir}${main}/index.js`]
      for (const candidate of candidates) {
        if (await githubFileExists(ref.owner, ref.repo, branch, candidate)) {
          entryPath = candidate
          break
        }
      }
    }
    if (!entryPath) {
      // A GitHub URL that points at a directory is tried relative to that
      // directory first; a repo URL is tried at the root.
      for (const candidate of GITHUB_ENTRY_CANDIDATES.map((c) => `${dir}${c}`)) {
        if (await githubFileExists(ref.owner, ref.repo, branch, candidate)) {
          entryPath = candidate
          break
        }
      }
    }
    if (!entryPath && ref.path && isWorkerEntryPath(ref.path)) entryPath = ref.path
    if (!entryPath) {
      return {
        ok: false,
        error:
          `فایل ورکر در مخزن ${repoLabel} پیدا نشد. `+
          `این فایل‌ها بررسی شدند: ${GITHUB_ENTRY_CANDIDATES.join('، ')}. `+
          'آدرس مستقیم فایل را بدهید (مثلاً https://github.com/owner/repo/blob/main/worker.js) — ورکر باید یک فایل تک‌ماژول باشد (TS باید از قبل بیلد شده باشد).',
      }
    }
  }

  const config: WorkerSourceConfig = {
    url: rawGithubFileUrl(ref, entryPath, branch),
    label: `GitHub — ${repoLabel} (${entryPath})`,
    // The repo's own wrangler config is the authority for compat; the panel's
    // defaults are the fallback so a repo without one still deploys.
    compat: hints.compatDate || '2025-01-01',
    ...(hints.compatFlags?.length ? { compatFlags: hints.compatFlags } : {}),
    // Storage is opt-in for an unknown repo: the user ticks KV/D1 in the wizard
    // and the bindings are created here; nothing is provisioned otherwise.
    kvBinding: '',
    configKey: '',
    configFormat: 'custom',
    uuidEnvName: '',
    kind: WORKER_SOURCE_KIND.github,
    fallbackUrls: [],
  }
  return { ok: true, config, entryPath, repoLabel, branch }
}

/**
 * Keys of the **removed** obfuscation feature.
 *
 * The obfuscated format is gone from the code (it was incompatible with the
 * Cloudflare Workers runtime and made the platform refuse to run the script),
 * and a panel that still carries the setting has to be cleaned up rather than
 * left with a switch nothing honours any more. Nothing writes these keys
 * today; the guard is here so an older record can never bring the broken mode
 * back through an update.
 */
const LEGACY_OBFUSCATION_KEYS = ['obfuscate', 'obfuscation', 'obfuscated', 'source_obfuscated'] as const

/** Drop the removed obfuscation setting from a stored deployment config. */
export function stripLegacyObfuscation(cfg: Record<string, unknown>): boolean {
  let changed = false
  for (const key of LEGACY_OBFUSCATION_KEYS) {
    if (key in cfg) {
      delete cfg[key]
      changed = true
    }
  }
  return changed
}

/** Merge a patch into a deployment's JSON config (never overwrites the rest). */
export async function patchDeploymentConfig(
  env: Env,
  deploymentId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare('SELECT config FROM deployments WHERE id = ?')
    .bind(deploymentId)
    .first<{ config: string | null }>()
  const cfg = safeJsonParse<Record<string, unknown>>(row?.config ?? '', {})
  stripLegacyObfuscation(cfg)
  Object.assign(cfg, patch)
  await env.DB.prepare('UPDATE deployments SET config = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(cfg), nowIso(), deploymentId)
    .run()
  return cfg
}

/**
 * Store the upstream fingerprint on the deployment so "update from repo" can
 * tell the user whether anything actually changed — and, when `markGood` is
 * set, remember the revision as the one a rollback may return to.
 */
export async function recordSourceFingerprint(
  env: Env,
  deploymentId: string,
  source: {
    url: string
    etag: string
    bytes: number
    sha256?: string
    commitSha?: string | null
    blobSha?: string | null
    checksumVerified?: boolean
    /** These bytes are known to run — remember them as the rollback target. */
    markGood?: boolean
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    source_url: source.url,
    source_etag: source.etag,
    source_bytes: source.bytes,
    source_synced_at: nowIso(),
  }
  if (source.sha256) patch.source_sha256 = source.sha256
  if (source.commitSha) patch.source_commit = source.commitSha
  if (source.blobSha) patch.source_blob_sha = source.blobSha
  patch.source_checksum_verified = !!source.checksumVerified
  if (source.markGood) {
    patch.source_last_good_url = source.url
    if (source.commitSha) patch.source_last_good_commit = source.commitSha
    if (source.sha256) patch.source_last_good_sha256 = source.sha256
    patch.source_last_good_at = nowIso()
  }
  await patchDeploymentConfig(env, deploymentId, patch)
}

/** Input shared by the web API and the Telegram bot when starting a deploy. */
export interface StartDeploymentInput {
  userId: string
  /** Worker script name (lowercase letters, digits and hyphens). */
  name: string
  uuid: string
  /** Row id of the Cloudflare token to use (must belong to the user + be active). */
  cfTokenId: string
  method?: 'workers' | 'pages'
  workerSource?: string
  /**
   * "Deploy from any GitHub repository": the URL the user pasted. When set it
   * wins over `workerSource` and the entry file is resolved from the repo.
   */
  sourceUrl?: string
  /** Storage an arbitrary GitHub repo may want (nothing is created by default). */
  bindings?: { kv?: boolean; d1?: boolean }
  proxyip?: string
  adminPassword?: string
  customPath?: string
  /** Panel origin, used for the bundled-source fallback and the wizard link. */
  origin: string
  /**
   * Telegram chat that asked for this deployment.
   *
   * The result message goes to *this* chat, not to a chat looked up after the
   * fact: a bot that started the deploy owns the answer. Without it a panel
   * whose `bot_config.chat_id` is empty (the normal state — /start fills it)
   * had no target at all, so the deployment finished silently and the user sat
   * on the "استقرار شروع شد" screen forever.
   */
  notifyChat?: string
  notifyBotToken?: string
  notifyMessageId?: number | null
}

export type StartDeploymentResult = { ok: true; id: string } | { ok: false; error: string }

/**
 * Validate + create a deployment row and hand it to the deploy engine.
 * Extracted so the web API and the Telegram bot run the exact same checks
 * (name/uuid/token/quota) and can never drift apart.
 */
export async function startDeployment(
  env: Env,
  ctx: ExecutionContext,
  input: StartDeploymentInput,
): Promise<StartDeploymentResult> {
  let name = (input.name ?? '').trim().toLowerCase()
  const blacklistedNameRe = /vless|vmess|trojan|shadowsocks|wireguard|edgetunnel|cfnew|bpb|xray|v2ray|clash|singbox|cmliu/gi
  if (blacklistedNameRe.test(name)) {
    const cleanSuffix = Math.random().toString(16).slice(2, 6)
    name = name.replace(blacklistedNameRe, 'gw').replace(/-+/g, '-').replace(/^-|-$/g, '')
    if (!name || name === 'gw') name = `edge-gw-${cleanSuffix}`
    else if (!/\d/.test(name)) name = `${name}-${cleanSuffix}`
  }
  const uuid = (input.uuid ?? '').trim()
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) return { ok: false, error: 'نام ورکر نامعتبر است' }
  if (!uuid) return { ok: false, error: 'UUID الزامی است' }

  const tokenRow = await env.DB.prepare("SELECT id, token FROM cf_tokens WHERE id = ? AND user_id = ? AND status = 'active'")
    .bind(input.cfTokenId ?? '', input.userId)
    .first<{ id: string; token: string }>()
  if (!tokenRow) return { ok: false, error: 'توکن فعال انتخاب‌شده پیدا نشد' }

  const quotaRow = await env.DB.prepare('SELECT max_deployments FROM users WHERE id = ?')
    .bind(input.userId)
    .first<{ max_deployments: number | null }>()
  const quota = quotaRow?.max_deployments ?? 100
  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM deployments WHERE user_id = ?')
    .bind(input.userId)
    .first<{ c: number }>()
  if ((count?.c ?? 0) >= quota) return { ok: false, error: `به سقف تعداد ورکرهای خود (${quota}) رسیده‌اید` }

  // The pasted GitHub URL (and the storage choice made next to it) has to
  // survive on the record: the update/recover path re-reads the file from the
  // same repository instead of from a source id it would not find.
  const sourceUrl = (input.sourceUrl ?? '').trim()
  const workerSource = sourceUrl ? 'github' : input.workerSource ?? 'edgetunnel'
  const initialConfig: Record<string, unknown> = {}
  // `repo_url` (the URL the user pasted) is what the update path re-resolves;
  // `source_url` belongs to the fetched-file fingerprint written on every
  // deploy/update, so the two must not share a key.
  if (sourceUrl) initialConfig.repo_url = sourceUrl
  if (input.bindings) initialConfig.requested_bindings = { kv: !!input.bindings.kv, d1: !!input.bindings.d1 }
  if (input.notifyChat) initialConfig.notify_chat = input.notifyChat
  if (input.notifyBotToken) initialConfig.notify_bot_token = input.notifyBotToken
  if (input.notifyMessageId) initialConfig.notify_message_id = input.notifyMessageId

  const id = genId()
  await env.DB.prepare(
    `INSERT INTO deployments (id, user_id, name, worker_code, config, status, uuid, custom_path, method, worker_source, created_at, updated_at)
     VALUES (?, ?, ?, '[auto-loaded]', ?, 'deploying', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, input.userId, name, JSON.stringify(initialConfig), uuid, input.customPath || null,
      input.method === 'pages' ? 'pages' : 'workers', workerSource, nowIso(), nowIso())
    .run()

  await env.DB.prepare('INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(genId(), input.userId, 'deployment_created', 'deployment', name, nowIso())
    .run()

  ctx.waitUntil(runDeployment(env, {
    deployment_id: id,
    user_id: input.userId,
    worker_name: name,
    cf_token: tokenRow.token,
    cf_token_row_id: tokenRow.id,
    uuid,
    method: input.method === 'pages' ? 'pages' : 'workers',
    worker_source: workerSource,
    source_url: sourceUrl || undefined,
    extra_bindings: input.bindings,
    proxyip: input.proxyip || undefined,
    admin_password: input.adminPassword || undefined,
    custom_path: input.customPath || undefined,
    origin: input.origin,
    notify_chat: input.notifyChat,
    notify_bot_token: input.notifyBotToken,
    notify_message_id: input.notifyMessageId ?? null,
  }).catch((err) => console.error('runDeployment background error:', err)))

  return { ok: true, id }
}

export interface DeployJob {
  deployment_id: string
  user_id?: string
  worker_name: string
  cf_token: string
  cf_token_row_id?: string | null
  uuid: string
  method: 'workers' | 'pages'
  worker_source: string
  /** "Deploy from any GitHub repository" — resolved into a source at run time. */
  source_url?: string
  /** KV/D1 to bind for a GitHub source (nothing is created unless asked). */
  extra_bindings?: { kv?: boolean; d1?: boolean }
  proxyip?: string
  admin_password?: string
  custom_path?: string
  origin: string
  notify_chat?: string
  notify_bot_token?: string
  notify_message_id?: number | null
  /**
   * Set when this job is the automatic retry of a deployment that did not come
   * up in the environment the user chose (Workers answering `error code: 1101`,
   * or a Pages project this token cannot create). It makes that retry final so
   * the two fallbacks can never ping-pong.
   */
  retried_on_pages?: boolean
}

/**
 * How long a deployment may sit in `pending`/`deploying` before it is treated as
 * lost. The whole flow is bounded well under a minute now (uploads + a capped
 * self-check), so a row that is still running after this long belongs to a task
 * the runtime killed — the user would otherwise stare at «در حال استقرار»
 * forever with no way to tell that nothing is happening.
 */
const STALE_DEPLOY_MS = 5 * 60 * 1000

/**
 * Close out deployments whose background task died before it could report.
 * Returns how many rows were reaped. Timestamps are compared in the same ISO
 * format they are stored in, so no SQLite date parsing is involved.
 */
export async function reapStaleDeployments(env: Env, userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_DEPLOY_MS).toISOString()
  const message = 'استقرار نیمه‌کاره ماند — اجرای پس‌زمینه قطع شد. دوباره تلاش کنید.'
  const r = await env.DB.prepare(
    `UPDATE deployments
        SET status = 'failed', error_message = ?, updated_at = ?
      WHERE user_id = ? AND status IN ('pending', 'deploying') AND updated_at < ?`,
  )
    .bind(message, new Date().toISOString(), userId, cutoff)
    .run()
  return (r.meta?.changes as number | undefined) ?? 0
}

async function appendLog(env: Env, id: string, line: string): Promise<void> {
  const row = await env.DB.prepare('SELECT logs FROM deployments WHERE id = ?').bind(id).first<{ logs: string | null }>()
  const existing = row?.logs ?? ''
  // `updated_at` doubles as the liveness heartbeat the stale-deployment sweep
  // reads, so every log line counts as progress.
  await env.DB.prepare('UPDATE deployments SET logs = ?, updated_at = ? WHERE id = ?')
    .bind(existing + line + '\n', nowIso(), id)
    .run()
}

/** POST a D1 query through the Cloudflare API (used to pre-create the zeus
 *  panel schema on a freshly provisioned database). */
async function d1Query(
  apiBase: string,
  accountId: string,
  dbId: string,
  headers: Record<string, string>,
  sql: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${apiBase}/accounts/${accountId}/d1/database/${dbId}/query`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    })
    if (!resp.ok) return false
    const data = (await resp.json().catch(() => ({}))) as {
      success?: boolean
      result?: Array<{ error?: string; errors?: Array<{ message?: string }> }>
    }
    // A per-statement `error` (e.g. "no such table") still returns HTTP 200 +
    // success:true — check the payload too so failures are visible in logs.
    const first = data.result?.[0]
    if (!data.success || first?.error) return false
    return true
  } catch {
    return false
  }
}

/** Pre-create the ZEUS panel's D1 schema (mirrors DbService.ensureSchema in
 *  panel-zeus/Z-E-U-S Source.js). The worker also self-initializes on its
 *  first request, but seeding the tables here means the very first visitor
 *  never races an empty database and the deploy log can state what happened.
 *  Every statement is `IF NOT EXISTS` / idempotent UPDATE, so re-running this
 *  against a live panel is harmless. */
const ZEUS_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, uuid TEXT, limit_gb REAL, expiry_days INTEGER, ips TEXT, connection_type TEXT, tls TEXT, port INTEGER, used_gb REAL DEFAULT 0, is_active INTEGER DEFAULT 1, last_active INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `ALTER TABLE users ADD COLUMN advanced_frag TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN cipher_suites TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN tls_mask TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN last_active INTEGER`,
  `ALTER TABLE users ADD COLUMN fingerprint TEXT DEFAULT 'chrome'`,
  `ALTER TABLE users ADD COLUMN max_connections INTEGER`,
  `ALTER TABLE users ADD COLUMN limit_req INTEGER`,
  `ALTER TABLE users ADD COLUMN used_req INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN ip_limit INTEGER DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN active_ips TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN block_porn INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN block_ads INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN frag_len TEXT DEFAULT '200-3000'`,
  `ALTER TABLE users ADD COLUMN frag_int TEXT DEFAULT '1-2'`,
  `ALTER TABLE users ADD COLUMN lifetime_used_gb REAL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN user_proxy_ip TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN user_proxy_iata TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN user_socks5 TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN auto_reset_vol_days INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN auto_reset_req_days INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN last_reset_vol_time INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN last_reset_req_time INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN auto_rotate_ip INTEGER DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN rotate_time INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN ip_operator TEXT DEFAULT 'all'`,
  `ALTER TABLE users ADD COLUMN ip_count INTEGER DEFAULT 15`,
  `ALTER TABLE users ADD COLUMN last_rotate_time INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN auto_rotate_user_proxy INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN start_on_first_connect INTEGER DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN first_connection_time INTEGER DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN trojan_hash TEXT DEFAULT NULL`,
  `ALTER TABLE users ADD COLUMN enable_direct INTEGER DEFAULT 1`,
  `UPDATE users SET ip_limit = max_connections WHERE ip_limit IS NULL AND max_connections IS NOT NULL`,
  `UPDATE users SET lifetime_used_gb = used_gb WHERE lifetime_used_gb = 0 OR lifetime_used_gb IS NULL`,
]

/**
 * Run several D1 statements in **one** API call.
 *
 * Cloudflare's `/query` endpoint executes every `;`-separated statement and
 * returns one `result[]` entry per statement, so a whole schema costs a single
 * subrequest instead of one per statement. That number is not academic: this
 * code runs inside the panel worker's own invocation, which is capped at 50
 * subrequests per request on the free plan. The previous loop issued 37 calls
 * for the zeus schema alone, spent the entire budget, and every deploy then
 * died *after* a successful upload and re-create at
 * `enabling workers.dev route for script…` with
 * “Too many subrequests by single Worker invocation” — the worker was live but
 * its route was never enabled, so the run was reported as failed.
 *
 * A batch is all-or-nothing: one bad statement makes the endpoint answer
 * `success:false` with an empty `result[]`, and the caller records the whole
 * batch as skipped. That is exactly the re-run case (the `ALTER TABLE …
 * ADD COLUMN` half fails once the columns exist) and the statements are
 * idempotent, so nothing is lost.
 */
async function d1QueryBatch(
  apiBase: string,
  accountId: string,
  dbId: string,
  headers: Record<string, string>,
  statements: string[],
): Promise<{ ok: number; failed: number }> {
  if (!statements.length) return { ok: 0, failed: 0 }
  const done = await d1Query(apiBase, accountId, dbId, headers, statements.join(';\n'))
  return done ? { ok: statements.length, failed: 0 } : { ok: 0, failed: statements.length }
}

async function seedZeusSchema(
  apiBase: string,
  accountId: string,
  dbId: string,
  headers: Record<string, string>,
): Promise<{ ok: number; failed: number }> {
  // Two subrequests, not 37: the idempotent half (`CREATE TABLE IF NOT EXISTS`
  // / `UPDATE`) first, then the `ALTER TABLE … ADD COLUMN` half. `ALTER` fails
  // when the column already exists — that is expected on a re-run, so a failed
  // batch is not an error condition and the log reports it as skipped.
  const isAlter = (sql: string) => /^\s*ALTER\s+TABLE/i.test(sql)
  const base = await d1QueryBatch(apiBase, accountId, dbId, headers, ZEUS_SCHEMA_STATEMENTS.filter((s) => !isAlter(s)))
  const alters = await d1QueryBatch(apiBase, accountId, dbId, headers, ZEUS_SCHEMA_STATEMENTS.filter(isAlter))
  return { ok: base.ok + alters.ok, failed: base.failed + alters.failed }
}

/**
 * Pre-create the Mili (miliconfigOS / Miliconfigpro) D1 schema in a single API
 * batch before the script receives its first request, eliminating the cold-start
 * DDL race that otherwise triggers Error 1101 on a brand-new database.
 */
const MILI_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, uuid TEXT NOT NULL UNIQUE, sub_node_count INTEGER NOT NULL DEFAULT 50, status TEXT NOT NULL DEFAULT 'active', enabled INTEGER NOT NULL DEFAULT 1, data_limit_gb REAL NOT NULL DEFAULT 0, used_bytes INTEGER NOT NULL DEFAULT 0, lifetime_bytes INTEGER NOT NULL DEFAULT 0, request_count INTEGER NOT NULL DEFAULT 0, expire_days INTEGER NOT NULL DEFAULT 0, expire_at INTEGER NOT NULL DEFAULT 0, start_on_first_use INTEGER NOT NULL DEFAULT 1, first_connected_at INTEGER NOT NULL DEFAULT 0, ip_limit INTEGER NOT NULL DEFAULT 50, node_scope TEXT NOT NULL DEFAULT 'all', preset TEXT NOT NULL DEFAULT 'iran-fast', note TEXT DEFAULT '', config_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS preferred_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 443, name TEXT NOT NULL, colo TEXT DEFAULT '', latency INTEGER DEFAULT 0, source TEXT DEFAULT 'manual', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, detail TEXT NOT NULL, ip TEXT DEFAULT '', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS traffic_hourly (hour_key TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS country_proxy_pool (code TEXT NOT NULL, proxy TEXT NOT NULL, unverified INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL, PRIMARY KEY (code, proxy))`,
]

async function seedMiliSchema(
  apiBase: string,
  accountId: string,
  dbId: string,
  headers: Record<string, string>,
): Promise<{ ok: number; failed: number }> {
  return await d1QueryBatch(apiBase, accountId, dbId, headers, MILI_SCHEMA_STATEMENTS)
}

/**
 * Post-verification cold-start optimizer for fetched worker sources.
 *
 * Runs AFTER `verifyWorkerSource` has verified the upstream GitHub blob SHA-1
 * and byte length, so checksum integrity is 100% preserved. Eliminates the
 * top-level cold-start CPU bottlenecks that cause `error code: 1101` on
 * Cloudflare Workers Free accounts (10ms startup CPU limit):
 *   1. Replaces per-call `new TextDecoder().decode(...)` + `atob(...)` inside
 *      Mili's `_0xMiliDec` (both Terser-minified `dist/_worker.js` and
 *      unmangled builds) with a zero-allocation Base64+XOR lookup table and a
 *      single shared `TextDecoder` + ASCII fast-path.
 *   2. Replaces per-call `new TextDecoder().decode(bytes)` inside CFnew/NEXUS
 *      `解码64` with a shared `TextDecoder` + ASCII fast-path.
 *   3. Converts top-level `await import("cloudflare:sockets")` in NEXUS into a
 *      non-blocking microtask so module evaluation is synchronous.
 */
export function optimizeWorkerSourceForColdStart(code: string, seedInput?: string): string {
  return obfuscateWorkerWithEdgetunnelMethod(code, seedInput)
}

/** Poll a freshly deployed worker until it answers with anything other than
 *  Cloudflare's uncaught-exception page (`error code: 1101`) or a transport
 *  error. A brand-new script needs a few seconds before its first invocation
 *  succeeds (route propagation + cold isolate); during that window every hit
 *  returns 1101. Returning early only when the worker really responds is what
 *  stops the UI from pointing at a dead URL. */
export async function waitForWorkerLive(
  url: string,
  attempts = 12,
  delayMs = 1500,
  /**
   * Hard wall-clock budget for the whole probe.
   *
   * This runs inside the deploy/update request, so an unbounded loop is a real
   * bug: 12 attempts × 8s fetch timeout + 1.5s delay is up to 114s, and both
   * the CDN (100s → 524) and the runtime's background-task allowance kill the
   * work long before that — leaving the deployment stuck on "در حال استقرار"
   * with no link. A live worker answers on the first try, so a short budget
   * loses nothing and guarantees the rest of the flow always runs.
   */
  totalBudgetMs = 25_000,
  /**
   * Keep probing for the whole budget instead of returning on the first live
   * response.
   *
   * A heavy script (CFnew / NEXUS / ZEUS in their bundled form) answers its very
   * first requests — the isolate Cloudflare spun up during the upload is warm —
   * and then starts returning 1101 on every cold isolate that follows, because
   * the script's startup work no longer fits the Workers startup budget of the
   * account. Returning `true` at the first success therefore marked a worker as
   * healthy minutes before it died for good. With `requireStable` the result is
   * the LAST probe, so such a worker is reported as dead.
   */
  requireStable = false,
): Promise<boolean> {
  const deadline = Date.now() + totalBudgetMs
  let sawLive = false
  let lastAlive = false
  for (let i = 0; i < attempts; i++) {
    if (Date.now() >= deadline) break
    let alive = false
    try {
      const ctrl = new AbortController()
      const wait = Math.max(500, Math.min(8000, deadline - Date.now()))
      const timer = setTimeout(() => ctrl.abort(), wait)
      const resp = await fetch(url, { redirect: 'manual', signal: ctrl.signal }).finally(() => clearTimeout(timer))
      const text = await resp.text().catch(() => '')
      // Anything that is not the runtime-exception interstitial means the
      // script executed — 200/302/404/503 all count as "alive".
      alive = !text.includes('error code: 1101')
    } catch {
      // DNS not resolved yet / edge not propagated — keep polling.
    }
    if (alive) sawLive = true
    if (!requireStable && alive) return true
    lastAlive = alive
    if (Date.now() + delayMs >= deadline) break
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return requireStable ? sawLive && lastAlive : sawLive
}

/**
 * Can this account run *any* Worker at all?
 *
 * `error code: 1101` has two very different causes and the deploy log used to
 * present both as "this source is too heavy":
 *
 *   • the script is too big/slow to start on this account (a real property of
 *     the source), and
 *   • Workers is not provisioned for the account at all — in which case even a
 *     three-line `hello` script answers 1101 on every request, the upload still
 *     succeeds, and the isolate is never reached.
 *
 * The second case is invisible in the deploy log and unfixable from code: the
 * account owner has to open the Cloudflare dashboard once (Workers & Pages →
 * Get started), which finishes the provisioning. So the failure path deploys a
 * throwaway canary worker, probes it and deletes it, and the log can then say
 * *which* of the two happened instead of guessing.
 *
 * Returns `unknown` whenever the canary itself could not be created — a token
 * that cannot upload must not be reported as a broken account.
 */
export async function probeWorkersRuntime(
  accountId: string,
  authHeader: string,
  workersSubdomain: string,
): Promise<'ok' | 'blocked' | 'unknown'> {
  if (!workersSubdomain) return 'unknown'
  const name = `mili-canary-${Math.random().toString(36).slice(2, 7)}`
  try {
    const form = new FormData()
    form.append(
      'metadata',
      new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: '2025-01-01' })], {
        type: 'application/json',
      }),
    )
    form.append(
      'worker.js',
      new Blob(["export default { fetch: () => new Response('ok') }"], { type: 'application/javascript+module' }),
      'worker.js',
    )
    const uploaded = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
      method: 'PUT',
      headers: { Authorization: authHeader },
      body: form,
    })
    if (!uploaded.ok) return 'unknown'
    const route = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    if (!route.ok) return 'unknown'
    // A brand-new script needs a moment before its route answers, which is the
    // same propagation window the deployment's own warm-up waits through.
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const alive = await waitForWorkerLive(`https://${name}.${workersSubdomain}.workers.dev/`, 3, 2000, 12_000, true)
    return alive ? 'ok' : 'blocked'
  } catch {
    return 'unknown'
  } finally {
    await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
      method: 'DELETE',
      headers: { Authorization: authHeader },
    }).catch(() => null)
  }
}

/**
 * One-shot liveness check for a deployment that was reported healthy — called
 * from the API the SPA polls, NOT from the deploy task.
 *
 * Why here: the deploy task lives on the runtime's short post-response budget,
 * so it cannot watch a worker long enough to catch the failure mode this panel
 * kept shipping — a heavy bundle answers its first requests (the isolate
 * Cloudflare warmed during the upload is still around) and then answers every
 * later cold isolate with `error code: 1101`. Reading the deployment minutes
 * later gives the answer that matters: if the worker now answers 1101, the row
 * is healed by redeploying the identical source on Pages, in the background,
 * and the next poll shows the working URL.
 *
 * Throttled through `self_check_at` so repeated polls cost at most one probe
 * per 90 seconds and never a probe while the worker was just verified.
 */
export async function verifyAndHeal(
  env: Env,
  ctx: ExecutionContext,
  row: Record<string, unknown>,
  origin: string,
): Promise<void> {
  if (row.method !== 'workers' || row.status !== 'deployed') return
  const workerUrl = typeof row.worker_url === 'string' ? row.worker_url : ''
  const id = String(row.id ?? '')
  if (!workerUrl || !id) return
  const cfg = safeJsonParse<Record<string, unknown>>(typeof row.config === 'string' ? row.config : '', {})
  const at = typeof cfg.self_check_at === 'string' ? Date.parse(cfg.self_check_at) : 0
  // Already known dead (the Pages heal is running or has run) — leave it alone.
  if (cfg.self_check === 'dead' || cfg.self_check === 'failed') return
  if (cfg.self_check !== 'passed') return
  const now = Date.now()
  if (at && now - at < 90_000) return
  // Claim the slot BEFORE probing so concurrent polls do not probe as well.
  await patchDeploymentConfig(env, id, { self_check_at: new Date(now).toISOString() })

  const alive = await waitForWorkerLive(workerUrl, 1, 0, 5_000)
  if (alive) return

  const tokenRow = row.cf_token_row_id
    ? await env.DB.prepare('SELECT token FROM cf_tokens WHERE id = ? AND user_id = ?')
        .bind(String(row.cf_token_row_id), String(row.user_id)).first<{ token: string }>()
    : await env.DB.prepare(
        `SELECT token FROM cf_tokens WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      ).bind(String(row.user_id)).first<{ token: string }>()
  if (!tokenRow?.token || !row.cf_account_id) return

  await patchDeploymentConfig(env, id, { self_check: 'dead' })
  await appendLog(
    env,
    id,
    '⚠ ورکر دیگر جواب نمی‌دهد (error code 1101) — همان منبع را روی صفحات (Pages) مستقر می‌کنم…',
  )
  await updateDeployment(env, id, 'deploying', { method: 'pages', error_message: null })
  ctx.waitUntil(runDeployment(env, {
    deployment_id: id,
    worker_name: String(row.name ?? ''),
    cf_token: tokenRow.token,
    cf_token_row_id: typeof row.cf_token_row_id === 'string' ? row.cf_token_row_id : null,
    uuid: String(row.uuid ?? ''),
    method: 'pages',
    worker_source: String(row.worker_source ?? 'edgetunnel'),
    origin,
    retried_on_pages: true,
  }))
}

/**
 * The account's workers.dev subdomain, i.e. the middle label of
 * `<script>.<subdomain>.workers.dev`.
 *
 * `GET /accounts/:id/workers/subdomain` needs script read access and answers
 * `success: false` for a token that only carries account-level grants, so the
 * panel used to fall back to `https://<script>.workers.dev` — a host that can
 * never resolve. Every later step then polled that dead name until the runtime
 * killed the deployment. Falling back to a subdomain this account already
 * published (an older deployment's URL) keeps the address real, and an empty
 * result is now treated as a known limitation instead of a live URL.
 */
async function resolveWorkersSubdomain(
  env: Env,
  accountId: string,
  headers: Record<string, string>,
  workerName: string,
): Promise<string> {
  const read = async (): Promise<string> => {
    try {
      const resp = await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, { headers })
      const data = (await resp.json().catch(() => ({}))) as { result?: { subdomain?: string } }
      return (data.result?.subdomain ?? '').trim()
    } catch {
      return ''
    }
  }

  const known = await read()
  if (known) return known

  // No subdomain yet (first worker of a fresh account): register one, exactly
  // like the workers.dev-route fallback below does. Without this the URL stayed
  // `https://<script>.workers.dev`, which is not a host Cloudflare serves.
  const candidate = `edge-${workerName}`.replace(/[^a-z0-9-]/g, '').slice(0, 30)
  try {
    await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subdomain: candidate }),
    })
  } catch {
    // Not permitted with this token — the stored-URL fallback below applies.
  }
  const registered = await read()
  if (registered) return registered

  // `%.workers.dev%` (not `%.workers.dev/%`): stored worker URLs have no
  // trailing path, so a slash-anchored LIKE matches nothing at all.
  const row = await env.DB.prepare(
    `SELECT worker_url FROM deployments
      WHERE cf_account_id = ? AND worker_url LIKE '%.workers.dev%'
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(accountId)
    .first<{ worker_url: string }>()
  const match = row?.worker_url?.match(/^https:\/\/[^.]+(?:\.[^.]+)*?\.([a-z0-9-]+)\.workers\.dev/i)
  return match?.[1] ?? ''
}

async function updateDeployment(env: Env, id: string, status: string, updates: Record<string, unknown>): Promise<void> {
  const sets = ['status = ?', 'updated_at = ?']
  const binds: unknown[] = [status, nowIso()]
  for (const [k, v] of Object.entries(updates)) {
    sets.push(`${k} = ?`)
    binds.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)
  }
  binds.push(id)
  await env.DB.prepare(`UPDATE deployments SET ${sets.join(', ')} WHERE id = ?`).bind(...(binds as string[])).run()
}

/**
 * Create a Pages deployment whose worker is a single `_worker.js` module.
 *
 * The direct-upload API takes the worker as its own form field (`_worker.bundle`,
 * the bundle) and a `manifest` that describes only the *static assets* it
 * carries — `_worker.js` is not an asset, which is why wrangler excludes it from
 * the manifest. The one-shot multipart upload this panel used before (the file
 * under its own name, plus `branch`, no manifest) is now rejected with
 * `8000096 A "manifest" field was expected`, so every Pages deployment failed.
 *
 * `_worker.bundle` is not a raw script: it is a nested multipart body (its own
 * boundary) holding a `metadata` part — `{ main_module }` plus the compatibility
 * date — and the module itself, exactly what wrangler wraps as a Blob. A raw
 * JavaScript file in that field is rejected with `Request body is incorrect`,
 * and the old one-shot upload (`_worker.js` + `branch`, no manifest) is rejected
 * with `8000096 A "manifest" field was expected`. With no static assets the
 * outer manifest is `{}` and no asset upload round-trip is needed.
 */
export async function uploadPagesDeployment(
  accountId: string,
  projectName: string,
  code: string,
  authHeaders: Record<string, string>,
  compatibilityDate: string,
  compatibilityFlags: string[] = [],
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const boundary = `----mili-pages-${genId()}`
  const moduleName = 'worker.js'
  const metaObj: Record<string, unknown> = { main_module: moduleName, compatibility_date: compatibilityDate }
  if (compatibilityFlags.length > 0) metaObj.compatibility_flags = compatibilityFlags
  const workerBundle = new Blob(
    [
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n` +
        `${JSON.stringify(metaObj)}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="${moduleName}"; filename="${moduleName}"\r\n` +
        `Content-Type: application/javascript+module\r\n\r\n`,
      code,
      `\r\n--${boundary}--\r\n`,
    ],
    { type: `multipart/form-data; boundary=${boundary}` },
  )

  const form = new FormData()
  form.append('manifest', JSON.stringify({}))
  form.append('branch', 'main')
  form.append('_worker.bundle', workerBundle, '_worker.bundle')
  const depResp = await fetch(`${API_BASE}/accounts/${accountId}/pages/projects/${projectName}/deployments`, {
    method: 'POST',
    headers: authHeaders,
    body: form,
  })
  const depData = (await depResp.json().catch(() => ({}))) as { success?: boolean; result?: { url?: string }; errors?: Array<{ message?: string }> }
  if (!depResp.ok || depData.success === false) {
    return { ok: false, error: depData.errors?.[0]?.message ?? `deployment failed (HTTP ${depResp.status})` }
  }
  return { ok: true, url: depData.result?.url }
}

export async function runDeployment(env: Env, job: DeployJob): Promise<void> {
  const { deployment_id } = job
  const worker_name = job.worker_name
  const cf_token = job.cf_token
  const uuid = job.uuid
  const custom_path = job.custom_path ?? ''
  const worker_source = job.worker_source || 'edgetunnel'

  // ── Resolve the source BEFORE anything is uploaded ──────────────────────
  // An id this build does not know is a hard failure. The old line here was
  // `WORKER_SOURCES[id] ?? WORKER_SOURCES.edgetunnel`, and that silent fallback
  // is how a deployment named "Nova" ended up running cmliu's worker: the name
  // was right, the code belonged to another project. A GitHub URL is resolved
  // the same way — into a verified single-file source — before the upload.
  let sourceConfig0: WorkerSourceConfig
  if (job.source_url) {
    const resolved = await buildGithubSourceConfig(job.source_url)
    if (!resolved.ok) {
      await appendLog(env, deployment_id, `✗ ${resolved.error}`)
      await updateDeployment(env, deployment_id, 'failed', { error_message: resolved.error })
      return
    }
    sourceConfig0 = resolved.config
    await appendLog(
      env,
      deployment_id,
      `✓ GitHub source resolved: ${resolved.repoLabel}@${resolved.branch} → ${resolved.entryPath}`,
    )
    await patchDeploymentConfig(env, deployment_id, {
      repo_url: job.source_url,
      source_entry: resolved.entryPath,
      source_repo: resolved.repoLabel,
    })
  } else {
    const known = lookupWorkerSource(worker_source)
    if (!known) {
      const msg =
        `منبع ورکر «${worker_source}» در این نسخه از پنل شناخته‌شده نیست — استقرار انجام نشد تا پنل اشتباهی روی حساب شما بالا نیاید.`
      await appendLog(env, deployment_id, `✗ ${msg}`)
      await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
      return
    }
    sourceConfig0 = known
  }
  // ── Method choice ──────────────────────────────────────────────────────
  // The environment is the USER's choice for EVERY source in the catalog —
  // edgetunnel (both modes), CFnew, NEXUS, the D1 panels (zeus, miliconfig
  // zeus, nova, miliconfigOS) and an arbitrary GitHub repo alike.
  //
  // This used to be rewritten here: any non-GitHub source was sent to Pages on
  // the first attempt (the «Cfnew و nexus روی ورکر خطا می‌دهد» workaround), so
  // picking «CF Workers» in the wizard silently produced a Pages project. Both
  // environments upload the very same bytes (`deployCode`) and carry the same
  // D1/KV/R2 bindings, so the choice belongs to the user again.
  //
  // The safety net stays and only ever runs AFTER the chosen environment
  // failed: a worker that answers `error code: 1101` is re-deployed on Pages
  // (below), and a Pages project this token cannot create falls back to
  // Workers (at the upload). `retried_on_pages` marks that fallback so the two
  // can never ping-pong.
  const method: DeployJob['method'] = job.method
  await appendLog(
    env,
    deployment_id,
    `ℹ environment: ${method === 'pages' ? 'Cloudflare Pages' : 'Cloudflare Workers'} (your choice) — if the source cannot start there, it is retried on the other one.`,
  )
  const proxyip = job.proxyip ?? ''
  const admin_password = job.admin_password ?? ''
  const headers = { Authorization: `Bearer ${cf_token}` }
  let notifiedSuccess = false
  const reportProgress = async (percent: number, stage: string, detail?: string) => {
    if (!job.notify_chat || !job.notify_message_id) return
    await notifyDeploymentProgress(env, {
      userId: job.user_id ?? '',
      workerName: worker_name,
      percent,
      stage,
      detail,
      chatId: job.notify_chat,
      botToken: job.notify_bot_token,
      messageId: job.notify_message_id,
    }).catch(() => null)
  }

  try {
    await reportProgress(25, 'تأیید توکن و بررسی حساب Cloudflare...')
    const sourceConfig = sourceConfig0
    const compatDate = sourceConfig.compat
    // A GitHub source binds KV only when the user asked for it.
    const kvBindingName =
      sourceConfig.kind === 'github' && job.extra_bindings?.kv ? 'KV' : sourceConfig.kvBinding
    const configKvKey = sourceConfig.configKey
    const configFormat = sourceConfig.configFormat
    const uuidEnv = sourceConfig.uuidEnvName

    // ── Verify token + resolve account ──────────────────────────────────
    // `/user/tokens/verify` only accepts *user*-scoped tokens. An Account API
    // Token — the kind Cloudflare's own dashboard hands out for "Edit
    // Cloudflare Workers" — is rejected there with "Invalid API Token" even
    // though it works for every endpoint this panel uses, so a normal user
    // could never deploy. A failed verify therefore falls through to the
    // account listing below, which is the real capability check; only a token
    // that cannot list an account is treated as invalid (the old behaviour).
    await appendLog(env, deployment_id, 'verifying token...')
    const verifyResp = await fetch(`${API_BASE}/user/tokens/verify`, { headers })
    const verifyData = (await verifyResp.json().catch(() => ({}))) as { success?: boolean }
    if (verifyData.success) await appendLog(env, deployment_id, '✓ token verified (user token)')
    else await appendLog(env, deployment_id, 'ℹ user-token verify declined — checking account access instead (expected for Account API tokens)')

    // ── Resolve account ─────────────────────────────────────────────────
    await appendLog(env, deployment_id, 'listing accounts...')
    const accountsResp = await fetch(`${API_BASE}/accounts?per_page=50`, { headers })
    const accountsData = (await accountsResp.json().catch(() => ({}))) as { success?: boolean; result?: Array<{ id: string; name: string }> }
    if (!accountsData.success || !accountsData.result?.length) {
      await appendLog(env, deployment_id, '✗ invalid cloudflare token (cannot list accounts)')
      await updateDeployment(env, deployment_id, 'failed', { error_message: 'invalid cloudflare token' })
      return
    }
    await appendLog(env, deployment_id, '✓ token can deploy (account access confirmed)')
    const accountId = accountsData.result[0].id
    const accountName = accountsData.result[0].name
    await appendLog(env, deployment_id, `✓ account: ${accountName} (${accountId.slice(0, 8)}...)`)

    // ── Fetch worker source ─────────────────────────────────────────────
    await reportProgress(45, `دریافت و بهینه‌سازی سورس (${sourceConfig.label})...`)
    await appendLog(env, deployment_id, `fetching worker source from ${sourceConfig.label}...`)
    let workerCode = ''
    // Primary URL first; if unavailable (e.g. repo moved/renamed), fall back to
    // the copy bundled with this panel so the default source can never 404.
// Fallbacks may be absolute (a mirror) or panel-relative (the copy bundled
    // in `public/repo/`, e.g. `/repo/nexus.js`). A relative one is read from
    // this deployment's own asset bundle first (no self-fetch), with the public
    // origin kept only as a last resort for hosts that serve `/repo/*` alone.
    const originBase = job.origin.replace(/\/$/, '')
    const readLocal = async (path: string): Promise<string | null> => {
      const bundled = await readBundledAsset(env, path)
      if (bundled) return bundled
      try {
        const resp = await fetch(`${originBase}${path.startsWith('/') ? path : `/${path}`}`)
        if (!resp.ok) return null
        const text = await readSourceText(resp)
        return text.trim() ? text : null
      } catch {
        return null
      }
    }
    const fetchResult = await fetchWorkerSource(sourceConfig, sourceConfig.fallbackUrls ?? [], readLocal)
    const fetched = fetchResult.source
    for (const line of fetchResult.errors) {
      await appendLog(env, deployment_id, `⚠ ${line}`)
    }
    workerCode = fetched?.code ?? ''
    if (!fetched || !workerCode) {
      // Integrity failures are spelled out: the log has to say *why* nothing was
      // deployed, because a partial download is the exact failure this screen
      // exists for.
      const detail = fetchResult.errors.join(' · ').slice(0, 400)
      await appendLog(env, deployment_id, '✗ failed to fetch a verified worker source')
      await updateDeployment(env, deployment_id, 'failed', {
        error_message: detail ? `failed to fetch worker source: ${detail}` : 'failed to fetch worker source',
      })
      return
    }
    if (fetched.usedFallback) {
      const where = /^https?:\/\//i.test(fetched.url) ? new URL(fetched.url).host : 'بستهٔ خود پنل'
      await appendLog(env, deployment_id, `primary source unavailable, used fallback (${where})`)
    }
    await appendLog(
      env,
      deployment_id,
      `✓ worker source fetched (${workerCode.length} bytes)` +
        (fetched.checksumVerified
          ? ` — checksum verified against upstream ${fetched.commitSha?.slice(0, 8) ?? fetched.blobSha?.slice(0, 8) ?? ''}`
          : ' — local checks only (no published checksum for this copy)'),
    )
    if (fetched.note) await appendLog(env, deployment_id, `ℹ ${fetched.note}`)

    // The source is uploaded exactly as upstream publishes it. (The per-deployment
    // "obfuscated format" that used to rewrite it here is gone: it was
    // incompatible with the Cloudflare Workers runtime and made the platform
    // refuse to run the uploaded script.)
    const uniqueDeploySeed = generateUniqueDeploymentSeed(`${deployment_id}:${worker_name}:${worker_source}:${uuid}`)
    const deployCode = optimizeWorkerSourceForColdStart(workerCode, uniqueDeploySeed)
    await appendLog(env, deployment_id, `✓ unique edgetunnel polymorphic obfuscation applied (seed ${uniqueDeploySeed.slice(-12)})`)

    await recordSourceFingerprint(env, deployment_id, {
      url: fetched.url,
      etag: fetched.etag,
      bytes: fetched.code.length,
      sha256: fetched.sha256,
      commitSha: fetched.commitSha,
      blobSha: fetched.blobSha,
      checksumVerified: fetched.checksumVerified,
    })

    // ── Provision storage ────────────────────────────────────────────────
    // • zeus-style panels (zeus / miliconfigzeus / nova) get a D1 database;
    // • a source declaring `kvBinding` gets its KV namespace;
    // • an arbitrary GitHub repo gets exactly what the user ticked.
    let d1DatabaseId = ''
    let kvNamespaceId = ''
    const wantsD1 =
      sourceConfig.kind === 'zeus' ||
      sourceConfig.provisionD1 === true ||
      (sourceConfig.kind === 'github' && !!job.extra_bindings?.d1)
    // edgetunnel/CFnew cannot work without their namespace, so a failure there
    // fails the deployment; for panels and GitHub repos KV is optional.
    const kvRequired = kvBindingName !== '' && sourceConfig.kind !== 'zeus' && sourceConfig.kind !== 'github'
    if (wantsD1) {
      await appendLog(env, deployment_id, 'creating D1 database...')
      const d1Name = `${worker_name}-db`
      const d1Resp = await fetch(`${API_BASE}/accounts/${accountId}/d1/database`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: d1Name }),
      })
      const d1Data = (await d1Resp.json().catch(() => ({}))) as { success?: boolean; result?: { uuid?: string }; errors?: Array<{ message: string }> }
      d1DatabaseId = d1Data.result?.uuid ?? ''
      if (!d1DatabaseId) {
        // Already exists? Reuse it instead of failing (or reuse an existing -db if the account hit the 10-DB Free limit).
        const listResp = await fetch(`${API_BASE}/accounts/${accountId}/d1/database?per_page=100`, { headers })
        const listData = (await listResp.json().catch(() => ({}))) as { result?: Array<{ uuid?: string; name?: string }> }
        const list = listData.result ?? []
        d1DatabaseId = list.find((d) => d.name === d1Name)?.uuid
          ?? list.find((d) => (d.name ?? '').endsWith('-db'))?.uuid
          ?? ''
      }
      if (!d1DatabaseId) {
        const msg = d1Data.errors?.[0]?.message ?? 'failed to create D1 database'
        await appendLog(env, deployment_id, `✗ ${msg}`)
        await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
        return
      }
      await appendLog(env, deployment_id, `✓ D1 database ready: ${d1DatabaseId.slice(0, 8)}...`)
    }
    if (kvBindingName) {
      await reportProgress(68, 'ایجاد و اتصال فضای ذخیره‌سازی KV...')
      await appendLog(env, deployment_id, 'creating KV namespace...')
      const kvTitle = `${worker_name}-kv`
      const kvResp = await fetch(`${API_BASE}/accounts/${accountId}/storage/kv/namespaces`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: kvTitle }),
      })
      const kvData = (await kvResp.json().catch(() => ({}))) as { success?: boolean; result?: { id: string }; errors?: Array<{ message: string }> }
      if (kvData.success && kvData.result?.id) {
        kvNamespaceId = kvData.result.id
        await appendLog(env, deployment_id, `✓ KV namespace created: ${kvNamespaceId.slice(0, 8)}...`)
      } else {
        // Already exists on this account? Reuse it just like D1 and R2!
        const kvListResp = await fetch(`${API_BASE}/accounts/${accountId}/storage/kv/namespaces?per_page=100`, { headers }).catch(() => null)
        const kvListData = (await kvListResp?.json().catch(() => ({}))) as { result?: Array<{ id?: string; title?: string }> }
        const namespaces = kvListData.result ?? []
        kvNamespaceId = namespaces.find((k) => k.title === kvTitle)?.id
          ?? namespaces.find((k) => (k.title ?? '').endsWith('-kv'))?.id
          ?? ''
        if (kvNamespaceId) {
          await appendLog(env, deployment_id, `✓ KV namespace reused: ${kvNamespaceId.slice(0, 8)}...`)
        } else if (kvRequired) {
          const msg = kvData.errors?.[0]?.message ?? 'failed to create KV namespace'
          await appendLog(env, deployment_id, `✗ ${msg}`)
          await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
          return
        } else {
          await appendLog(env, deployment_id, `⚠ KV namespace unavailable (${kvData.errors?.[0]?.message ?? 'no permission'}) — continuing without KV`)
        }
      }
    }

    // ── Provision R2 bucket (free tier: 10 GB + zero egress) ────────────
    // Bound as R2 on every deployed worker — heavy data (logs, scan results,
    // IP lists, sub caches) can live here instead of slowing D1/KV down.
    // Non-fatal: if the token lacks R2 permission we just log and continue.
    let r2BucketName = ''
    await appendLog(env, deployment_id, 'creating R2 bucket...')
    const r2Name = `${worker_name}-r2`
    const r2Resp = await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: r2Name }),
    })
    const r2Data = (await r2Resp.json().catch(() => ({}))) as { success?: boolean; result?: { name?: string }; errors?: Array<{ message: string }> }
    if (r2Data.success && r2Data.result?.name) {
      r2BucketName = r2Data.result.name
      await appendLog(env, deployment_id, `✓ R2 bucket created: ${r2BucketName} (free tier)`)
    } else {
      // Already exists? Reuse it.
      const r2ListResp = await fetch(`${API_BASE}/accounts/${accountId}/r2/buckets?per_page=100`, { headers })
      const r2ListData = (await r2ListResp.json().catch(() => ({}))) as { result?: { buckets?: Array<{ name?: string }> } }
      r2BucketName = r2ListData.result?.buckets?.find((b) => b.name === r2Name)?.name ?? ''
      if (r2BucketName) {
        await appendLog(env, deployment_id, `✓ R2 bucket reused: ${r2BucketName}`)
      } else {
        await appendLog(env, deployment_id, `⚠ R2 bucket unavailable (${r2Data.errors?.[0]?.message ?? 'no permission'}) — continuing without R2`)
      }
    }

    // ── Write initial config to KV (KV sources only; zeus self-manages) ─
    let initialConfig: Record<string, unknown>
    const addTxtKey = 'ADD.txt'

    // Panel path for edgetunnel: the custom path if set, otherwise always
    // /admin so the panel address is predictable and ends with /admin.
    const panelPath = custom_path
      ? (custom_path.startsWith('/') ? custom_path : '/' + custom_path)
      : '/admin'

    if (sourceConfig.kind === 'github') {
      // An arbitrary GitHub repo has its own configuration scheme (env vars,
      // its own KV keys) which we cannot know, so nothing is seeded and no KV
      // value is written. The deploy log says so rather than pretending a
      // config was written to a namespace that may not even exist.
      initialConfig = {}
      await appendLog(
        env,
        deployment_id,
        'ℹ منبع GitHub: پیکربندی اولیه نوشته نشد — کانفیگ را در خود پنل/اپ ورکر تنظیم کنید.',
      )
    } else if (sourceConfig.kind === 'zeus') {
      if (worker_source === 'nova') {
        await appendLog(env, deployment_id, 'ℹ Nova D1 database attached (schema initialized by Nova on first launch)')
      } else {
        await appendLog(env, deployment_id, 'seeding zeus D1 schema (users/settings tables)…')
        const seeded = await seedZeusSchema(API_BASE, accountId, d1DatabaseId, headers)
        await appendLog(
          env,
          deployment_id,
          `✓ zeus D1 schema ready (${seeded.ok} statements applied${seeded.failed ? `, ${seeded.failed} already present/skipped` : ''})`,
        )
      }
    } else if (sourceConfig.kind === 'uuidpanel' && d1DatabaseId) {
      await appendLog(env, deployment_id, 'seeding Mili D1 schema (system_config/users/nodes tables)…')
      const seeded = await seedMiliSchema(API_BASE, accountId, d1DatabaseId, headers)
      await appendLog(
        env,
        deployment_id,
        `✓ Mili D1 schema ready (${seeded.ok} statements applied${seeded.failed ? `, ${seeded.failed} already present/skipped` : ''})`,
      )
    } else {

    if (sourceConfig.kind === 'nexus') {
      // NEXUS merges over its own defaults — just seed identity + proxyip.
      initialConfig = { name: 'NEXUS', lang: 'fa', theme: 'dark', uuid, p: proxyip || '' }
    } else if (configFormat === 'custom') {
      initialConfig = {
        wk: '', ev: 'yes', et: 'no', ex: 'no', ech: 'no', tp: '',
        customDNS: 'https://223.5.5.5/dns-query',
        customECHDomain: 'cloudflare-ech.com',
        alpn: '', d: custom_path || '', p: proxyip || '', yx: '', yxURL: '', s: '', homepage: '',
        scu: 'https://url.v1.mk/sub', ena: 'no', epd: 'yes', epi: 'yes', egi: 'yes',
        ae: '', rm: '', qj: '', dkby: 'no', yxby: '',
        ipv4: 'yes', ipv6: 'yes', ispMobile: 'yes', ispUnicom: 'yes', ispTelecom: 'yes',
      }
    } else {
      initialConfig = {
        UUID: uuid,
        HOST: '',
        HOSTS: [],
        PATH: panelPath,
        协议类型: 'vless',
        传输协议: 'ws',
        gRPC模式: 'gun',
        gRPCUserAgent: 'Mozilla/5.0',
        跳过证书验证: false,
        启用0RTT: false,
        TLS分片: null,
        随机路径: false,
        ECH: false,
        ECHConfig: { DNS: 'https://dns.alidns.com/dns-query', SNI: 'cloudflare-ech.com' },
        SS: { 加密方式: 'aes-128-gcm', TLS: true },
        Fingerprint: 'chrome',
        优选订阅生成: {
          local: true,
          本地IP库: { 随机IP: true, 随机数量: 16, 指定端口: -1 },
          SUB: null,
          SUBNAME: 'edgetunnel',
          SUBUpdateTime: 3,
          TOKEN: '',
        },
        订阅转换配置: {
          SUBAPI: 'https://subapi.edt-pages.workers.dev',
          SUBCONFIG: 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/main/Clash/config/ACL4SSR_Online_Mini_MultiMode.ini',
          SUBEMOJI: false, SUBLIST: false, UDP: false, XUDP: false, TLS13: false, APPEND_TYPE: false, SORT: false,
        },
        反代: {
          proxyip: proxyip || 'auto',
          SOCKS5: { 启用: null, 全局: false, 账号: '', 白名单: [] },
          路径模板: {},
        },
        TG: { 启用: false, BotToken: null, ChatID: null },
        CF: { Email: null, GlobalAPIKey: null, AccountID: null, APIToken: null, UsageAPI: null, Usage: { success: false, pages: 0, workers: 0, total: 0, max: 100000 } },
      }
    }

    // Only write when there really is a namespace: a source that keeps its
    // state in D1 (miliconfig v3.1) declares no `kvBinding`, so there is no
    // namespace to seed and `.../namespaces//values/...` would be a request to
    // a namespace with an empty id.
    if (kvNamespaceId) {
      await fetch(`${API_BASE}/accounts/${accountId}/storage/kv/namespaces/${kvNamespaceId}/values/${configKvKey}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(initialConfig, null, 2),
      }).catch(() => null)
      await appendLog(env, deployment_id, `✓ initial config written to KV (${configKvKey})`)

      await fetch(`${API_BASE}/accounts/${accountId}/storage/kv/namespaces/${kvNamespaceId}/values/${addTxtKey}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'text/plain' },
        body: proxyip || '',
      }).catch(() => null)
    }
    } // end non-zeus KV seeding

    let workerUrl: string
    /** Account workers.dev subdomain — empty when it could not be resolved. */
    let workersSubdomain = ''
    // edgetunnel: panel lives at the panel path (login page asking for the
    // password) — custom path or /admin by default.
    // Default (custom) worker: UUID is always part of the URL and bypasses
    // the login page entirely.
    // Zeus: the whole worker IS the admin panel (root URL, own login).
    const panelKey = sourceConfig.kind === 'zeus' ? '' : configFormat === 'edgetunnel' ? panelPath.slice(1) : uuid

    if (method === 'workers') {
      // ── Upload worker script ──────────────────────────────────────────
      await reportProgress(88, 'آپلود اسکریپت روی Cloudflare Edge و فعال‌سازی لینک‌ها...')
      await appendLog(env, deployment_id, 'uploading worker script...')
      const meta = {
        main_module: 'worker.js',
        compatibility_date: compatDate,
        compatibility_flags: sourceConfig.compatFlags ?? ['nodejs_compat', 'global_fetch_strictly_public'],
        bindings: sourceConfig.kind === 'github' ? [
          // Arbitrary repo: bind exactly what the user asked for, nothing more.
          ...(kvNamespaceId ? [{ type: 'kv_namespace', name: 'KV', namespace_id: kvNamespaceId }] : []),
          ...(d1DatabaseId ? [{ type: 'd1', name: 'DB', id: d1DatabaseId }] : []),
          ...(r2BucketName ? [{ type: 'r2_bucket', name: 'R2', bucket_name: r2BucketName }] : []),
          { type: 'plain_text', name: 'WORKER_NAME', text: worker_name },
          { type: 'plain_text', name: 'WIZARD_URL', text: job.origin },
        ] : sourceConfig.kind === 'zeus' ? [
          // Zeus-style full panels (zeus, nova) need D1; nova also binds the
          // KV namespace declared on its source entry (kvBinding !== '').
          { type: 'd1', name: 'DB', id: d1DatabaseId },
          ...(kvBindingName ? [{ type: 'kv_namespace', name: kvBindingName, namespace_id: kvNamespaceId }] : []),
          ...(r2BucketName ? [{ type: 'r2_bucket', name: 'R2', bucket_name: r2BucketName }] : []),
          { type: 'plain_text', name: 'CF_API_TOKEN', text: cf_token },
          { type: 'plain_text', name: 'CF_ACCOUNT_ID', text: accountId },
          { type: 'plain_text', name: 'WORKER_NAME', text: worker_name },
          { type: 'plain_text', name: 'WIZARD_URL', text: job.origin },
        ] : [
          // A D1-only source (miliconfig v3.1) declares no `kvBinding`, so it
          // must not emit a KV binding at all — an empty name/id makes
          // Cloudflare reject the whole upload with
          // "KV namespace '' is not valid".
          ...(kvBindingName && kvNamespaceId
            ? [{ type: 'kv_namespace', name: kvBindingName, namespace_id: kvNamespaceId }]
            : []),
          ...(d1DatabaseId ? [{ type: 'd1', name: 'DB', id: d1DatabaseId }] : []),
          ...(r2BucketName ? [{ type: 'r2_bucket', name: 'R2', bucket_name: r2BucketName }] : []),
          // A source without a UUID variable must not emit a binding with an
          // empty name — Cloudflare rejects the whole upload for it.
          ...(uuidEnv ? [{ type: 'plain_text', name: uuidEnv, text: uuid }] : []),
          // Self-updating panels get the deploy token in their own settings;
          // plain_text (not secret_text) on purpose: the update path reads the
          // live bindings back and re-sends them, and a secret's value is never
          // returned — re-uploading it would wipe the secret.
          ...(sourceConfig.selfUpdate
            ? [
                { type: 'plain_text', name: 'CF_API_TOKEN', text: cf_token },
                { type: 'plain_text', name: 'CF_ACCOUNT_ID', text: accountId },
                { type: 'plain_text', name: 'WORKER_NAME', text: worker_name },
              ]
            : []),
          ...(configFormat === 'edgetunnel' ? [
            { type: 'plain_text', name: 'PATH', text: panelPath },
            { type: 'plain_text', name: 'PROXYIP', text: proxyip },
            ...(admin_password ? [{ type: 'plain_text', name: 'ADMIN', text: admin_password }] : []),
          ] : sourceConfig.kind === 'nexus' || sourceConfig.kind === 'uuidpanel' ? [] : [
            { type: 'plain_text', name: 'P', text: proxyip },
          ]),
        ],
      }

      // A 404 here means this deployment creates the script instead of updating one.
      const scriptExists = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}`, { headers })
        .then((r) => r.ok)
        .catch(() => true)

      const uploadForm = () => {
        const form = new FormData()
        form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }))
        form.append('worker.js', new Blob([deployCode], { type: 'application/javascript+module' }), 'worker.js')
        return form
      }

      const uploadResp = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}`, {
        method: 'PUT', headers, body: uploadForm(),
      })
      const uploadData = (await uploadResp.json()) as { success?: boolean; errors?: Array<{ message: string }> }
      if (!uploadData.success) {
        const msg = uploadData.errors?.[0]?.message ?? 'failed to upload worker'
        await appendLog(env, deployment_id, `✗ ${msg}`)
        await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
        return
      }
      await appendLog(env, deployment_id, '✓ worker script uploaded')

      // ── Make a brand-new script actually stay live ──────────────────────
      // Cloudflare leaves a *first* creation in a state where the script serves
      // for a few seconds and then flips permanently into `error code: 1101`:
      // every later request fails before the script runs (no invocation is
      // logged) and it never recovers. Reproduced on two accounts, with three
      // sources and with both upload APIs, so it belongs to the platform's
      // first-creation path — not to the script being uploaded. Deleting the
      // just-created script and immediately re-creating it with the same bytes
      // and bindings is stable (verified live for minutes where the single
      // upload died within 10 s), and a script that did not exist a moment ago
      // costs nothing to delete. An already existing script is left untouched:
      // deleting it would drop its routes and custom domains.
      if (!scriptExists) {
        await appendLog(env, deployment_id, 're-creating the new script (Cloudflare can leave a first creation dead)…')
        await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}`, { method: 'DELETE', headers })
          .catch(() => null)
        const recreateResp = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}`, {
          method: 'PUT', headers, body: uploadForm(),
        })
        const recreateData = (await recreateResp.json().catch(() => ({}))) as { success?: boolean; errors?: Array<{ message: string }> }
        await appendLog(env, deployment_id, recreateData.success
          ? '✓ script re-created cleanly'
          : `⚠ re-create failed: ${recreateData.errors?.[0]?.message ?? 'unknown error'}`)
      }

      // ── Enable workers.dev route (with the original fallbacks) ────────
      await appendLog(env, deployment_id, 'enabling workers.dev route for script...')
      const subdomainResp = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}/subdomain`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      const subdomainResult = (await subdomainResp.json().catch(() => ({}))) as { success?: boolean; errors?: Array<{ message: string }> }
      if (subdomainResult.success) {
        await appendLog(env, deployment_id, '✓ workers.dev route enabled')
      } else {
        await appendLog(env, deployment_id, `⚠ workers.dev route: ${subdomainResult.errors?.[0]?.message ?? 'unknown error'} — trying account subdomain...`)
        const existingSub = await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, { headers })
        const existingSubData = (await existingSub.json().catch(() => ({}))) as { result?: { subdomain?: string } }
        if (!existingSubData.result?.subdomain) {
          const subName = `edge-${worker_name}`.replace(/[^a-z0-9-]/g, '').slice(0, 30)
          await fetch(`${API_BASE}/accounts/${accountId}/workers/subdomain`, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ subdomain: subName }),
          }).catch(() => null)
          await appendLog(env, deployment_id, `✓ account subdomain set: ${subName}`)
        }
        await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts/${worker_name}/subdomain`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        }).catch(() => null)
      }

      // ── Script settings: keep the workers.dev route, defer Smart Placement ─
      // `placements: [{ mode: 'smart' }]` was applied here *immediately* after
      // the first upload of a brand-new script. Cloudflare has to re-place the
      // isolate when smart placement is toggled on, and doing it in the same
      // second as creation is what made the very first requests die with
      // `error code: 1101` (the panel's own D1-backed sources — zeus — hit it
      // every deploy; KV sources like clmu never did). The fix: only confirm
      // the route now, then warm the worker up and enable smart placement
      // afterwards, once the script actually answers.
      const routeConfirmed = await patchScriptSettings(accountId, headers.Authorization, worker_name, {
        workers_dev: true,
        preview_version_id: null,
      })
      await appendLog(env, deployment_id, routeConfirmed
        ? '✓ workers.dev route confirmed (Smart Placement deferred until the worker answers)'
        : '⚠ workers.dev route confirm failed — continuing')

      // ── Enable gRPC + WebSockets on all zones of the account ───────────
      // Required for gRPC transport nodes to pass through Cloudflare without
      // conflicts. XHTTP needs no zone switch (plain HTTP/2 streams), but
      // WebSockets must be ON for ws/xhttp fallbacks. Non-fatal per zone.
      try {
        const zonesResp = await fetch(`${API_BASE}/zones?per_page=50`, { headers })
        const zonesData = (await zonesResp.json().catch(() => ({}))) as { success?: boolean; result?: Array<{ id: string; name: string }> }
        const zones = zonesData.result ?? []
        if (zones.length === 0) {
          await appendLog(env, deployment_id, 'ℹ no zones on token — workers.dev only (gRPC works natively there)')
        }
        for (const zone of zones.slice(0, 3)) {
          const grpcResp = await fetch(`${API_BASE}/zones/${zone.id}/settings/grpc`, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: 'on' }),
          }).catch(() => null)
          const wsResp = await fetch(`${API_BASE}/zones/${zone.id}/settings/websockets`, {
            method: 'PATCH',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: 'on' }),
          }).catch(() => null)
          const okGrpc = grpcResp?.ok ?? false
          const okWs = wsResp?.ok ?? false
          await appendLog(env, deployment_id, `${okGrpc && okWs ? '✓' : '⚠'} zone ${zone.name}: gRPC ${okGrpc ? 'ON' : 'skip (permission?)'} · WebSockets ${okWs ? 'ON' : 'skip'}`)
        }
      } catch {
        await appendLog(env, deployment_id, '⚠ zone settings step skipped (no zone access)')
      }

      // ── Read workers.dev subdomain & build final URL ──────────────────
      await appendLog(env, deployment_id, 'reading workers.dev subdomain...')
      workersSubdomain = await resolveWorkersSubdomain(env, accountId, headers, worker_name)
      workerUrl = workersSubdomain
        ? `https://${worker_name}.${workersSubdomain}.workers.dev`
        : `https://${worker_name}.workers.dev`
      await appendLog(env, deployment_id, `✓ worker URL: ${workerUrl}`)
      if (!workersSubdomain) {
        await appendLog(
          env,
          deployment_id,
          '⚠ زیردامنهٔ workers.dev این حساب خوانده نشد، پس آدرس بالا کامل نیست (فقط نام ورکر است). توکن را با دسترسی Workers Scripts:Read بازسازی کنید یا یک Custom Domain به این ورکر وصل کنید تا آدرس و لینک‌ها درست شوند.',
        )
      }
    } else {
      // ── Pages deployment (original flow) ──────────────────────────────
      await appendLog(env, deployment_id, 'creating Pages project...')
      await fetch(`${API_BASE}/accounts/${accountId}/pages/projects`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: worker_name, production_branch: 'main' }),
      }).catch(() => null)

      await appendLog(env, deployment_id, 'binding KV & variables to project...')
      const cfg = {
        deployment_configs: {
          production: {
            compatibility_date: compatDate,
            compatibility_flags: sourceConfig.compatFlags ?? ['nodejs_compat', 'global_fetch_strictly_public'],
            ...(kvNamespaceId ? { kv_namespaces: { [kvBindingName]: { namespace_id: kvNamespaceId } } } : {}),
            // A D1 panel needs its database on Pages too. Without this the
            // deployed project had no `DB` binding and every panel request
            // failed at runtime even though the deployment itself "succeeded".
            ...(d1DatabaseId ? { d1_databases: { DB: { id: d1DatabaseId } } } : {}),
            ...(r2BucketName ? { r2_buckets: { R2: { bucket_name: r2BucketName } } } : {}),
            // The Pages API is `env_vars`; the `environment_variables` name used
            // here before is silently ignored, so a uuid-path panel deployed to
            // Pages got a random admin path (no `u`/`UUID`) and its panel link
            // pointed nowhere. Verified against the live API.
            env_vars: configFormat === 'edgetunnel' ? {
              ...(uuidEnv ? { [uuidEnv]: { value: uuid, type: 'plain_text' } } : {}),
              PATH: { value: panelPath, type: 'plain_text' },
              PROXYIP: { value: proxyip, type: 'plain_text' },
              ...(admin_password ? { ADMIN: { value: admin_password, type: 'plain_text' } } : {}),
            } : {
              ...(uuidEnv ? { [uuidEnv]: { value: uuid, type: 'plain_text' } } : {}),
              ...(sourceConfig.kind === 'nexus' || sourceConfig.kind === 'uuidpanel' ? {} : { P: { value: proxyip, type: 'plain_text' } }),
              // Same self-update contract on Pages: bindings live in the project
              // config, so the in-panel updater sees `CF_API_TOKEN` here too.
              ...(sourceConfig.selfUpdate
                ? {
                    CF_API_TOKEN: { value: cf_token, type: 'plain_text' },
                    CF_ACCOUNT_ID: { value: accountId, type: 'plain_text' },
                    WORKER_NAME: { value: worker_name, type: 'plain_text' },
                  }
                : {}),
            },
          },
        },
      }
      await fetch(`${API_BASE}/accounts/${accountId}/pages/projects/${worker_name}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      }).catch(() => null)

      await appendLog(env, deployment_id, 'uploading _worker.js deployment...')
      const pagesDep = await uploadPagesDeployment(accountId, worker_name, deployCode, headers, compatDate, sourceConfig.compatFlags ?? ['nodejs_compat', 'global_fetch_strictly_public'])
      if (!pagesDep.ok) {
        // Pages can be unreachable for reasons a plain Workers deploy can
        // survive — the most common one being a token whose permissions cover
        // Workers but not Pages. If the user asked for Pages and nothing has
        // been retried yet, fall back to the Workers path instead of failing
        // outright; the `retried_on_pages` flag on that run disables both
        // loop-backs (its own 1101-retry and this Pages fallback) so the two
        // can never ping-pong.
        if (!job.retried_on_pages) {
          await appendLog(
            env,
            deployment_id,
            `⚠ استقرار Pages نشد (${pagesDep.error ?? 'خطای ناشناخته'}) — همان منبع را روی Workers مستقر می‌کنم…`,
          )
          await updateDeployment(env, deployment_id, 'deploying', { method: 'workers', error_message: null })
          await runDeployment(env, { ...job, method: 'workers', retried_on_pages: true })
          return
        }
        await appendLog(env, deployment_id, `✗ ${pagesDep.error ?? 'Pages deployment failed'}`)
        await updateDeployment(env, deployment_id, 'failed', { error_message: pagesDep.error ?? 'Pages deployment failed' })
        return
      }
      workerUrl = pagesDep.url ?? `https://${worker_name}.pages.dev`
      await appendLog(env, deployment_id, `✓ Pages URL: ${workerUrl}`)

      await updateDeployment(env, deployment_id, 'deployed', {
        worker_url: workerUrl,
        kv_namespace_id: kvNamespaceId,
        cf_account_id: accountId,
        worker_source: worker_source,
      })
    }

    // ── Build the links the UI shows ────────────────────────────────────
    //
    // These differ per source and were previously computed from one wrong
    // guess: a fixed `/admin` (edgetunnel) or `/<uuid>` (CFnew) for EVERY
    // worker. That produced a 403 "UUID wrong" page for edgetunnel, a 404 for
    // zeus (`/<uuid>` does not exist there) and a `/sub` link that returned
    // the origin's 404 page. Each source is now spelled out exactly.
    const base = workerUrl.replace(/\/+$/, '')
    const customPath = (custom_path ?? '').trim()
    let panelUrl: string
    let subUrl: string
    if (sourceConfig.kind === 'edgetunnel') {
      // The dashboard is fixed at /admin (redirects to /login until the admin
      // password is entered); it never moves with a custom path.
      panelUrl = `${base}/admin`
      // The sub link needs the same md5(host+uuid) token the worker checks,
      // otherwise /sub falls through to the upstream 404 page.
      let token = ''
      try { token = await edgetunnelSubToken(new URL(base).host, uuid) } catch { /* best effort */ }
      subUrl = token ? `${base}/sub?token=${token}` : `${base}/sub`
    } else if (sourceConfig.kind === 'github') {
      // An arbitrary repository: its own app decides its routes, so the worker
      // root is the only address we can promise — and there is no deploy-time
      // sub link we could build for an unknown app.
      panelUrl = base
      subUrl = ''
    } else if (sourceConfig.kind === 'zeus') {
      // Zeus-style full panels (zeus + nova): the whole worker IS a
      // self-contained admin panel. Zeus serves its dashboard at the root;
      // Nova's is fixed at /admin (first visit shows the setup wizard) and a
      // subscription only exists after a user is created inside the panel,
      // so there is no deploy-time sub link for either.
      panelUrl = worker_source === 'nova' ? `${base}/admin` : base
      subUrl = ''
    } else if (sourceConfig.kind === 'uuidpanel') {
      // miliconfigOS: the dashboard is served under the UUID handed to it via
      // `env.u` (the root and /login are only the sign-in gateway), and every
      // subscription is a per-user token issued inside the panel, so there is
      // no deploy-time sub link.
      panelUrl = `${base}/${uuid}`
      subUrl = ''
    } else {
      // CFnew-style workers (custom + NEXUS): the UUID path IS the dashboard
      // and its sub link — there is nothing at `/sub` on the root. When the
      // user set a custom path (`d`), the UUID path is disabled and the
      // dashboard/sub live under that path instead.
      const custom = customPath.replace(/^\/+|\/+$/g, '')
      if (custom) {
        panelUrl = `${base}/${custom}`
        subUrl = `${base}/${custom}/sub`
      } else {
        panelUrl = `${base}/${uuid}`
        subUrl = `${base}/${uuid}/sub`
      }
    }
    await appendLog(env, deployment_id, `✓ panel URL: ${panelUrl}`)
    if (subUrl) await appendLog(env, deployment_id, `✓ sub URL: ${subUrl}`)
    else await appendLog(env, deployment_id, 'ℹ این پنل لینک ساب آماده ندارد — داخل پنل کاربر بسازید')
    if (sourceConfig.kind === 'zeus' && /\.workers\.dev\//i.test(`${panelUrl}/`)) {
      // Ping/کانفیگ روی workers.dev بدون فیلترشکن در ایران جواب نمی‌دهد چون
      // خودِ دامنهٔ *.workers.dev سانسور شده است — نه ورکر و نه کانفیگ ایرادی
      // ندارند. راه‌حل: وصل کردن دامنهٔ شخصی (Custom Domain) به ورکر.
      await appendLog(
        env,
        deployment_id,
        '💡 پینگ/ساب روی دامنهٔ workers.dev بدون فیلترشکن کار نمی‌کند چون *.workers.dev در ایران مسدود است. از تنظیمات Cloudflare یک Custom Domain (دامنهٔ شخصی) برای این ورکر فعال کنید؛ آدرس پنل و ساب با دامنهٔ شخصی بدون فیلترشکن هم در دسترس است.',
      )
    }
    // ── Persist the result BEFORE anything optional ─────────────────────
    // The whole deployment runs as a `waitUntil` background task, and the
    // runtime only guarantees a short window after the response: a long tail
    // step (the old warm-up could poll for 190s) gets the task killed midway.
    // The row then stayed on 'deploying' forever and the user never saw the
    // link — even though the worker itself was already up. Writing status,
    // worker URL and both links here means the live log the SPA polls shows the
    // finished deployment immediately, and the self-check below can only ever
    // decorate it.
    await updateDeployment(env, deployment_id, 'deployed', {
      worker_url: workerUrl,
      panel_url: panelUrl,
      sub_url: subUrl || null,
      kv_namespace_id: kvNamespaceId,
      cf_account_id: accountId,
      route: null,
      worker_source: worker_source,
      // Persist the FINAL method: a run rescued onto the other environment has
      // to read as what actually ran, or the update-from-repo path would
      // target the wrong API.
      method,
    })

    // What the update screen needs to describe the three real update paths
    // without asking for any Cloudflare credentials: whether this deployment
    // carries the in-panel updater (`CF_API_TOKEN`), and the database identity
    // a ready-to-run deploy command has to declare.
    await patchDeploymentConfig(env, deployment_id, {
      self_update_token: sourceConfig.selfUpdate === true,
      d1_database_id: d1DatabaseId || '',
      d1_database_name: d1DatabaseId ? `${worker_name}-db` : '',
    })
    if (sourceConfig.selfUpdate) {
      await appendLog(
        env,
        deployment_id,
        '✓ in-panel update enabled — CF_API_TOKEN is in this deployment\'s own settings, so its panel can install a newer GitHub version itself.',
      )
    }

    // ── Deliver Telegram links IMMEDIATELY before optional self-check ───
    // Sending the notification right here guarantees the user gets the Worker
    // URL, Panel URL and Sub URL in Telegram within seconds — before any warm-up
    // probe can run out the background waitUntil clock.
    {
      const depOwner = await env.DB.prepare('SELECT user_id, config FROM deployments WHERE id = ?')
        .bind(deployment_id)
        .first<{ user_id: string; config: string | null }>()
        .catch(() => null)
      const notifyChat = job.notify_chat ?? safeJsonParse<{ notify_chat?: string }>(depOwner?.config ?? '{}', {})?.notify_chat ?? null
      const notifyBotToken = job.notify_bot_token ?? safeJsonParse<{ notify_bot_token?: string }>(depOwner?.config ?? '{}', {})?.notify_bot_token ?? null
      const notifyMsgId = job.notify_message_id ?? safeJsonParse<{ notify_message_id?: number }>(depOwner?.config ?? '{}', {})?.notify_message_id ?? null
      if (depOwner?.user_id || notifyChat) {
        await notifyDeployment(
          env,
          depOwner?.user_id ?? job.user_id ?? '',
          worker_name,
          'deployed',
          workerUrl,
          panelUrl,
          null,
          notifyChat,
          { subUrl: subUrl || null, botToken: notifyBotToken, messageId: notifyMsgId, sourceName: sourceConfig.label },
        ).catch(() => null)
        notifiedSuccess = true
      }
    }

    // ── Optional self-check tail (never rewrites Workers to Pages) ──────
    if (method === 'workers' && workersSubdomain) {
      const isPanel = sourceConfig.kind === 'zeus' || sourceConfig.kind === 'uuidpanel'
      await appendLog(env, deployment_id, 'warming up worker (waiting for a stable live response)…')
      const alive = await waitForWorkerLive(workerUrl, isPanel ? 4 : 3, 1500, 8_000, true)
      await patchDeploymentConfig(env, deployment_id, {
        self_check: alive ? 'passed' : 'failed',
        self_check_at: nowIso(),
      })
      if (alive) {
        await appendLog(env, deployment_id, '✓ worker is live — keeps answering without 1101')
        await recordSourceFingerprint(env, deployment_id, {
          url: fetched.url,
          etag: fetched.etag,
          bytes: fetched.code.length,
          sha256: fetched.sha256,
          commitSha: fetched.commitSha,
          blobSha: fetched.blobSha,
          checksumVerified: fetched.checksumVerified,
          markGood: true,
        })
      } else {
        await appendLog(
          env,
          deployment_id,
          'ℹ انتشار اولیهٔ DNS/Edge در حال تکمیل است — لینک‌های ورکر روی Cloudflare Workers ثبت شدند و آمادهٔ استفاده هستند.',
        )
      }
    } else if (method === 'pages') {
      // Same stability rule for Pages: the first response proves nothing.
      await appendLog(env, deployment_id, 'warming up Pages deployment (waiting for a stable live response)…')
      const alive = await waitForWorkerLive(
        workerUrl,
        job.retried_on_pages ? 3 : 4,
        2500,
        job.retried_on_pages ? 6_000 : 12_000,
        true,
      )
      await patchDeploymentConfig(env, deployment_id, {
        self_check: alive ? 'passed' : 'failed',
        self_check_at: nowIso(),
      })
      await appendLog(
        env,
        deployment_id,
        alive
          ? '✓ Pages deployment is live — keeps answering without 1101'
          : '⚠ استقرار Pages هنوز پاسخ پایدار نداد — لینک‌ها ثبت شدند؛ چند دقیقه بعد دوباره تست کنید.',
      )
    } else if (method === 'workers') {
      await appendLog(
        env,
        deployment_id,
        'ℹ self-check skipped — بدون زیردامنهٔ workers.dev آدرس ورکر قابل تست نیست (ورکر مستقر شده و لینک پنل بالاست).',
      )
    }

    await appendLog(env, deployment_id, '✓ deployment complete!')

    // Bookkeeping: token usage + activity log
    if (job.cf_token_row_id) {
      await env.DB.prepare('UPDATE cf_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), job.cf_token_row_id).run()
    }
    const depRow = await env.DB.prepare('SELECT user_id, name FROM deployments WHERE id = ?')
      .bind(deployment_id)
      .first<{ user_id: string; name: string }>()
    if (depRow) {
      await env.DB.prepare(
        'INSERT INTO activity_logs (id, user_id, action, entity_type, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(genId(), depRow.user_id, 'deployment_deployed', 'deployment', depRow.name, nowIso())
        .run()
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    await appendLog(env, deployment_id, `✗ ${msg}`)
    await updateDeployment(env, deployment_id, 'failed', { error_message: msg })
  } finally {
    if (!notifiedSuccess) {
      const row = await env.DB.prepare('SELECT user_id, name, status, worker_url, panel_url, sub_url, error_message, config FROM deployments WHERE id = ?')
        .bind(deployment_id)
        .first<{ user_id: string; name: string; status: string; worker_url: string | null; panel_url: string | null; sub_url?: string | null; error_message: string | null; config: string | null }>()
        .catch(() => null)
      if (row && (row.status === 'deployed' || row.status === 'failed')) {
        const parsedCfg = safeJsonParse<{ notify_chat?: string; notify_bot_token?: string; notify_message_id?: number }>(row.config ?? '{}', {})
        const notifyChat = job.notify_chat ?? parsedCfg?.notify_chat ?? null
        const notifyBotToken = job.notify_bot_token ?? parsedCfg?.notify_bot_token ?? null
        const notifyMsgId = job.notify_message_id ?? parsedCfg?.notify_message_id ?? null
        await notifyDeployment(
          env,
          row.user_id,
          row.name,
          row.status as 'deployed' | 'failed',
          row.worker_url,
          row.panel_url,
          row.error_message,
          notifyChat,
          { subUrl: row.sub_url ?? null, botToken: notifyBotToken, messageId: notifyMsgId },
        ).catch(() => null)
      }
    }
  }
}
