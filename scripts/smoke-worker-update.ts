/**
 * Engine-level smoke test for the "به‌روزرسانی از مخزن" updater (worker/update.ts)
 * with the GitHub, Cloudflare and worker-probe endpoints faked via a patched
 * global fetch. It pins the behaviour that keeps a panel from shipping a broken
 * worker — the failure that leaves a deployment stuck on `error code: 1101`:
 *
 *   1. an unchanged upstream uploads nothing (the ETag shortcut);
 *   2. a changed upstream is only deployed after its **published checksum**
 *      matches, and the verified revision + fingerprint are stored on the row;
 *   3. a torn download (checksum mismatch) is refused and **nothing is
 *      uploaded** — the live worker is untouched;
 *   4. when the self-check fails, the same verified source is retried once and
 *      a success is reported honestly (`self_check: passed`);
 *   5. when it still fails, the last known-good revision is fetched at its
 *      pinned commit, re-verified, deployed, and the run is reported as failed
 *      with `rolled_back: true` — never as a successful update.
 *
 * The probe retry delay is virtualised (`setTimeout` under 8s fires
 * immediately) so the test exercises the real control flow without spending
 * the real 18 seconds per failing probe; the abort timer stays real.
 */
import { runDeploymentUpdate } from '../worker/update'
import { gitBlobSha1 } from '../worker/source-verify'
import type { Env } from '../worker/env'

type Row = Record<string, any>

const realFetch = globalThis.fetch
const realSetTimeout = globalThis.setTimeout
// Zero-delay the retry sleeps only: the 8 s probe abort must stay real.
// @ts-expect-error test shim
globalThis.setTimeout = (fn: (...args: any[]) => void, ms?: number, ...rest: any[]) =>
  (ms ?? 0) >= 8000 ? realSetTimeout(fn, 10_000, ...rest) : realSetTimeout(fn, 0, ...rest)

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── fake D1 ──────────────────────────────────────────────────────────────────
type Tables = Record<string, Map<string, Row>>

function makeDb(seed: Record<string, Row[]>): { DB: any; tables: Tables } {
  const tables: Tables = {}
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = new Map(rows.map((r) => [String(r.id), { ...r }]))
  }
  const tableOf = (name: string): Map<string, Row> => (tables[name] ??= new Map())

  function whereMatches(row: Row, where: string, binds: unknown[], consumed: number): boolean {
    let i = consumed
    for (const clause of where.split(/\s+AND\s+/i)) {
      const m = /^(\w+)\s*=\s*(.+?)$/.exec(clause.trim())
      if (!m) continue
      const raw = m[2].trim()
      const value = raw === '?' ? binds[i++] : raw.replace(/^'|'$/g, '')
      if (String(row[m[1]]) !== String(value)) return false
    }
    return true
  }

  function exec(sql: string, binds: unknown[]): Row | null {
    const s = sql.replace(/\s+/g, ' ').trim()
    const insert = /^INSERT INTO (\w+) \(([^)]*)\)/i.exec(s)
    if (insert) {
      const cols = insert[2].split(',').map((c) => c.trim())
      const row: Row = {}
      cols.forEach((c, i) => (row[c] = binds[i]))
      tableOf(insert[1]).set(String(row.id ?? binds[0]), row)
      return row
    }
    const update = /^UPDATE (\w+) SET ([\s\S]*?) WHERE ([\s\S]*?)$/i.exec(s)
    if (update) {
      const assignments = update[2].split(',').map((a) => a.trim())
      let i = 0
      const patch: Row = {}
      for (const assignment of assignments) {
        const [col, val] = assignment.split('=').map((p) => p.trim())
        patch[col] = val === '?' ? binds[i++] : /^\d+$/.test(val) ? Number(val) : val
      }
      for (const row of tableOf(update[1]).values()) {
        if (whereMatches(row, update[3], binds, i)) Object.assign(row, patch)
      }
      return null
    }
    const select = /^SELECT ([\s\S]*?) FROM (\w+)(?: WHERE ([\s\S]*?))?(?: LIMIT \d+)?$/i.exec(s)
    if (select) {
      const cols = select[1].split(',').map((c) => c.trim().split(/\s+AS\s+/i)[0])
      for (const row of tableOf(select[2]).values()) {
        if (select[3] && !whereMatches(row, select[3], binds, 0)) continue
        const out: Row = {}
        for (const col of cols) out[col] = row[col] ?? null
        return out
      }
      return null
    }
    return null
  }

  return {
    tables,
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          first: async () => exec(sql, binds),
          run: async () => {
            exec(sql, binds)
            return { meta: { changes: 1 } }
          },
          all: async () => ({ results: [] }),
        }),
      }),
    },
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────
function makeSource(marker: string, helpers = 60): string {
  const lines = [`// ${marker}`, "const NAME = 'fixture'", 'export default {', '  async fetch(request) {']
  lines.push("    return new Response(NAME + new URL(request.url).pathname, { headers: { 'content-type': 'text/plain' } })")
  lines.push('  },', '}')
  for (let i = 0; i < helpers; i++) lines.push(`function helper${i}(value) { return value + ${i} * ${helpers} }`)
  return lines.join('\n') + '\n'
}

