const CF_API = 'https://api.cloudflare.com/client/v4'

export async function cfApi(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const resp = await fetch(`${CF_API}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  })
  let data: Record<string, unknown> = {}
  try {
    data = (await resp.json()) as Record<string, unknown>
  } catch {
    /* non-JSON */
  }
  return { ok: resp.ok, status: resp.status, data }
}

export async function getAccountId(token: string): Promise<{ accountId: string | null; error?: string }> {
  const r = await cfApi(token, '/accounts?per_page=1')
  if (!r.ok) return { accountId: null, error: `توکن کلودفلر نامعتبر است (HTTP ${r.status})` }
  const accounts = r.data.result as Array<{ id: string }> | undefined
  if (!accounts?.length) return { accountId: null, error: 'هیچ اکانت کلودفلری برای این توکن پیدا نشد' }
  return { accountId: accounts[0].id }
}

// ── KV ─────────────────────────────────────────────────────────────────────

export async function kvGet(accountId: string, namespaceId: string, key: string, token: string): Promise<{ ok: boolean; status: number; text: string }> {
  const resp = await fetch(`${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const text = await resp.text().catch(() => '')
  return { ok: resp.ok, status: resp.status, text }
}

export async function kvPut(
  accountId: string,
  namespaceId: string,
  key: string,
  value: string,
  token: string,
  contentType = 'application/json',
): Promise<{ ok: boolean; status: number }> {
  const resp = await fetch(`${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: value,
  })
  return { ok: resp.ok, status: resp.status }
}

export async function createKvNamespace(token: string, accountId: string, title: string): Promise<{ id?: string; error?: string; logs: string[] }> {
  const logs: string[] = []
  // Reuse an existing namespace with the same title if present.
  const list = await cfApi(token, `/accounts/${accountId}/storage/kv/namespaces?per_page=100`)
  if (list.ok) {
    const existing = (list.data.result as Array<{ id: string; title: string }> | undefined)?.find((ns) => ns.title === title)
    if (existing) {
      logs.push(`✓ KV namespace موجود استفاده شد: ${title}`)
      return { id: existing.id, logs }
    }
  }
  const created = await cfApi(token, `/accounts/${accountId}/storage/kv/namespaces`, { method: 'POST', body: { title } })
  if (!created.ok) return { error: `ساخت KV namespace ناموفق بود (HTTP ${created.status})`, logs }
  const ns = created.data.result as { id: string } | undefined
  logs.push(`✓ KV namespace ساخته شد: ${title}`)
  return { id: ns?.id, logs }
}

// ── Worker upload (module worker via multipart) ────────────────────────────

export interface UploadOptions {
  token: string
  accountId: string
  name: string
  code: string
  kvNamespaceId?: string
  vars: Record<string, string>
}

export async function uploadWorker(opts: UploadOptions): Promise<{ ok: boolean; status: number; message?: string; logs: string[] }> {
  const logs: string[] = []
  const metadata: Record<string, unknown> = {
    main_module: 'worker.js',
    compatibility_date: '2025-01-01',
    compatibility_flags: ['nodejs_compat'],
    bindings: [
      ...Object.entries(opts.vars).map(([k, v]) => ({ type: 'plain_text', name: k, text: v })),
      ...(opts.kvNamespaceId ? [{ type: 'kv_namespace', name: 'KV', namespace_id: opts.kvNamespaceId }] : []),
    ],
  }

  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append('worker.js', new Blob([opts.code], { type: 'application/javascript+module' }), 'worker.js')

  const resp = await fetch(`${CF_API}/accounts/${opts.accountId}/workers/scripts/${opts.name}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${opts.token}` },
    body: form,
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    return { ok: false, status: resp.status, message: `آپلود ورکر ناموفق بود (HTTP ${resp.status}) ${text.slice(0, 300)}`, logs }
  }
  logs.push('✓ اسکریپت ورکر آپلود شد')
  return { ok: true, status: resp.status, logs }
}

export async function enableWorkersDev(token: string, accountId: string, name: string): Promise<boolean> {
  const r = await cfApi(token, `/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
    method: 'POST',
    body: { enabled: true },
  })
  return r.ok
}
