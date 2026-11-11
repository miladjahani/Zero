/**
 * miliconfigosv3 (miladjahani/Miliconfigpro) — retired source.
 *
 * It no longer appears in the wizard or the bot's source picker: "Mili" from
 * miladjahani/Milios3.10.2 replaced it. What must NOT happen is the opposite of
 * adding it — a silent removal from the engine, which would leave the
 * deployments already running this source unable to update or roll back (their
 * stored `worker_source` would resolve to nothing).
 *
 * So this check asserts both halves: gone from the pickers, still deployable and
 * still verified against its own upstream.
 *
 * Run: bun scripts/check-miliconfigosv3-source.test.ts
 */
import { WORKER_SOURCES_CATALOG, autoWorkerSources } from '../shared/worker-sources'
import { WORKER_SOURCE_KIND, subTargetsForSource, uuidPathSource, workerSourceKind } from '../shared/worker-links'
import { fetchWorkerSource, lookupWorkerSource } from '../worker/deploy'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── pickers ─────────────────────────────────────────────────────────────────
check('not listed in the catalog (gone from wizard + bot list)', !WORKER_SOURCES_CATALOG.some((s) => s.id === 'miliconfigosv3'))
check('not among the auto sources', !autoWorkerSources().some((s) => s.id === 'miliconfigosv3'))
check('replaced by Mili at the top of the list', autoWorkerSources()[0]?.id === 'milios', String(autoWorkerSources()[0]?.id))

// ── engine (must keep working for existing deployments) ─────────────────────
const cfg = lookupWorkerSource('miliconfigosv3')
check('engine still knows the id (no silent edgetunnel fallback)', !!cfg && cfg.label !== lookupWorkerSource('edgetunnel')!.label)
check('engine fetches the published single-file bundle', !!cfg?.url.endsWith('/main/_worker.js'), cfg?.url)
check('engine verifies the identity marker', cfg?.expectMarker === 'MILICONFIG')
check('engine uses the repo compatibility date', cfg?.compat === '2024-09-23', cfg?.compat)
check('engine provisions a D1 database', cfg?.provisionD1 === true)
check('engine declares no KV binding (D1-only panel)', cfg?.kvBinding === '')
check('engine sets the admin path env (env.u)', cfg?.uuidEnvName === 'u')
check('engine adds no compatibility flags (repo declares none)', (cfg?.compatFlags ?? ['x']).length === 0)

// ── routing model ───────────────────────────────────────────────────────────
check('links: maps to the uuid-panel model', WORKER_SOURCE_KIND.miliconfigosv3 === 'uuidpanel')
check('links: resolves to uuidpanel', workerSourceKind('miliconfigosv3') === 'uuidpanel')
check('links: no deploy-time sub link is advertised', subTargetsForSource('miliconfigosv3').length === 0)
check('links: /<uuid> is the panel, not a sub path', uuidPathSource('miliconfigosv3') === false)

// ── upstream file (live, skipped when offline) ──────────────────────────────
const fetched = await fetchWorkerSource(cfg!, [])
if (!fetched.source && fetched.errors.some((e) => e.includes('fetch failed'))) {
  console.log('  ⚠ live GitHub check skipped — offline environment')
} else {
  check('upstream file downloads and verifies', !!fetched.source, fetched.errors.join(' · ').slice(0, 200))
  if (fetched.source) {
    check('checksum verified against the published blob', fetched.source.checksumVerified === true)
    const bytes = new TextEncoder().encode(fetched.source.code).length
    check('download is the whole published file', bytes > 100_000, String(bytes))
    check('it is the project (marker present)', fetched.source.code.includes('MILICONFIG'))
    check('it reads its admin path from the env var the engine sets', /[.n]\?\.u\b|[.n]\.u\b/.test(fetched.source.code))
    check('it is a module bundle (cloudflare:sockets import)', fetched.source.code.includes('cloudflare:sockets'))
  }
}

console.log(failures === 0 ? '\nAll retired-source checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