// The fixtures carry ZEUS's own identity marker: the update path verifies the
// bytes against the source's marker as well as the checksum, so the fake
// upstream has to look like the real one.
const NEW = makeSource('GLOBAL_TRAFFIC_CACHE — upstream revision new')
const OLD = makeSource('GLOBAL_TRAFFIC_CACHE — upstream revision old (last known good)')
const NEW_COMMIT = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111'
const OLD_COMMIT = 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222'
const RAW = 'https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/main/Source.js'
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

const CF = 'https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/zeus-test'

interface Harness {
  uploads: string[]
  probeAlive: boolean
  probeCalls: number
  served: 'new' | 'torn' | 'old'
}

/** Install a fetch stub: GitHub (commits/contents), Cloudflare, live worker. */
function installFetch(h: Harness): void {
  // @ts-expect-error test shim
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    // GitHub: the branch head commit (any repo — the check is per repo, not the
    // source id, because a GitHub deployment names its own repository).
    if (/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\//.test(url)) {
      return new Response(JSON.stringify({ sha: NEW_COMMIT }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // GitHub: the published checksum of a revision.
    if (/api\.github\.com\/repos\/panel-zeus\/Z-E-U-S\/contents\//.test(url)) {
      const ref = new URL(url).searchParams.get('ref') ?? 'main'
      const body = ref === OLD_COMMIT ? OLD : NEW
      return new Response(
        JSON.stringify({ sha: await gitBlobSha1(body), size: bytesOf(body), type: 'file' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // GitHub: repository metadata (default branch) — the GitHub source mode.
    if (/api\.github\.com\/repos\/[^/]+\/[^/?]+$/.test(url)) {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // GitHub: a repository with no wrangler config, whose single worker file is
    // the entry (the shortest form of "deploy my repo").
    if (/api\.github\.com\/repos\/acme\/worker-demo\/contents\//.test(url)) {
      if (/wrangler\.(toml|jsonc|json)/.test(url)) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      }
      return new Response(
        JSON.stringify({ sha: await gitBlobSha1(NEW), size: bytesOf(NEW), type: 'file' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // GitHub: the raw file (branch or pinned commit).
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      const text = url.includes(OLD_COMMIT) ? OLD : h.served === 'torn' ? NEW.slice(0, Math.floor(NEW.length * 0.5)) : NEW
      return new Response(text, { status: 200, headers: { 'Content-Type': 'text/plain', etag: '"etag-new"' } })
    }
    // Cloudflare: read the live bindings.
    if (url === `${CF}/settings` && method !== 'PUT') {
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            main_module: 'worker.js',
            compatibility_date: '2026-07-10',
            compatibility_flags: ['nodejs_compat'],
            bindings: [{ type: 'd1', name: 'DB', id: 'db-1' }],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // Cloudflare: upload a script revision.
    if (url === CF && method === 'PUT') {
      h.uploads.push(url)
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    // The deployed worker itself.
    if (url.startsWith('https://zeus-test.example.workers.dev')) {
      h.probeCalls++
      return new Response(h.probeAlive ? 'ok' : 'error code: 1101\nWorker threw exception', {
        status: h.probeAlive ? 200 : 500,
      })
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }
}

function makeEnv(
  totalUploads: () => number,
  config: Record<string, unknown>,
  /** Source id on the row — the update path looks it up exactly. */
  workerSource = 'zeus',
): { env: Env; row: () => Row } {
  const { DB, tables } = makeDb({
    deployments: [
      {
        id: 'dep-1',
        user_id: 'u1',
        name: 'zeus-test',
        uuid: '11111111-2222-3333-4444-555555555555',
        status: 'deployed',
        method: 'workers',
        worker_source: workerSource,
        config: JSON.stringify(config),
        worker_url: 'https://zeus-test.example.workers.dev',
        cf_account_id: 'acct',
        cf_token_row_id: 'tok-1',
      },
    ],
    cf_tokens: [{ id: 'tok-1', user_id: 'u1', token: 'cf-token' }],
    activity_logs: [],
  })
  void totalUploads
  return {
    env: { DB, ASSETS: {} as any } as unknown as Env,
    row: () => tables.deployments.get('dep-1')!,
  }
}

async function scenario(
  name: string,
  opts: {
    config: Record<string, unknown>
    served?: 'new' | 'torn' | 'old'
    /** Flip `probeAlive` after this many uploads (default: never). */
    aliveAfterUpload?: number
    /**
     * Re-deploy even when upstream did not change — `/recover`. Off by default:
     * the plain "↻ update" path is what the ETag shortcut belongs to.
     */
    force?: boolean
    /** Source id stored on the row (default `zeus`). */
    workerSource?: string
  },
  assert: (out: Awaited<ReturnType<typeof runDeploymentUpdate>>, h: Harness, row: Row) => void,
): Promise<void> {
  console.log(`\n── ${name} ──`)
  const h: Harness = { uploads: [], probeAlive: !!opts.aliveAfterUpload && opts.aliveAfterUpload <= 0, probeCalls: 0, served: opts.served ?? 'new' }
  installFetch(h)
  const { env, row } = makeEnv(() => h.uploads.length, opts.config, opts.workerSource)

  // The rollback fetch (pinned commit) means the panel is healthy again; the
  // second identical upload means the retry worked.
  const original = globalThis.fetch
  // @ts-expect-error wrap to observe progress
  globalThis.fetch = async (input: any, init?: any) => {
    const resp = await original(input, init)
    if (String(input).includes(OLD_COMMIT) && String(input).includes('raw.githubusercontent.com')) h.probeAlive = true
    if (opts.aliveAfterUpload && h.uploads.length >= opts.aliveAfterUpload) h.probeAlive = true
    return resp
  }

  const out = await runDeploymentUpdate(env, 'u1', 'dep-1', opts.force
    ? { force: true, reason: 'recover' }
    : { reason: 'manual' })
  assert(out, h, row())
}

async function main(): Promise<void> {
  // 1. Unchanged upstream (ETag matches what we stored) uploads nothing.
  await scenario(
    'unchanged upstream',
    { config: { source_etag: '"etag-new"' } },
    (out, h) => {
      check('reports up-to-date', out.ok && out.up_to_date)
      check('uploads nothing', h.uploads.length === 0, `${h.uploads.length} uploads`)
      check('never probes the worker', h.probeCalls === 0)
    },
  )

  // 2. A verified, newer revision is deployed and remembered.
  await scenario(
    'changed upstream, checksum verified, worker alive',
    { config: { source_etag: '"etag-old"' }, aliveAfterUpload: 1, force: true },
    (out, h, row) => {
      check('reports a successful update', out.ok && out.updated && !out.up_to_date)
      check('checksum considered verified', out.verified)
      check('self-check passed', out.self_check === 'passed')
      check('exactly one upload', h.uploads.length === 1, `${h.uploads.length}`)
      const cfg = JSON.parse(String(row.config))
      check('verified revision stored for rollback', cfg.source_last_good_commit === NEW_COMMIT, String(cfg.source_last_good_commit))
      check('checksum fingerprint stored', typeof cfg.source_sha256 === 'string' && cfg.source_sha256.length === 64)
      check('etag refreshed', cfg.source_etag === '"etag-new"')
    },
  )

  // 3. A torn download is refused — nothing reaches Cloudflare.
  await scenario(
    'torn download (checksum mismatch)',
    { config: { source_etag: '"etag-old"' }, served: 'torn', force: true },
    (out, h, row) => {
      check('the run fails', !out.ok)
      check('the reason names the checksum', (out.error ?? '').includes('چک‌سام'), (out.error ?? '').slice(0, 80))
      check('nothing was uploaded over the live worker', h.uploads.length === 0, `${h.uploads.length} uploads`)
      check('the stored revision is untouched', JSON.parse(String(row.config)).source_etag === '"etag-old"')
    },
  )

  // 4. Self-check fails once, the retry saves the day.
  await scenario(
    'self-check fails, retry succeeds',
    { config: { source_etag: '"etag-old"' }, aliveAfterUpload: 2, force: true },
    (out, h) => {
      check('reports success after the retry', out.ok && out.updated)
      check('two uploads (original + retry)', h.uploads.length === 2, `${h.uploads.length}`)
      check('self-check passed', out.self_check === 'passed')
    },
  )

  // 5. Still failing: roll back to the last revision that was seen running.
  await scenario(
    'self-check fails twice → rollback to the pinned good revision',
    {
      config: {
        source_etag: '"etag-old"',
        source_last_good_commit: OLD_COMMIT,
        source_last_good_url: RAW,
        source_last_good_sha256: await gitBlobSha1(OLD),
      },
      force: true,
    },
    (out, h, row) => {
      check('the run is reported as failed, not as an update', !out.ok)
      check('and says it rolled back', out.rolled_back)
      check('self-check recorded as failed', out.self_check === 'failed')
      check('the worker answers again after the rollback', h.probeAlive)
      check('uploads: new, retry, then the pinned good revision', h.uploads.length === 3, `${h.uploads.length}`)
      check(
        'the failed update is recorded on the row (so it is not propagated)',
        JSON.parse(String(row.config)).self_check === 'failed',
      )
      check('the good revision is still the stored rollback target', JSON.parse(String(row.config)).source_last_good_commit === OLD_COMMIT)
    },
  )

  // 6. An unknown source id is refused — the update path must never fall back
  // to edgetunnel (that fallback is how a "Nova" Worker came to run another
  // project's code and could never update itself out of it).
  await scenario(
    'unknown worker_source → refused, nothing uploaded',
    { config: { source_etag: '"etag-old"' }, workerSource: 'nova-legacy', force: true },
    (out, h, row) => {
      check('the run fails', !out.ok)
      check('the reason names the unknown id', (out.error ?? '').includes('nova-legacy'), (out.error ?? '').slice(0, 80))
      check('nothing was uploaded over the live worker', h.uploads.length === 0, `${h.uploads.length} uploads`)
      check('the stored config is untouched', JSON.parse(String(row.config)).source_etag === '"etag-old"')
    },
  )

  // 7. A GitHub deployment re-resolves the repository the user pasted.
  await scenario(
    'GitHub deployment → re-resolved from its own repo',
    { config: { repo_url: 'https://github.com/acme/worker-demo' }, workerSource: 'github', aliveAfterUpload: 1, force: true },
    (out, h, row) => {
      check('the update succeeded', out.ok && out.updated, out.message)
      check('it read the repo it was created from', out.source_url.includes('acme/worker-demo'), out.source_url)
      check('one upload', h.uploads.length === 1, `${h.uploads.length}`)
      check('the repo URL stays on the record', JSON.parse(String(row.config)).repo_url === 'https://github.com/acme/worker-demo')
      check('the fetched revision is fingerprinted', JSON.parse(String(row.config)).source_commit === NEW_COMMIT)
    },
  )

  console.log(failures ? `\n${failures} بررسی ناموفق ❌` : '\nهمهٔ بررسی‌ها موفق ✅')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('smoke run crashed:', err)
  process.exit(1)
})
