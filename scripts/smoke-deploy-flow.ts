/**
 * Engine-level smoke test for the worker deployment flow (worker/deploy.ts) with
 * the GitHub and Cloudflare APIs faked through a patched global fetch.
 *
 * It pins the behaviour behind "ورکر مستقر می‌شود ولی لینکش نمایش داده نمی‌شود و
 * همین‌طور «در حال استقرار» می‌ماند":
 *
 *   1. status + worker URL + panel URL + sub URL are persisted **before** the
 *      optional self-check, so a runtime that kills the background task halfway
 *      through the tail can no longer leave the row stuck on 'deploying' with no
 *      link. The check runs from *inside* the probe fetch: the row must already
 *      say `deployed` with both links when the first probe arrives.
 *   2. a failing `GET /workers/subdomain` no longer yields
 *      `https://<script>.workers.dev` (a host that can never resolve): the panel
 *      registers a subdomain, then reuses one the account already published.
 *   3. when no real host can be built, the warm-up is skipped completely (no
 *      probe to a dead name) and the deployment is still reported as deployed.
 *   4. `waitForWorkerLive` honours its total budget, so the old 20 × (8s + 1.5s)
 *      = 190s worst case can never hold the deployment open again.
 *   5. the environment the user picked (CF Workers / CF Pages) is honoured for
 *      *every* source in the catalog — CFnew/NEXUS/D1 panels included. They used
 *      to be re-routed to Pages behind the user's back.
 *
 * Run: bun scripts/smoke-deploy-flow.ts
 */
import { lookupWorkerSource, reapStaleDeployments, runDeployment, waitForWorkerLive, type DeployJob } from '../worker/deploy'
import { runDeploymentUpdate } from '../worker/update'
import { gitBlobSha1 } from '../worker/source-verify'
import { autoWorkerSources } from '../shared/worker-sources'
import type { Env } from '../worker/env'

type Row = Record<string, any>

const realFetch = globalThis.fetch

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── fake D1 (the same minimal shim the other engine smoke tests use) ─────────
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
      const c = clause.trim()
      const inList = /^(\w+)\s+IN\s*\(([^)]*)\)$/i.exec(c)
      if (inList) {
        const allowed = inList[2].split(',').map((p) => p.trim().replace(/^'|'$/g, ''))
        if (!allowed.includes(String(row[inList[1]]))) return false
        continue
      }
      const like = /^(\w+)\s+LIKE\s+(.+?)$/i.exec(c)
      if (like) {
        const raw = like[2].trim()
        const pattern = raw === '?' ? String(binds[i++]) : raw.replace(/^'|'$/g, '')
        const rx = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`)
        if (!rx.test(String(row[like[1]] ?? ''))) return false
        continue
      }
      const cmp = /^(\w+)\s*(=|<>|<|>|<=|>=)\s*(.+?)$/.exec(c)
      if (!cmp) throw new Error(`fake D1: unsupported WHERE clause ${c}`)
      const value = cmp[3].trim() === '?' ? binds[i++] : cmp[3].trim().replace(/^'|'$/g, '')
      const left = String(row[cmp[1]])
      const right = String(value)
      // ISO-8601 timestamps compare correctly as strings.
      const ok =
        cmp[2] === '=' ? left === right
        : cmp[2] === '<>' ? left !== right
        : cmp[2] === '<' ? left < right
        : cmp[2] === '>' ? left > right
        : cmp[2] === '<=' ? left <= right
        : left >= right
      if (!ok) return false
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
      // `col = ?` and `col = 'literal'` assignments; nothing fancier is used.
      const assignments = update[2].split(',').map((a) => a.trim())
      let i = 0
      const patch: Row = {}
      for (const assignment of assignments) {
        const [col, val] = assignment.split('=').map((p) => p.trim())
        patch[col] = val === '?' ? binds[i++] : val.replace(/^'|'$/g, '')
      }
      for (const row of tableOf(update[1]).values()) {
        if (whereMatches(row, update[3], binds, i)) Object.assign(row, patch)
      }
      return null
    }
    const select = /^SELECT ([\s\S]*?) FROM (\w+)(?: WHERE ([\s\S]*?))?(?: ORDER BY [\s\S]*?)?(?: LIMIT \d+)?$/i.exec(s)
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
    throw new Error(`fake D1: unsupported SQL ${s}`)
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

// ── fixtures ────────────────────────────────────────────────────────────────
function makeSource(marker: string, helpers = 60): string {
  const lines = [`// ${marker}`, "const NAME = 'fixture'", 'export default {', '  async fetch(request) {']
  lines.push("    return new Response(NAME + new URL(request.url).pathname, { headers: { 'content-type': 'text/plain' } })")
  lines.push('  },', '}')
  for (let i = 0; i < helpers; i++) lines.push(`function helper${i}(value) { return value + ${i} * ${helpers} }`)
  return lines.join('\n') + '\n'
}

