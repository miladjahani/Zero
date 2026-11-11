/**
 * How each deployed worker source serves its subscription links.
 *
 * The client buttons in the panel must send the `target=` name the *source*
 * itself understands. A value the worker does not match does not fall back to a
 * usable config — the request ends in the worker's raw branch (or in nothing),
 * so the client imports a broken profile. Two things were wrong that way:
 * `v2rayng` (the source matches `v2ray`) and a `shadowrocket` target the sources
 * do not implement at all — Shadowrocket reads the plain (base64) sub, so its
 * button must point at the raw link.
 *
 * The CFnew values below were read out of the source this repo ships
 * (`public/repo/worker-source.js`, also bundled as `nexus.js`): its sub handler
 * does `searchParams.get('target') || 'base64'`, lower-cases it, and matches it
 * against `clash | clashr | surge | surge2 | surge3 | surge4 | quantumult |
 * quanx | ss | ssr | v2ray | loon | singbox`. edgetunnel (cmliu) is the upstream
 * of that same target scheme; the zeus-style full panels (zeus, miliconfigzeus,
 * nova) issue a subscription per user inside their own dashboard and have no
 * deploy-time sub link at all.
 */

export type WorkerSourceKind = 'edgetunnel' | 'custom' | 'nexus' | 'zeus' | 'uuidpanel' | 'github'

/** worker_source id → routing model. Mirrors `WORKER_SOURCES` in worker/deploy.ts. */
export const WORKER_SOURCE_KIND: Record<string, WorkerSourceKind> = {
  edgetunnel: 'edgetunnel',
  edgetunnel_kv: 'edgetunnel',
  custom: 'custom',
  nexus: 'nexus',
  zeus: 'zeus',
  miliconfigzeus: 'zeus',
  nova: 'zeus',
  // Mili (miladjahani/Milios3.10.2) reads its admin path from `env.u`, so the
  // dashboard of a deployment really is `/<uuid>` — but its subscriptions are
  // issued per user inside the panel, so there is no deploy-time sub link.
  milios: 'uuidpanel',
  // miliconfigOS v3 (miladjahani/Miliconfigpro) — retired from the pickers when
  // Mili replaced it; the routing model stays so the deployments already on it
  // still render correct links.
  miliconfigosv3: 'uuidpanel',
  // "deploy any GitHub repo" — the repo's own app decides its routes, so there
  // is no known deploy-time panel/sub path to advertise.
  github: 'github',
}

/* * Routing model of a worker_source id.
 *
 * An id this build does not know is **not** silently read as edgetunnel: the
 * deploy engine refuses it outright, and this helper is used for display, so
 * the unknown id stays visible to the caller instead of being relabelled.
 */
export function workerSourceKind(workerSource?: string | null): WorkerSourceKind {
  return WORKER_SOURCE_KIND[workerSource ?? 'edgetunnel'] ?? 'edgetunnel'
}

/** True when `/<uuid>` really is the source's dashboard/sub path (CFnew only). */
export function uuidPathSource(workerSource?: string | null): boolean {
  const kind = workerSourceKind(workerSource)
  return kind === 'custom' || kind === 'nexus'
}

export interface ClientSubTarget {
  /** Button label. */
  label: string
  /** `target=` value the worker matches — `null` means "use the raw sub link". */
  target: string | null
}

const RAW_CLIENT: ClientSubTarget = { label: 'Shadowrocket', target: null }

/** cmliu-family target names (CFnew verified locally, edgetunnel inherits it). */
const CMLIU_TARGETS: ClientSubTarget[] = [
  { label: 'v2rayNG', target: 'v2ray' },
  { label: 'Clash', target: 'clash' },
  { label: 'Sing-Box', target: 'singbox' },
  { label: 'Surge', target: 'surge' },
  { label: 'Loon', target: 'loon' },
  { label: 'Quantumult X', target: 'quanx' },
  RAW_CLIENT,
]

export const SUB_TARGETS_BY_KIND: Record<WorkerSourceKind, ClientSubTarget[]> = {
  edgetunnel: CMLIU_TARGETS,
  custom: CMLIU_TARGETS,
  nexus: CMLIU_TARGETS,
  // Full panels hand out per-user subs from their own dashboard.
  zeus: [],
  uuidpanel: [],
  // An arbitrary GitHub worker: we do not know its sub scheme, so only the raw
  // link is offered (appending a `target=` the app does not implement would
  // hand the client a broken profile).
  github: [],
}

/** Client buttons that produce a working link for this source. */
export function subTargetsForSource(workerSource?: string | null): ClientSubTarget[] {
  return SUB_TARGETS_BY_KIND[workerSourceKind(workerSource)]
}

/**
 * Append a client's target to a sub link. The existing query string is kept
 * (edgetunnel sub links are `/sub?token=…`, so the separator must be `&`).
 */
export function buildClientSubUrl(subUrl: string, client: ClientSubTarget): string {
  if (!client.target) return subUrl
  const sep = subUrl.includes('?') ? '&' : '?'
  return `${subUrl}${sep}target=${client.target}`
}
