/**
 * Cloudflare API-token permissions this panel needs, plus the template URL that
 * pre-fills them in the dashboard.
 *
 * Every key/type pair below is taken from the list Cloudflare documents for
 * template URLs
 * (developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/):
 *
 *   [{ "key": "permission_name", "type": "read|edit|revoke|run|purge" }]
 *
 * and the keys themselves are the ones in that page's permission reference
 * table. Two rules follow from it, and both used to be broken here:
 *
 *   • A key that is not in the reference table is simply not applied by the
 *     dashboard, so the token silently comes out without that permission —
 *     which is how a user ended up with a token that could not read Workers KV
 *     (`user_details`, `dns_records`, `cache_purge`, `account` and
 *     `ssl_and_certificate` no longer exist as keys; the real ones are
 *     `account_settings`, `dns`, `cache`, `ssl_and_certificates`).
 *   • `read` and `edit` are separate permission groups. The panel both reads
 *     and writes the same resources (KV namespaces are *listed* before they are
 *     written, Pages projects and D1 databases are read back after creation),
 *     so those keys are requested twice — once per type — exactly like
 *     Cloudflare's own examples do for DNS.
 *
 * The deployed workers need: scripts + KV + routes + R2 + D1 + Pages. The panel
 * itself additionally needs zone settings (gRPC/WebSockets are switched on for
 * the grpc/xhttp transports), zone/DNS/SSL/cache for custom domains, account
 * settings/analytics for the account view, and API-token management for the
 * token screens, which read the live token list from Cloudflare.
 */

export type CfPermissionType = 'read' | 'edit' | 'revoke' | 'run' | 'purge'

export interface CfPermission {
  /** Permission key from Cloudflare's template reference table. */
  key: string
  type: CfPermissionType
}

/** Name pre-filled in the dashboard's "Token name" field. */
export const CF_TOKEN_NAME = 'Miliconfig-Pro'

export const CF_TOKEN_PERMISSIONS: CfPermission[] = [
  // ── Workers + storage (what a deployment is made of) ─────────────────────
  { key: 'workers_scripts', type: 'read' },
  { key: 'workers_scripts', type: 'edit' },
  { key: 'workers_kv_storage', type: 'read' },
  { key: 'workers_kv_storage', type: 'edit' },
  { key: 'workers_routes', type: 'edit' },
  { key: 'workers_r2', type: 'read' },
  { key: 'workers_r2', type: 'edit' },
  { key: 'd1', type: 'read' },
  { key: 'd1', type: 'edit' },
  { key: 'page', type: 'read' },
  { key: 'page', type: 'edit' },
  // ── Zone: settings the workers need, records/certificates for domains ────
  { key: 'zone', type: 'read' },
  { key: 'zone_settings', type: 'read' },
  { key: 'zone_settings', type: 'edit' },
  { key: 'dns', type: 'read' },
  { key: 'dns', type: 'edit' },
  { key: 'ssl_and_certificates', type: 'edit' },
  { key: 'cache', type: 'purge' },
  // ── Account: the account view + token management ────────────────────────
  { key: 'account_settings', type: 'read' },
  { key: 'account_analytics', type: 'read' },
  { key: 'account_api_tokens', type: 'read' },
]

/** Human labels for the permission chips shown in the UI. */
const PERMISSION_NAMES: Record<string, string> = {
  workers_scripts: 'Workers Scripts',
  workers_kv_storage: 'Workers KV Storage',
  workers_routes: 'Workers Routes',
  workers_r2: 'Workers R2 Storage',
  d1: 'D1',
  page: 'Cloudflare Pages',
  zone: 'Zone',
  zone_settings: 'Zone Settings',
  dns: 'DNS',
  ssl_and_certificates: 'SSL and Certificates',
  cache: 'Cache',
  account_settings: 'Account Settings',
  account_analytics: 'Account Analytics',
  account_api_tokens: 'API Tokens',
}

const TYPE_LABELS: Record<CfPermissionType, string> = {
  read: 'Read',
  edit: 'Edit',
  revoke: 'Revoke',
  run: 'Run',
  purge: 'Purge',
}

/**
 * The permission list as display strings (`Workers KV Storage:Read+Edit`), in
 * the same order as {@link CF_TOKEN_PERMISSIONS}, one entry per key.
 */
export function cfPermissionLabels(): string[] {
  const grouped = new Map<string, CfPermissionType[]>()
  for (const perm of CF_TOKEN_PERMISSIONS) {
    const types = grouped.get(perm.key) ?? []
    types.push(perm.type)
    grouped.set(perm.key, types)
  }
  const labels: string[] = []
  for (const [key, types] of grouped) {
    const name = PERMISSION_NAMES[key] ?? key
    labels.push(`${name}:${types.map((t) => TYPE_LABELS[t]).join('+')}`)
  }
  return labels
}

/** Number of permission groups the template asks Cloudflare for. */
export function cfPermissionKeyCount(): number {
  return new Set(CF_TOKEN_PERMISSIONS.map((p) => p.key)).size
}

/**
 * User-scoped API-token template URL — opens the dashboard's "Create Token" page
 * with every permission above already selected, so a user only has to press
 * "Continue to summary" → "Create Token".
 *
 * `accountId=*` / `zoneId=all` keep the template valid for whichever account the
 * user picks; the panel discovers the real account id from the token itself.
 */
export function buildCfTokenUrl(): string {
  const encoded = encodeURIComponent(JSON.stringify(CF_TOKEN_PERMISSIONS))
  return (
    'https://dash.cloudflare.com/profile/api-tokens' +
    `?permissionGroupKeys=${encoded}` +
    '&accountId=*' +
    '&zoneId=all' +
    `&name=${encodeURIComponent(CF_TOKEN_NAME)}`
  )
}