// The fixture carries CFnew's identity marker, because the `custom` source (and
// every scenario below that uses it) is verified against it before upload.
const SOURCE = makeSource('CFnew — deploy flow fixture')
const COMMIT = 'cccc3333cccc3333cccc3333cccc3333cccc3333'
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

const ACCT = 'acct-1'
const NAME = 'edge-relay-test'
const UUID = '11111111-2222-3333-4444-555555555555'

interface Harness {
  /** Subdomain the account reports (null = the endpoint says "none"). */
  subdomain: string | null
  /** What a successful subdomain registration returns (null = registration refused). */
  registerAs: string | null
  /** Whether the deployed worker ever answers without `error code: 1101`. */
  probeAlive: boolean
  probes: string[]
  /** Snapshot of the deployment row at the moment the first probe arrives. */
  rowAtFirstProbe: Row | null
  uploads: number
  deletes: number
  /** Storage the deployment asked Cloudflare to create. */
  kvCreates: number
  d1Creates: number
  /** The bytes of the last uploaded worker script (binding assertions). */
  lastMetadata: any
}

function installFetch(h: Harness, db: () => Tables): void {
  // @ts-expect-error test shim
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

    // GitHub: branch head commit, published file checksum, raw file bytes.
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\//.test(url)) return json({ sha: COMMIT })
    // Repository metadata (default branch) — used by the GitHub source mode.
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return json({ default_branch: 'main' })
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\//.test(url)) {
      // A repo with no wrangler config: every entry candidate "exists" as a
      // file, which is what a single-file worker repo looks like.
      if (/wrangler\.(toml|jsonc|json)/.test(url)) return json({ message: 'Not Found' }, 404)
      return json({ sha: await gitBlobSha1(SOURCE), size: bytesOf(SOURCE), type: 'file' })
    }
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      return new Response(SOURCE, { status: 200, headers: { 'Content-Type': 'text/plain', etag: '"etag-1"' } })
    }

    // Cloudflare: account + token.
    if (url.endsWith('/user/tokens/verify')) return json({ success: false, errors: [{ message: 'account token' }] })
    if (/\/accounts\?per_page=50$/.test(url)) return json({ success: true, result: [{ id: ACCT, name: 'Test Account' }] })

    // Cloudflare: storage.
    if (method === 'POST' && /\/accounts\/[^/]+\/storage\/kv\/namespaces$/.test(url)) {
      h.kvCreates++
      return json({ success: true, result: { id: 'kv-1' } })
    }
    if (method === 'POST' && /\/accounts\/[^/]+\/d1\/database$/.test(url)) {
      h.d1Creates++
      return json({ success: true, result: { uuid: 'db-1' } })
    }
    if (/\/accounts\/[^/]+\/d1\/database\/db-1\/query$/.test(url)) return json({ success: true, result: [{ success: true }] })
    if (/\/storage\/kv\/namespaces\/[^/]+\/values\//.test(url)) return json({ success: true })
    if (method === 'POST' && /\/accounts\/[^/]+\/r2\/buckets$/.test(url)) {
      return json({ success: true, result: { name: `${NAME}-files` } })
    }
    if (method === 'GET' && /\/r2\/buckets/.test(url)) return json({ success: true, result: [] })

    // Cloudflare: the script itself.
    if (/\/accounts\/[^/]+\/workers\/scripts\/[^/]+$/.test(url)) {
      if (method === 'GET') return json({ success: false }, 404)
      if (method === 'PUT') {
        h.uploads++
        const metadata = (init?.body as FormData | undefined)?.get?.('metadata')
        if (metadata) {
          try { h.lastMetadata = JSON.parse(await (metadata as Blob).text()) } catch { /* ignore */ }
        }
        return json({ success: true })
      }
      if (method === 'DELETE') {
        h.deletes++
        return json({ success: true })
      }
    }
    if (/\/workers\/scripts\/[^/]+\/subdomain$/.test(url)) return json({ success: true })
    if (/\/workers\/scripts\/[^/]+\/settings$/.test(url)) return json({ success: true })
    if (/\/zones\?per_page=50$/.test(url)) return json({ success: true, result: [] })

    // Cloudflare: the account's workers.dev subdomain.
    if (url.endsWith('/workers/subdomain')) {
      if (method === 'GET') {
        return json(h.subdomain ? { success: true, result: { subdomain: h.subdomain } } : { success: false, errors: [{ message: 'not found' }] })
      }
      if (method === 'PUT') {
        if (h.registerAs) h.subdomain = h.registerAs
        return json({ success: !!h.registerAs })
      }
    }

    // The deployed worker itself.
    if (/^https:\/\/[^/]+\.workers\.dev/.test(url)) {
      h.probes.push(url)
      if (!h.rowAtFirstProbe) {
        const row = db().deployments?.get('dep-1')
        h.rowAtFirstProbe = row ? { ...row } : null
      }
      return new Response(h.probeAlive ? 'ok' : 'error code: 1101\nWorker threw exception', {
        status: h.probeAlive ? 200 : 500,
      })
    }

    // The panel's own host: a relative source candidate (`/repo/nexus.js`) is
    // resolved against it. A real host answers 404 when the build does not
    // carry that asset; the harness must do the same instead of throwing.
    if (url.startsWith('https://panel.example/')) return new Response('not found', { status: 404 })

    throw new Error(`unexpected fetch ${method} ${url}`)
  }
}

