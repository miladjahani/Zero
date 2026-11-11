/**
 * Mili (miladjahani/Milios3.10.2) source wiring: the catalog entry, the deploy
 * engine's entry, the routing model and the upstream file must agree.
 *
 * The last part is live: the engine's own fetch path is used, so the check
 * fails if GitHub's published blob checksum, the file size or the identity
 * marker stop matching — the three things that keep a partial/foreign file away
 * from a worker.
 *
 * Run: bun scripts/check-milios-source.test.ts
 */
import { WORKER_SOURCES_CATALOG, autoWorkerSources } from '../shared/worker-sources'
import { WORKER_SOURCE_KIND, subTargetsForSource, uuidPathSource, workerSourceKind } from '../shared/worker-links'
import { fetchWorkerSource, lookupWorkerSource, optimizeWorkerSourceForColdStart } from '../worker/deploy'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── catalog ─────────────────────────────────────────────────────────────────
const entry = WORKER_SOURCES_CATALOG.find((s) => s.id === 'milios')
check('catalog lists milios', !!entry)
check('catalog name is Mili', entry?.name === 'Mili', String(entry?.name))
check('catalog repo is miladjahani/Milios3.10.2', entry?.repo === 'miladjahani/Milios3.10.2', String(entry?.repo))
check('catalog mode is auto (deployable by the engine)', entry?.mode === 'auto')
check('catalog url points at the repository', entry?.url === 'https://github.com/miladjahani/Milios3.10.2')
check('auto sources include it (wizard + bot pickers)', autoWorkerSources().some((s) => s.id === 'milios'))
check('it is the FIRST auto source (top of the bot and mini-app list)', autoWorkerSources()[0]?.id === 'milios', String(autoWorkerSources()[0]?.id))
check('the old miliconfigosv3 source is gone from the pickers', !autoWorkerSources().some((s) => s.id === 'miliconfigosv3'))

// ── engine ──────────────────────────────────────────────────────────────────
const cfg = lookupWorkerSource('milios')
check('engine knows the id (no silent edgetunnel fallback)', !!cfg && cfg.label !== lookupWorkerSource('edgetunnel')!.label)
check('engine fetches the published bundle from dist/', !!cfg?.url.endsWith('/main/dist/_worker.js'), cfg?.url)
check('engine keeps the root copy as a fallback', (cfg?.fallbackUrls ?? []).some((u) => u.endsWith('/main/_worker.js')), JSON.stringify(cfg?.fallbackUrls))
check('engine fetches it from the new repository', cfg?.url.includes('miladjahani/Milios3.10.2'), cfg?.url)
check('engine verifies the identity marker', cfg?.expectMarker === 'MILICONFIG')
check('engine uses the repo compatibility date', cfg?.compat === '2024-11-06', cfg?.compat)
check('engine provisions a D1 database', cfg?.provisionD1 === true)
check('engine declares no KV binding (D1-only panel)', cfg?.kvBinding === '')
check('engine sets the admin path env (env.u)', cfg?.uuidEnvName === 'u')
check('engine enables the in-panel updater (CF_API_TOKEN)', cfg?.selfUpdate === true)
check('engine adds no compatibility flags (repo declares none)', (cfg?.compatFlags ?? ['x']).length === 0)

// ── retired source ──────────────────────────────────────────────────────────
// Removing it from the pickers must not strand the deployments already running
// it: the engine entry is what makes their update/rollback possible.
const legacy = lookupWorkerSource('miliconfigosv3')
check('retired miliconfigosv3 still resolves in the engine', !!legacy && legacy.label !== lookupWorkerSource('edgetunnel')!.label)
check('retired source keeps its own upstream', legacy?.url.includes('Miliconfigpro') === true, legacy?.url)

// ── routing model ───────────────────────────────────────────────────────────
check('links: milios maps to its own uuid-panel model', WORKER_SOURCE_KIND.milios === 'uuidpanel')
check('links: resolves to uuidpanel', workerSourceKind('milios') === 'uuidpanel')
check('links: no deploy-time sub link is advertised', subTargetsForSource('milios').length === 0)
check('links: /<uuid> is the panel, not a sub path', uuidPathSource('milios') === false)

// ── upstream file (live or bundled fallback when offline) ────────────────────
const fetched = await fetchWorkerSource(cfg!, [])
if (!fetched.source && fetched.errors.some((e) => e.includes('fetch failed'))) {
  console.log('  ⚠ live GitHub check skipped — offline environment; verifying bundled /repo/milios.js + cold-start optimizer instead')
  const bundled = await fetchWorkerSource(cfg!, cfg?.fallbackUrls ?? [], async (p) => {
    const { readFileSync } = await import('node:fs')
    return readFileSync(new URL(`../public${p}`, import.meta.url), 'utf8')
  })
  check('bundled milios fallback loads and verifies', !!bundled.source, bundled.errors.join(' · ').slice(0, 200))
  if (bundled.source) {
    const opt = optimizeWorkerSourceForColdStart(bundled.source.code)
    check('it is the project (marker present)', opt.includes('MILICONFIG'))
    check('it is a module bundle (cloudflare:sockets import)', opt.includes('cloudflare:sockets'))
  }
} else {
  check('upstream file downloads and verifies', !!fetched.source, fetched.errors.join(' · ').slice(0, 200))
  if (fetched.source) {
    check('checksum verified against the published blob', fetched.source.checksumVerified === true)
    const bytes = new TextEncoder().encode(fetched.source.code).length
    check('bytes match the published size (739,602)', bytes === 739602, String(bytes))
    check('it is the project (marker present)', fetched.source.code.includes('MILICONFIG'))
    check('it is a module bundle (cloudflare:sockets import)', fetched.source.code.includes('cloudflare:sockets'))
    check('it reads the admin path from the env var the engine sets', /[.n]\.u\b/.test(fetched.source.code))
  }
}

console.log(failures === 0 ? '\nAll Mili source checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
