/**
 * «استقرار از هر مخزن گیت‌هاب» — parsing and validation of the URL a user
 * pastes into the deploy wizard's GitHub mode.
 *
 * The user may paste any of the shapes GitHub itself hands out:
 *
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<branch>
 *   https://github.com/owner/repo/tree/<branch>/<dir>
 *   https://github.com/owner/repo/blob/<branch>/<path/to/file.js>
 *   https://raw.githubusercontent.com/owner/repo/<branch>/<path/to/file.js>
 *   owner/repo                              (shorthand)
 *
 * Only `github.com` (and its raw host) is accepted. Anything else — a mirror, a
 * gist, a gitlab URL — is rejected with a readable message *before* a deploy row
 * is created, because the deploy engine can only verify and pin revisions for
 * GitHub files.
 *
 * When the URL names a repository (or a directory) instead of a file, the worker
 * entry point is resolved with {@link GITHUB_ENTRY_CANDIDATES}, preferring the
 * `main` field of the repo's own wrangler config — that is the file Cloudflare
 * itself would build. The network part of that lookup lives in
 * `worker/deploy.ts`; everything here is pure so the wizard and the backend
 * agree and both can be tested without a network.
 */

export interface GithubRepoRef {
  owner: string
  repo: string
  /** Branch/tag/commit from the URL, or `''` when the URL did not name one. */
  branch: string
  /** Repo-relative path of the entry file, or `''` when it still has to be resolved. */
  path: string
}

export type GithubSourceKind = 'repo' | 'blob' | 'raw'

export type GithubSourceUrlResult =
  | { ok: true; ref: GithubRepoRef; source: GithubSourceKind; webUrl: string }
  | { ok: false; error: string }

/**
 * Files tried (in order) when the URL points at a repository or a directory.
 *
 * `_worker.js`/`worker.js` are what Cloudflare's own docs use for Pages/Workers
 * single-file deploys, so they are first; the `src/` and `dist/` variants cover
 * the usual "built worker committed to the repo" layouts. A repo whose wrangler
 * config names its entry gets that file instead — this list is the fallback.
 */
export const GITHUB_ENTRY_CANDIDATES: string[] = [
  '_worker.js',
  'worker.js',
  'index.js',
  'src/_worker.js',
  'src/worker.js',
  'src/index.js',
  'dist/_worker.js',
  'dist/worker.js',
  'dist/index.js',
  'functions/_worker.js',
]

/** Wrangler config files read to find the repo's declared entry point. */
export const WRANGLER_CONFIG_FILES = ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json'] as const

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]+$/

/** Strip trailing slashes/`.git` and split `owner/repo` into its two halves. */
function splitOwnerRepo(input: string): { owner: string; repo: string } | null {
  const parts = input.split('/').filter(Boolean)
  if (parts.length !== 2) return null
  const [owner, rawRepo] = parts
  const repo = rawRepo.replace(/\.git$/i, '')
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null
  return { owner, repo }
}

/**
 * Parse the URL a user pasted into a `GithubRepoRef`.
 *
 * `ok: false` carries a Persian message ready to be shown in the wizard, so the
 * user learns what was wrong with the address instead of getting a failed
 * deployment with a network error in it.
 */