function makeEnv(seed: Row[] = []): { env: Env; tables: Tables } {
  const { DB, tables } = makeDb({
    deployments: [
      ...seed,
      {
        id: 'dep-1',
        user_id: 'u1',
        name: NAME,
        uuid: UUID,
        status: 'deploying',
        method: 'workers',
        worker_source: 'custom',
        config: '{}',
        logs: '',
      },
    ],
    cf_tokens: [{ id: 'tok-1', user_id: 'u1', token: 'cf-token', status: 'active' }],
    activity_logs: [],
  })
  return { env: { DB, ASSETS: {} as any } as unknown as Env, tables }
}

const job = (): DeployJob => ({
  deployment_id: 'dep-1',
  worker_name: NAME,
  cf_token: 'cf-token',
  cf_token_row_id: 'tok-1',
  uuid: UUID,
  method: 'workers',
  worker_source: 'custom',
  proxyip: 'auto',
  origin: 'https://panel.example',
  // These scenarios are about the *Workers* path: the warm-up, the workers.dev
  // subdomain and the persistence of the links. `retried_on_pages` marks a run
  // that is already the automatic retry of the other environment, so it keeps
  // these runs from falling back into Pages when the simulated worker stays
  // dead. Scenario 15 runs with the flag off to prove the user's choice alone
  // decides the environment.
  retried_on_pages: true,
})

