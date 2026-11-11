/**
 * Smoke test for the Cloudflare token template and the per-source client links.
 *
 * Locks in the two things that were broken and are easy to break again:
 *   1. The token link must carry the permission keys Cloudflare actually
 *      documents (invalid keys are dropped by the dashboard, which is how a
 *      user ended up with a token that could not read Workers KV), must ask for
 *      read *and* edit on the resources the panel reads before writing, and must
 *      include API-token management.
 *   2. Every `target=` a client button can produce must be one the worker source
 *      itself matches — the CFnew values were read out of
 *      public/repo/worker-source.js, so a typo like `v2rayng` (the worker
 *      matches `v2ray`) or a made-up `shadowrocket` target fails here.
 *
 * Run: bun scripts/smoke-cf-token-links.ts
 */
import {
  CF_TOKEN_NAME,
  CF_TOKEN_PERMISSIONS,
  buildCfTokenUrl,
  cfPermissionKeyCount,
  cfPermissionLabels,
} from '../shared/cf-token'
import {
  SUB_TARGETS_BY_KIND,
  WORKER_SOURCE_KIND,
  buildClientSubUrl,
  subTargetsForSource,
  uuidPathSource,
  workerSourceKind,
} from '../shared/worker-links'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`✓ ${name}`)
  } else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── 1. Token template ───────────────────────────────────────────────────────

// Keys from Cloudflare's template-url permission reference table. A key that is
// missing here must never appear in the URL (the dashboard would drop it).
const DOCUMENTED_KEYS = new Set([
  'account_analytics', 'account_api_tokens', 'account_settings', 'billing',
  'workers_scripts', 'workers_kv_storage', 'workers_routes', 'workers_r2', 'd1',
  'queues', 'page', 'stream', 'images', 'logs',
  'dns', 'zone', 'zone_settings', 'analytics', 'firewall_services', 'page_rules',
  'cache', 'ssl_and_certificates',
  'access', 'access_acct', 'access_audit_log', 'access_custom_page', 'teams',
])

const unknownKeys = CF_TOKEN_PERMISSIONS.filter((p) => !DOCUMENTED_KEYS.has(p.key))
check('every permission key is a documented Cloudflare key', unknownKeys.length === 0,
  unknownKeys.map((p) => p.key).join(', '))

// Keys that were removed from Cloudflare and used to sit in this list.
const REMOVED_KEYS = ['user_details', 'dns_records', 'cache_purge', 'account', 'ssl_and_certificate', 'workers_tail']
const staleKeys = CF_TOKEN_PERMISSIONS.filter((p) => REMOVED_KEYS.includes(p.key))
check('no retired permission keys are requested', staleKeys.length === 0,
  staleKeys.map((p) => p.key).join(', '))

const typeOf = (key: string) => CF_TOKEN_PERMISSIONS.filter((p) => p.key === key).map((p) => p.type)
const hasTypes = (key: string, expected: string[]) =>
  expected.every((t) => typeOf(key).includes(t as never))

// The panel lists KV namespaces, reads back Pages projects and D1 databases and
// GETs zone settings before writing them — all of those need the read group too.
check('workers_kv_storage requests read + edit', hasTypes('workers_kv_storage', ['read', 'edit']),
  typeOf('workers_kv_storage').join('+'))
check('workers_scripts requests read + edit', hasTypes('workers_scripts', ['read', 'edit']),
  typeOf('workers_scripts').join('+'))
check('workers_r2 requests read + edit', hasTypes('workers_r2', ['read', 'edit']),
  typeOf('workers_r2').join('+'))
check('d1 requests read + edit', hasTypes('d1', ['read', 'edit']), typeOf('d1').join('+'))
check('page requests read + edit', hasTypes('page', ['read', 'edit']), typeOf('page').join('+'))
check('zone_settings requests read + edit', hasTypes('zone_settings', ['read', 'edit']),
  typeOf('zone_settings').join('+'))
check('cache uses the purge type', typeOf('cache').join('+') === 'purge', typeOf('cache').join('+'))
check('token management permission is requested', typeOf('account_api_tokens').includes('read'),
  typeOf('account_api_tokens').join('+'))

const url = buildCfTokenUrl()
check('token url points at the user token page', url.startsWith('https://dash.cloudflare.com/profile/api-tokens?'))
check('token url carries the account scope', url.includes('&accountId=*'))
check('token url carries the zone scope', url.includes('&zoneId=all'))
check('token url pre-fills the token name', url.includes(`&name=${encodeURIComponent(CF_TOKEN_NAME)}`))

