/**
 * Integrity verification for a worker source downloaded from an upstream repo.
 *
 * The panel deploys a *file* it fetched over the network, so a download that
 * stopped halfway is not a cosmetic problem: a truncated ES module does not
 * parse, and Cloudflare answers every request for it with `error code: 1101`
 * (Worker threw exception) — a state the deployment can never leave on its own,
 * because the code that would run the updater is the code that is broken, and
 * the next update of every *other* panel of the same source would ship the same
 * half file.
 *
 * So nothing is uploaded before it passes the checks below:
 *
 *   1. `size` — the old, cheap screen (a file smaller than
 *      {@link MIN_WORKER_SOURCE_BYTES} is a download that never happened);
 *   2. `marker` — the file has to look like a module worker at all, so an HTML
 *      error page served with status 200 can never be deployed as code;
 *   3. `checksum` — the bytes are matched against the **officially published
 *      checksum** of that exact revision: GitHub's blob SHA-1 for the file,
 *      plus its byte size, read from the repository API. A partial download
 *      cannot match it, a different revision cannot match it, and a repo that
 *      moved cannot produce it — this is the check that actually closes the
 *      hole the size screen left open;
 *   4. `shape` — a completeness pass (balanced braces, a finished last
 *      statement) used when GitHub cannot vouch for the bytes: the copies
 *      bundled with this panel (`/repo/worker-source.js`) and any fallback
 *      mirror. Those are reported as *unverified* instead of silently trusted.
 *
 * The verified checksum is what makes a rollback possible: the deployment
 * stores the upstream commit it deployed, and coming back to that revision is
 * just re-reading the same pinned URL and checking the same number.
 */

/** A file smaller than this can only be a failed download (or an error page). */
export const MIN_WORKER_SOURCE_BYTES = 1024

/** The parts of a `raw.githubusercontent.com` URL we need to re-read the file. */
export interface RawGithubRef {
  owner: string
  repo: string
  /** Branch, tag or commit the file was read from. */
  branch: string
  /** Repo-relative path (`_worker.js`, `public/repo/nexus.js`, …). */
  path: string
}

/**
 * Parse a raw GitHub URL into owner/repo/branch/path.
 *
 * Returns `null` for anything else — the bundled `/repo/*.js` copies, a mirror
 * on another host, a malformed URL. A `null` ref simply means "GitHub cannot
 * vouch for this download", never a failure.
 */
export function parseRawGithubUrl(url: string): RawGithubRef | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'raw.githubusercontent.com') return null
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length < 4) return null
  const [owner, repo, ...rest] = parts
  // The path is everything after the branch; a file URL always has at least one
  // segment left for the file itself.
  const branch = rest.shift()
  if (!branch || !rest.length) return null
  return { owner, repo, branch, path: rest.join('/') }
}

/** `https://raw.githubusercontent.com/…/<commit>/<path>` — a pinned revision. */
export function commitPinnedRawUrl(ref: RawGithubRef, commit: string): string {
  return `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${commit}/${ref.path}`
}

/** Hex-encode bytes (lowercase, the way git prints object ids). */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** SHA-256 of the text — the fingerprint we store on the deployment. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toHex(digest)
}

/**
 * git's object id for a blob: `sha1("blob <bytes>\0" + content)`.
 *
 * This is exactly what GitHub reports as the file's `sha`, so it is the number
 * a published checksum can be compared against without trusting the response
 * body's length or encoding.
 */
export async function gitBlobSha1(text: string): Promise<string> {
  const body = new TextEncoder().encode(text)
  const header = new TextEncoder().encode(`blob ${body.length}\0`)
  const joined = new Uint8Array(header.length + body.length)
  joined.set(header, 0)
  joined.set(body, header.length)
  const digest = await crypto.subtle.digest('SHA-1', joined)
  return toHex(digest)
}

/** What the repository says about one file at one revision. */
export interface GithubFileMeta {
  /** Commit the file was read at — the revision a rollback comes back to. */
  commitSha: string
  /** git blob SHA-1 of the file contents (the published checksum). */
  blobSha: string
  /** File size in bytes. */
  size: number
}