async function runScenario(
  name: string,
  seed: Row[],
  mutate: (h: Harness) => void,
  /** Extra job fields — worker_source / source_url / extra_bindings. */
  jobPatch: Partial<DeployJob> = {},
) {
  console.log(`\n── ${name} ──`)
  const h: Harness = {
    subdomain: null, registerAs: null, probeAlive: false, probes: [], rowAtFirstProbe: null,
    uploads: 0, deletes: 0, kvCreates: 0, d1Creates: 0, lastMetadata: null,
  }
  mutate(h)
  const { env, tables } = makeEnv(seed)
  installFetch(h, () => tables)
  await runDeployment(env, { ...job(), ...jobPatch })
  const row = (): Row => tables.deployments.get('dep-1')!
  // A failed run is printed verbatim: the log *is* the diagnosis, and without
  // it a broken flow only shows up as a list of failed assertions.
  if (row().status === 'failed') console.log('  ↳ deploy log:\n' + String(row().logs).replace(/^/gm, '    '))
  return { h, row }
}

// ── 1. warm-up never succeeds, yet the links are already persisted ──────────
{
  const { h, row } = await runScenario('self-check fails — links must still be persisted', [], (h) => {
    h.subdomain = 'edgeacct1'
    h.probeAlive = false
  })
  // One upload to create the script + one clean re-create (Cloudflare leaves a
  // first creation in a dead state), which is the documented flow.
  check('the worker was uploaded and re-created', h.uploads === 2 && h.deletes === 1, `${h.uploads} upload(s), ${h.deletes} delete(s)`)
  check('status is deployed (not stuck on deploying)', row().status === 'deployed', String(row().status))
  check('worker URL uses the real account subdomain',
    row().worker_url === `https://${NAME}.edgeacct1.workers.dev`, String(row().worker_url))
  check('panel URL is stored', row().panel_url === `https://${NAME}.edgeacct1.workers.dev/${UUID}`, String(row().panel_url))
  check('sub URL is stored', row().sub_url === `https://${NAME}.edgeacct1.workers.dev/${UUID}/sub`, String(row().sub_url))
  check('self-check recorded as failed', JSON.parse(String(row().config)).self_check === 'failed',
    String(JSON.parse(String(row().config)).self_check))
  check('the probe saw the row already deployed with both links',
    h.rowAtFirstProbe?.status === 'deployed' && !!h.rowAtFirstProbe?.panel_url && !!h.rowAtFirstProbe?.sub_url,
    `status=${h.rowAtFirstProbe?.status} panel=${h.rowAtFirstProbe?.panel_url} sub=${h.rowAtFirstProbe?.sub_url}`)
  check('the warm-up stayed bounded', h.probes.length >= 1 && h.probes.length <= 8, `${h.probes.length} probe(s)`)
}

// ── 2. fresh account: register a subdomain instead of inventing a dead host ──
{
  const { h, row } = await runScenario('account has no workers.dev subdomain yet', [], (h) => {
    h.subdomain = null
    h.registerAs = 'edgeedge-relay-test'
    h.probeAlive = true
  })
  check('a subdomain was registered and used',
    row().worker_url === `https://${NAME}.edgeedge-relay-test.workers.dev`, String(row().worker_url))
  check('that host is what got probed',
    h.probes.length > 0 && h.probes.every((u) => u.includes('edgeedge-relay-test')), h.probes.join(', '))
  check('self-check passed', JSON.parse(String(row().config)).self_check === 'passed')
  check('status is deployed', row().status === 'deployed')
}

// ── 3. no subdomain at all → skip the warm-up, still hand out the link ──────
{
  const { h, row } = await runScenario('subdomain unresolvable — no dead-host polling', [], (h) => {
    h.subdomain = null
    h.registerAs = null
  })
  check('no probe was made against an unresolvable host', h.probes.length === 0, h.probes.join(', '))
  check('deployment still reported as deployed', row().status === 'deployed', String(row().status))
  check('worker URL is still stored', !!row().worker_url, String(row().worker_url))
  check('panel URL is still stored', !!row().panel_url, String(row().panel_url))
  check('the incomplete URL is called out in the log',
    String(row().logs).includes('زیردامنهٔ workers.dev این حساب خوانده نشد'))
  check('the skipped self-check is called out in the log', String(row().logs).includes('self-check skipped'))
  check('no self-check verdict is faked', JSON.parse(String(row().config)).self_check === undefined)
}