export function parseGithubSourceUrl(input: string): GithubSourceUrlResult {
  const raw = (input ?? '').trim()
  if (!raw) return { ok: false, error: 'آدرس مخزن گیت‌هاب را وارد کنید' }

  // Accept `owner/repo`, `github.com/owner/repo` and full URLs alike by giving
  // the value a scheme — and, for the bare shorthand, the GitHub host, so
  // `owner/repo` cannot be mistaken for a hostname.
  const trimmed = raw.replace(/^\/+/, '')
  const hostLike = /^(?:www\.)?github\.com\//i.test(trimmed) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\//i.test(trimmed)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${hostLike ? trimmed : `github.com/${trimmed}`}`

  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, error: 'آدرس وارد‌شده یک URL معتبر نیست' }
  }

  const host = url.hostname.toLowerCase()
  const segments = url.pathname.split('/').filter(Boolean)

  // ── raw.githubusercontent.com/<owner>/<repo>/<branch>/<path…> ──────────
  if (host === 'raw.githubusercontent.com') {
    if (segments.length < 3) {
      return { ok: false, error: 'آدرس raw باید شامل مالک، مخزن، شاخه و نام فایل باشد' }
    }
    const [owner, rawRepo, branch, ...rest] = segments
    const repo = rawRepo.replace(/\.git$/i, '')
    if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) {
      return { ok: false, error: 'نام مالک یا مخزن در آدرس درست نیست' }
    }
    if (!rest.length) return { ok: false, error: 'آدرس raw باید نام فایل ورکر را هم داشته باشد' }
    const ref: GithubRepoRef = { owner, repo, branch: decodeURIComponent(branch), path: rest.map(decodeURIComponent).join('/') }
    return { ok: true, ref, source: 'raw', webUrl: `https://github.com/${owner}/${repo}` }
  }

  if (host !== 'github.com' && host !== 'www.github.com') {
    return {
      ok: false,
      error: 'فقط آدرس‌های github.com پشتیبانی می‌شوند (بررسی چک‌سام و نسخه‌بندی فقط برای گیت‌هاب انجام می‌شود)',
    }
  }

  if (segments.length < 2) {
    return { ok: false, error: 'آدرس باید به شکل https://github.com/<owner>/<repo> باشد' }
  }

  // `/owner/repo` first, then drop the `blob`/`tree`/`raw` marker GitHub puts
  // between the repo and the branch.
  const head = segments[0]
  const repoPart = segments[1]
  const marker = segments[2]
  const knownMarkers = ['blob', 'tree', 'raw', 'edit', 'commits', 'releases', 'issues', 'pull', 'actions', 'wiki', 'settings']
  if (knownMarkers.includes(marker) && marker !== 'blob' && marker !== 'tree' && marker !== 'raw') {
    // A URL that points at issues/releases/… is not a source file link.
    return { ok: false, error: 'این آدرس به کد مخزن اشاره نمی‌کند — آدرس خود مخزن یا فایل ورکر را بدهید' }
  }

  const split = splitOwnerRepo(`${head}/${repoPart}`)
  if (!split) return { ok: false, error: 'نام مالک یا مخزن در آدرس درست نیست' }
  const { owner, repo } = split

  if (!marker) {
    return { ok: true, ref: { owner, repo, branch: '', path: '' }, source: 'repo', webUrl: `https://github.com/${owner}/${repo}` }
  }

  const branch = decodeURIComponent(segments[3] ?? '')
  const restPath = segments.slice(4).map(decodeURIComponent).join('/')
  if (!branch) {
    return { ok: false, error: 'شاخه (branch) در آدرس پیدا نشد' }
  }

  if (marker === 'tree') {
    // A directory: the entry file is still resolved inside it.
    return {
      ok: true,
      ref: { owner, repo, branch, path: restPath },
      source: 'repo',
      webUrl: `https://github.com/${owner}/${repo}`,
    }
  }

  if (!restPath) return { ok: false, error: 'آدرس فایل ناقص است — مسیر فایل را کامل کنید' }
  return {
    ok: true,
    ref: { owner, repo, branch, path: restPath },
    source: 'blob',
    webUrl: `https://github.com/${owner}/${repo}`,
  }
}

/** Raw URL for one file of a repository (the host the deploy engine fetches). */
export function rawGithubFileUrl(ref: GithubRepoRef, path: string, branch = ref.branch): string {
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch}/${path.replace(/^\/+/, '')}`
}

/** `owner/repo` — what the deploy log and the UI label these sources with. */
export function githubRepoLabel(ref: GithubRepoRef): string {
  return `${ref.owner}/${ref.repo}`
}

/**
 * True when the URL already points at a single file, i.e. no entry-point search
 * is needed. Used by the wizard to tell the user whether the file will be picked
 * automatically.
 */
export function githubUrlNamesFile(result: GithubSourceUrlResult): boolean {
  return result.ok && result.source !== 'repo' && !!result.ref.path && /\.(m?js|ts|tsx|jsx)$/i.test(result.ref.path)
}

/** A path inside the repo that is a plausible worker entry (JS/TS module). */
export function isWorkerEntryPath(path: string): boolean {
  return /\.(m?js|ts|tsx|jsx)$/i.test(path)
}