/**
 * Read the published checksum of one file from the repository API.
 *
 * `?ref=<branch|commit>` pins the answer to a revision, so the same call serves
 * the "what is upstream now" check and the "give me back the revision I know
 * was good" rollback. Network and rate-limit problems return `null`: an
 * unreachable API must degrade to the local checks, never block a deployment.
 */
export async function fetchGithubFileMeta(ref: RawGithubRef, revision?: string): Promise<GithubFileMeta | null> {
  const target = revision ?? ref.branch
  const api =
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/${ref.path}` +
    `?ref=${encodeURIComponent(target)}`
  try {
    const resp = await fetch(api, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub rejects API requests without a User-Agent.
        'User-Agent': 'miliconfig-pro',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!resp.ok) return null
    const data = (await resp.json().catch(() => null)) as
      | { sha?: string; size?: number; type?: string }
      | null
    // A directory answer (or a repo we cannot read) is not a checksum.
    if (!data?.sha || data.type === 'dir' || typeof data.size !== 'number') return null
    return { commitSha: target, blobSha: data.sha, size: data.size }
  } catch {
    return null
  }
}

/** The commit a branch points at right now (used to record what we deployed). */
export async function fetchGithubHeadCommit(ref: RawGithubRef): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(ref.branch)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'miliconfig-pro' },
        signal: AbortSignal.timeout(8000),
      },
    )
    if (!resp.ok) return null
    const data = (await resp.json().catch(() => null)) as { sha?: string } | null
    return data?.sha ?? null
  } catch {
    return null
  }
}

/**
 * Does this look like a whole worker file rather than the first half of one?
 *
 * Only used when GitHub could not vouch for the bytes (the bundled fallback
 * copy, a mirror). Deliberately forgiving — a false rejection would block a
 * deployment — but a bare error page or a file that stops mid-statement is
 * caught.
 */
export function sourceLooksComplete(code: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = code.trim()
  if (trimmed.length < MIN_WORKER_SOURCE_BYTES) {
    return { ok: false, reason: `فقط ${trimmed.length} بایت` }
  }
  const markers = ['export default', 'addEventListener', 'fetch(']
  if (!markers.some((marker) => trimmed.includes(marker))) {
    return { ok: false, reason: 'نقطهٔ ورود ورکر پیدا نشد (فایل JS ماژول نیست)' }
  }
  const opens = (trimmed.match(/\{/g) ?? []).length
  const closes = (trimmed.match(/\}/g) ?? []).length
  if (opens !== closes) {
    return { ok: false, reason: `آکولادهای نامتوازن (${opens} باز و ${closes} بسته)` }
  }
  const last = trimmed.slice(-1)
  const closedComment = trimmed.endsWith('*/') || /\/\/[^\n]*$/.test(trimmed)
  const ended = ['}', ';', ')', '`', "'", '"', '>'].includes(last)
  if (!ended && !closedComment) {
    return { ok: false, reason: `فایل وسط یک دستور قطع شده است (به «${last}» ختم می‌شود)` }
  }
  return { ok: true }
}

export interface VerifySourceOptions {
  /**
   * Repo this file came from, when the URL is a raw GitHub one. `null` means
   * the download cannot be checksum-verified — the caller is told so.
   */
  ref?: RawGithubRef | null
  /**
   * Compare against this revision instead of the branch head (rollback path).
   */
  revision?: string
  /** Skip the network entirely (offline checks only). */
  skipChecksum?: boolean
  /**
   * Identity marker of the project these bytes are supposed to belong to.
   *
   * A checksum proves the file was downloaded whole, not that it is the *right
   * project*: an id this build does not know used to be silently read as
   * edgetunnel, so a "Nova" deployment shipped cmliu's worker with a perfectly
   * valid checksum. Each named source declares a short string its own upstream
   * always contains, and a file that lacks it is rejected before it is
   * uploaded — the wrong project can no longer be deployed under a source's
   * name, no matter what the mapping, the URL or the branch says.
   */
  expectMarker?: string
}