// ── 4. subdomain unresolvable but the account already published one ─────────
{
  const { h, row } = await runScenario('reuse the subdomain of an older deployment', [
    {
      id: 'dep-old',
      user_id: 'u1',
      name: 'edge-relay-85a3',
      status: 'deployed',
      method: 'workers',
      worker_source: 'custom',
      worker_url: 'https://edge-relay-85a3.ms1rbxcr2ag5.workers.dev',
      cf_account_id: ACCT,
      config: '{}',
    },
  ], (h) => {
    h.subdomain = null
    h.registerAs = null
    h.probeAlive = false
  })
  check('the known account subdomain is reused',
    row().worker_url === `https://${NAME}.ms1rbxcr2ag5.workers.dev`, String(row().worker_url))
  check('the reused host is what got probed',
    h.probes.length > 0 && h.probes.every((u) => u.includes('ms1rbxcr2ag5')), h.probes.join(', '))
  check('status is deployed', row().status === 'deployed')
}

// ── 5. a lost background task is closed out instead of hanging forever ──────
{
  console.log('\n── stale deployment recovery ──')
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  const fresh = new Date().toISOString()
  const { env, tables } = makeEnv([
    { id: 'dep-stale', user_id: 'u1', name: 'edge-relay-6b2e', status: 'deploying', method: 'workers', worker_source: 'custom', config: '{}', updated_at: old, created_at: old },
    { id: 'dep-fresh', user_id: 'u1', name: 'edge-relay-d21a', status: 'deploying', method: 'workers', worker_source: 'custom', config: '{}', updated_at: fresh, created_at: fresh },
    { id: 'dep-other', user_id: 'u2', name: 'someone-else', status: 'deploying', method: 'workers', worker_source: 'custom', config: '{}', updated_at: old, created_at: old },
  ])
  const reaped = await reapStaleDeployments(env, 'u1')
  check('the stale row was reaped', reaped === 1, String(reaped))
  check('the stale row is marked failed', tables.deployments.get('dep-stale')?.status === 'failed')
  check('and explains why', String(tables.deployments.get('dep-stale')?.error_message).includes('پس‌زمینه قطع شد'))
  check('a still-running row is left alone', tables.deployments.get('dep-fresh')?.status === 'deploying')
  check('another user\'s row is never touched', tables.deployments.get('dep-other')?.status === 'deploying')
}

// ── 6. waitForWorkerLive obeys its total budget ─────────────────────────────
{
  // A fetch that only settles when it is aborted — the worst case the old
  // unbounded loop turned into ~190s of hanging.
  // @ts-expect-error test shim
  globalThis.fetch = (_url: any, init?: any) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  const started = Date.now()
  const alive = await waitForWorkerLive('https://x.workers.dev', 20, 1500, 400)
  const elapsed = Date.now() - started
  check('a hanging probe returns false', alive === false)
  check('the total budget is respected', elapsed < 2000, `${elapsed}ms for a 400ms budget`)
  globalThis.fetch = realFetch
}

// ── 7. a live worker short-circuits the probe ───────────────────────────────
{
  // @ts-expect-error test shim
  globalThis.fetch = async () => new Response('ok', { status: 200 })
  const started = Date.now()
  const alive = await waitForWorkerLive('https://x.workers.dev', 20, 1500, 2000)
  check('a live worker is detected on the first probe', alive === true)
  check('and returns immediately', Date.now() - started < 500, `${Date.now() - started}ms`)
  globalThis.fetch = realFetch
}