const raw = new URL(url).searchParams.get('permissionGroupKeys') ?? ''
let parsed: Array<{ key: string; type: string }> = []
try { parsed = JSON.parse(raw) } catch { /* reported below */ }
check('permissionGroupKeys is a decodable JSON array', Array.isArray(parsed) && parsed.length === CF_TOKEN_PERMISSIONS.length,
  `${parsed.length} entries`)
check('permissionGroupKeys round-trips every permission',
  parsed.length === CF_TOKEN_PERMISSIONS.length &&
  parsed.every((p, i) => p.key === CF_TOKEN_PERMISSIONS[i].key && p.type === CF_TOKEN_PERMISSIONS[i].type))
check('permission types are all valid for the URL', parsed.every((p) => ['read', 'edit', 'revoke', 'run', 'purge'].includes(p.type)),
  parsed.map((p) => p.type).filter((t) => !['read', 'edit', 'revoke', 'run', 'purge'].includes(t)).join(', '))
check('permission count matches the number of groups', cfPermissionKeyCount() === new Set(CF_TOKEN_PERMISSIONS.map((p) => p.key)).size)
check('permission labels cover every group', cfPermissionLabels().length === cfPermissionKeyCount(),
  cfPermissionLabels().join(' | '))
check('opening the page twice yields the same url', buildCfTokenUrl() === url)

// ── 2. Per-source client links ──────────────────────────────────────────────

// target values the shipped CFnew worker matches (lower-cased before compare).
const CFNEW_TARGETS = new Set([
  'clash', 'clashr', 'surge', 'surge2', 'surge3', 'surge4', 'quantumult',
  'quanx', 'ss', 'ssr', 'v2ray', 'loon', 'singbox',
])

for (const [kind, targets] of Object.entries(SUB_TARGETS_BY_KIND)) {
  const bad = targets.filter((t) => t.target !== null && !CFNEW_TARGETS.has(t.target))
  check(`${kind}: every target is a name the source matches`, bad.length === 0,
    bad.map((t) => t.target).join(', '))
}

check('v2rayNG button uses the source value `v2ray`',
  subTargetsForSource('custom').some((t) => t.label === 'v2rayNG' && t.target === 'v2ray'))
check('no source asks for a `v2rayng` target',
  Object.values(SUB_TARGETS_BY_KIND).flat().every((t) => t.target !== 'v2rayng'))
check('Shadowrocket falls back to the raw sub link',
  subTargetsForSource('custom').some((t) => t.label === 'Shadowrocket' && t.target === null))
check('no source asks for an unsupported `shadowrocket` target',
  Object.values(SUB_TARGETS_BY_KIND).flat().every((t) => t.target !== 'shadowrocket'))

// id → kind mapping, including the CFnew-based NEXUS that used to be treated as
// edgetunnel by the settings bridge.
check('nexus is a CFnew source', workerSourceKind('nexus') === 'nexus' && uuidPathSource('nexus'))
check('custom is a CFnew source', workerSourceKind('custom') === 'custom' && uuidPathSource('custom'))
check('edgetunnel is not a uuid-path source', workerSourceKind('edgetunnel') === 'edgetunnel' && !uuidPathSource('edgetunnel'))
check('edgetunnel_kv maps to edgetunnel', workerSourceKind('edgetunnel_kv') === 'edgetunnel')
check('zeus/miliconfigzeus/nova are full D1 panels',
  ['zeus', 'miliconfigzeus', 'nova'].every((id) => workerSourceKind(id) === 'zeus'))
check('D1 panels expose no client targets', subTargetsForSource('zeus').length === 0)
check('unknown source ids fall back to edgetunnel', workerSourceKind('nope') === 'edgetunnel')
check('worker_source ids and kinds line up', Object.entries(WORKER_SOURCE_KIND).every(([id, kind]) => workerSourceKind(id) === kind))

// Link building: edgetunnel's `/sub?token=…` must keep its query string.
const cmliu = subTargetsForSource('custom')
const clash = cmliu.find((t) => t.label === 'Clash')!
const raw48 = cmliu.find((t) => t.label === 'Shadowrocket')!
check('target is appended to a plain link', buildClientSubUrl('https://w.dev/abc/sub', clash) === 'https://w.dev/abc/sub?target=clash')
check('target is appended to a token link without breaking it',
  buildClientSubUrl('https://w.dev/sub?token=deadbeef', clash) === 'https://w.dev/sub?token=deadbeef&target=clash')
check('raw link is returned untouched', buildClientSubUrl('https://w.dev/sub?token=deadbeef', raw48) === 'https://w.dev/sub?token=deadbeef')
check('a CFnew uuid sub link keeps working',
  buildClientSubUrl('https://w.dev/abc-123/sub', clash) === 'https://w.dev/abc-123/sub?target=clash')

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll token/link checks passed.')