export interface VerifySourceResult {
  /** False means: do not deploy these bytes. */
  ok: boolean
  /** Why they were rejected (Persian, ready for the deploy log) — failure only. */
  reason?: string
  /** Always present: the fingerprint recorded on the deployment. */
  sha256: string
  bytes: number
  /** Revision the checksum was proven against (null when unverified). */
  commitSha: string | null
  blobSha: string | null
  /** True only when GitHub's published blob hash matched these exact bytes. */
  checksumVerified: boolean
  /** Non-fatal remark for the log (a degradation, not a failure). */
  note?: string
}

/**
 * Verify one downloaded file before it is ever uploaded.
 *
 * Failure is a hard stop: the caller must not deploy these bytes and must not
 * record them as the deployment's revision.
 */
export async function verifyWorkerSource(
  code: string,
  options: VerifySourceOptions = {},
): Promise<VerifySourceResult> {
  const sha256 = await sha256Hex(code)
  const bytes = new TextEncoder().encode(code).length
  const base: VerifySourceResult = {
    ok: false,
    sha256,
    bytes,
    commitSha: null,
    blobSha: null,
    checksumVerified: false,
  }

  // ── 1. size ─────────────────────────────────────────────────────────────
  if (bytes < MIN_WORKER_SOURCE_BYTES) {
    return { ...base, reason: `فایل دانلودشده ناقص است (${bytes} بایت — کمتر از حداقل مجاز)` }
  }

  // ── 2. marker ───────────────────────────────────────────────────────────
  const markers = ['export default', 'addEventListener', 'fetch(']
  if (!markers.some((marker) => code.includes(marker))) {
    return { ...base, reason: 'فایل دانلودشده کد ورکر نیست (نقطهٔ ورود پیدا نشد)' }
  }

  // ── 2b. source identity ─────────────────────────────────────────────
  // The bytes must belong to the project this source *claims* to be. Checked
  // before the checksum, so a mis-pointed URL says so plainly instead of being
  // "verified" against the wrong repository.
  if (options.expectMarker && !code.includes(options.expectMarker)) {
    return {
      ...base,
      reason:
        `فایل دانلودشده متعلق به این منبع نیست — نشانهٔ «${options.expectMarker}» در آن پیدا نشد؛ ` +
        'استقرار متوقف شد تا ورکر شما با پنل اشتباه جایگزین نشود.',
    }
  }

  // ── 3. published checksum ───────────────────────────────────────────────
  const ref = options.ref ?? null
  if (ref && !options.skipChecksum) {
    const meta = await fetchGithubFileMeta(ref, options.revision)
    if (!meta) {
      const shape = sourceLooksComplete(code)
      return {
        ...base,
        ok: shape.ok,
        reason: shape.ok ? undefined : `چک‌سام در دسترس نبود و ${shape.reason}`,
        note: 'چک‌سام رسمی از مخزن خوانده نشد — فقط بررسی محلی انجام شد',
      }
    }
    const blobSha = await gitBlobSha1(code)
    if (blobSha !== meta.blobSha || bytes !== meta.size) {
      return {
        ...base,
        reason:
          `چک‌سام فایل دانلودشده با نسخهٔ منتشرشده مطابقت ندارد ` +
          `(${bytes}/${meta.size} بایت) — استقرار متوقف شد تا ورکر با فایل ناقص خراب نشود`,
        blobSha: meta.blobSha,
      }
    }
    return {
      ok: true,
      sha256,
      bytes,
      commitSha: meta.commitSha,
      blobSha: meta.blobSha,
      checksumVerified: true,
    }
  }

  // ── 4. local completeness (bundled copies / mirrors) ────────────────────
  const shape = sourceLooksComplete(code)
  if (!shape.ok) {
    return { ...base, reason: `فایل دانلودشده کامل نیست (${shape.reason})` }
  }
  return {
    ...base,
    ok: true,
    // Proven complete locally, but not against a published checksum.
    commitSha: options.revision ?? null,
    note: 'بررسی محلی انجام شد (این نسخه چک‌سام رسمی منتشرشده ندارد)',
  }
}