// ── 8. an unknown source id fails loudly (never a silent edgetunnel) ────────
// This is the bug behind «پنل نوا، پنل edgetunnel را استقرار می‌دهد»: any id the
// build did not know used to resolve to edgetunnel and upload cmliu's worker
// under the requested name — with a perfectly valid checksum.
{
  const { h, row } = await runScenario(
    'unknown worker source → hard failure, nothing uploaded',
    [],
    (h) => { h.subdomain = 'edgeacct1' },
    { worker_source: 'nova-legacy' },
  )
  check('nothing was uploaded', h.uploads === 0, `${h.uploads} upload(s)`)
  check('no storage was provisioned', h.kvCreates === 0 && h.d1Creates === 0)
  check('the deployment failed', row().status === 'failed', String(row().status))
  check('the log names the unknown source', String(row().logs).includes('nova-legacy') && String(row().logs).includes('شناخته‌شده نیست'))
  check('and no edgetunnel code was deployed', !JSON.parse(String(row().config)).source_url)
}

// ── 9. a source whose file belongs to another project is refused ────────────
// The fixture upstream contains neither Nova's banner nor a wrong branch: the
// identity marker is what stops a foreign file from overwriting the worker.
{
  const { h, row } = await runScenario(
    'nova source with foreign bytes → identity check stops the deploy',
    [],
    (h) => { h.subdomain = 'edgeacct1' },
    { worker_source: 'nova' },
  )
  check('the foreign file was not uploaded', h.uploads === 0, `${h.uploads} upload(s)`)
  check('the deployment failed', row().status === 'failed', String(row().status))
  check('the log says the file is not this source\'s',
    String(row().logs).includes('متعلق به این منبع نیست'), String(row().logs).split('\n').slice(-3).join(' | '))
}

// ── 10. "deploy any GitHub repository" — resolved from the repo itself ──────
{
  const { h, row } = await runScenario(
    'GitHub repo URL → entry file resolved, checksum verified, nothing extra created',
    [],
    (h) => { h.subdomain = 'edgeacct1'; h.probeAlive = true },
    { worker_source: 'github', source_url: 'https://github.com/acme/worker-demo' },
  )
  check('the deployment succeeded', row().status === 'deployed', String(row().status))
  check('the entry file came from the repo root', String(row().logs).includes('_worker.js'), String(row().logs))
  check('the pasted repo URL is recorded for future updates',
    JSON.parse(String(row().config)).repo_url === 'https://github.com/acme/worker-demo',
    String(JSON.parse(String(row().config)).repo_url))
  check('the fetched file fingerprint is kept separately',
    String(JSON.parse(String(row().config)).source_url).includes('raw.githubusercontent.com/acme/worker-demo'),
    String(JSON.parse(String(row().config)).source_url))
  check('the resolved entry path is recorded', JSON.parse(String(row().config)).source_entry === '_worker.js')
  check('panel URL is the worker root (an unknown app owns its routes)',
    row().panel_url === `https://${NAME}.edgeacct1.workers.dev`, String(row().panel_url))
  check('no deploy-time sub link is invented', !row().sub_url, String(row().sub_url))
  check('no KV was created (not requested)', h.kvCreates === 0, `${h.kvCreates} KV create(s)`)
  check('no D1 was created (not requested)', h.d1Creates === 0, `${h.d1Creates} D1 create(s)`)
}

// ── 11/12. KV and D1 are opt-in and bound with the documented names ─────────
{
  const withD1 = await runScenario(
    'GitHub repo + D1 requested',
    [],
    (h) => { h.subdomain = 'edgeacct1'; h.probeAlive = true },
    { worker_source: 'github', source_url: 'https://github.com/acme/worker-demo', extra_bindings: { d1: true } },
  )
  check('a D1 database was created', withD1.h.d1Creates === 1, `${withD1.h.d1Creates}`)
  check('and bound as DB',
    JSON.stringify(withD1.h.lastMetadata?.bindings ?? []).includes('"name":"DB"'), JSON.stringify(withD1.h.lastMetadata?.bindings))
  check('no KV namespace was created', withD1.h.kvCreates === 0)

  const withKv = await runScenario(
    'GitHub repo + KV requested',
    [],
    (h) => { h.subdomain = 'edgeacct1'; h.probeAlive = true },
    { worker_source: 'github', source_url: 'https://github.com/acme/worker-demo', extra_bindings: { kv: true } },
  )
  check('a KV namespace was created', withKv.h.kvCreates === 1, `${withKv.h.kvCreates}`)
  check('and bound as KV',
    JSON.stringify(withKv.h.lastMetadata?.bindings ?? []).includes('"name":"KV"'), JSON.stringify(withKv.h.lastMetadata?.bindings))
  check('no D1 database was created', withKv.h.d1Creates === 0)
  check('no empty-name binding is emitted',
    JSON.stringify(withKv.h.lastMetadata?.bindings ?? []).includes('"name":""') === false)
}

// ── 13. a non-GitHub URL is refused before anything is created ─────────────
{
  const { h, row } = await runScenario(
    'non-GitHub URL → readable refusal',
    [],
    (h) => { h.subdomain = 'edgeacct1' },
    { worker_source: 'github', source_url: 'https://gitlab.com/acme/worker-demo' },
  )
  check('nothing was uploaded', h.uploads === 0)
  check('the deployment failed', row().status === 'failed')
  check('the reason names the supported host', String(row().logs).includes('github.com'))
}

// ── 14. source lookup: exact, never a fallback ─────────────────────────────
{
  console.log('\n── source lookup ──')
  check('an unknown id resolves to null', lookupWorkerSource('does-not-exist') === null)
  check('an empty id still means the default source',
    lookupWorkerSource('')?.label.includes('edgetunnel') === true)
  check('every catalogued id resolves to its own entry',
    ['edgetunnel', 'edgetunnel_kv', 'custom', 'nexus', 'zeus', 'miliconfigzeus', 'nova']
      .every((id) => !!lookupWorkerSource(id)?.url))
  const nova = lookupWorkerSource('nova')
  check('nova deploys from its own repository',
    !!nova && nova.url.includes('IRNova/Nova-Proxy'), nova?.url)
  check('nova keeps its own marker', nova?.expectMarker === 'Nova', nova?.expectMarker)
  const zeus = lookupWorkerSource('zeus')
  check('zeus and miliconfigzeus are different projects',
    !!zeus && !!lookupWorkerSource('miliconfigzeus') && zeus.url !== lookupWorkerSource('miliconfigzeus')!.url)
  check('the panel catalog still lists both removed-then-restored sources',
    ['nexus', 'miliconfigzeus'].every((id) => autoWorkerSources().some((s) => s.id === id)))
  check('the GitHub mode is not offered as a catalogued source (it needs a URL)',
    autoWorkerSources().every((s) => s.id !== 'github'))
}

// ── 15. the chosen environment is never rewritten (CFnew/NEXUS/D1 panels) ────
// The engine used to send every non-GitHub source to Pages on the first
// attempt, so picking «CF Workers» for CFnew / NEXUS / a D1 panel produced a
// Pages project the user never asked for. A heavy source must now land on the
// environment that was chosen: with the flag off, an old build would push this
// run to Pages, and the harness (which only fakes the Workers + Pages *project*
// APIs this scenario needs) would fail loudly instead of quietly passing.
{
  const { h, row } = await runScenario(
    'heavy source keeps the CF Workers environment the user chose',
    [],
    (h) => { h.subdomain = 'edgeacct1'; h.probeAlive = true },
    { worker_source: 'custom', retried_on_pages: false },
  )
  check('the heavy source was uploaded as a Worker script', h.uploads === 2, `${h.uploads} upload(s)`)
  check('the row records the chosen environment', row().method === 'workers', String(row().method))
  check('the log states the chosen environment',
    String(row().logs).includes('environment: Cloudflare Workers'), String(row().logs).split('\n')[0])
  check('the deployment succeeded on Workers', row().status === 'deployed', String(row().status))
  check('no Pages project was created for it',
    !String(row().worker_url ?? '').includes('.pages.dev'), String(row().worker_url))
}

// ── 16. an update check needs no Cloudflare credentials ──────────────────────
// The check used to die on «توکن فعال Cloudflare پیدا نشد» before it even looked
// at GitHub, so an owner without a stored token could not learn whether a newer
// version existed. It now answers with the path that installs it: a GitHub-linked
// worker deploys on push, a panel carrying CF_API_TOKEN updates itself, and
// otherwise the fresh file + a ready-to-run command are handed over.
{
  console.log('\n── update without Cloudflare credentials ──')
  const h: Harness = {
    subdomain: 'edgeacct1', registerAs: null, probeAlive: true, probes: [], rowAtFirstProbe: null,
    uploads: 0, deletes: 0, kvCreates: 0, d1Creates: 0, lastMetadata: null,
  }
  const { env, tables } = makeEnv()
  installFetch(h, () => tables)
  // No token on the account at all — the whole point of the scenario.
  tables.cf_tokens.clear()
  tables.deployments.set('dep-1', {
    ...tables.deployments.get('dep-1'),
    status: 'deployed',
    method: 'workers',
    worker_source: 'custom',
    worker_url: `https://${NAME}.edgeacct1.workers.dev`,
    panel_url: `https://${NAME}.edgeacct1.workers.dev/${UUID}`,
    kv_namespace_id: 'kv-1',
    config: JSON.stringify({ source_etag: 'older-etag', source_synced_at: '2026-01-01T00:00:00Z', d1_database_id: 'db-1', d1_database_name: `${NAME}-db` }),
  })

  const manual = await runDeploymentUpdate(env, 'u1', 'dep-1')
  if (!manual.ok || !manual.download_url) {
    console.log(`  ↳ update log:\n${String(manual.logs.join('\n')).replace(/^/gm, '    ')}`)
    console.log(`  ↳ message: ${manual.message}`)
  }
  check('the check itself succeeds without a token', manual.ok === true, String(manual.ok))
  check('it reports the manual path', manual.channel === 'manual', String(manual.channel))
  check('it noticed the newer upstream file', manual.changed === true, String(manual.changed))
  check('it hands out the fresh file', String(manual.download_url ?? '').includes('raw.githubusercontent.com'), String(manual.download_url))
  check('the recipe is ready to run',
    String(manual.deploy_command ?? '').includes('npx wrangler deploy'), String(manual.deploy_command))
  check('the recipe keeps the deployment\'s D1 binding',
    String(manual.deploy_command ?? '').includes('database_id = "db-1"'), String(manual.deploy_command))
  check('nothing was uploaded without a token', h.uploads === 0, `${h.uploads} upload(s)`)

  // Same record, but linked to a repository: a push deploys it, nothing to do.
  tables.deployments.get('dep-1')!.config = JSON.stringify({ source_etag: 'older-etag', repo_url: 'https://github.com/acme/worker-demo' })
  const auto = await runDeploymentUpdate(env, 'u1', 'dep-1')
  check('a GitHub-linked worker reports the automatic path', auto.channel === 'auto', String(auto.channel))
  check('and still hands over the fallback recipe', !!auto.deploy_command)

  // Same record, but the panel carries its own CF_API_TOKEN: it updates itself.
  tables.deployments.get('dep-1')!.config = JSON.stringify({ source_etag: 'older-etag', self_update_token: true })
  const self = await runDeploymentUpdate(env, 'u1', 'dep-1')
  check('a self-updating panel reports the in-panel path', self.channel === 'self', String(self.channel))
  check('and points at its own dashboard', !!self.panel_url, String(self.panel_url))

  // Upstream unchanged: say so instead of inventing work.
  // The fixture upstream serves `etag: "etag-1"`; the header is stored verbatim,
  // so this is the fingerprint of a deployment that is already current.
  tables.deployments.get('dep-1')!.config = JSON.stringify({ source_etag: '"etag-1"', self_update_token: true })
  const same = await runDeploymentUpdate(env, 'u1', 'dep-1')
  check('an unchanged upstream is reported as up to date', same.up_to_date === true, String(same.up_to_date))
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll deployment-flow checks passed.')
