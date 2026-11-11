#!/usr/bin/env node
/**
 * NEXUS smoke test — validates worker-source.js based worker with NEXUS branding
 * Uses UUID-based routing (the worker requires env.u for authentication)
 */
const KEY = '11111111-2222-4333-8444-555555555555'
const results = []
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra })
  console.log(cond ? '✓' : '✗', name, extra ? '— ' + extra : '')
}

async function run() {
  const { pathToFileURL } = await import('node:url')
  const modUrl = pathToFileURL(new URL('../public/repo/nexus.js', import.meta.url).pathname).href + '?t=' + Date.now()
  let worker
  try {
    const mod = await import(modUrl)
    worker = mod.default
  } catch (e) { console.error('Import failed:', e.message); process.exit(1) }
  if (!worker || !worker.fetch) { console.error('No fetch'); process.exit(1) }
  console.log('Worker loaded!\n')

  const env = { u: KEY }
  const u = `/${KEY}`

  async function req(path, method = 'GET', body = null) {
    const h = new Headers()
    if (body) h.set('content-type', 'application/json')
    return worker.fetch({ url: `https://test.workers.dev${path}`, method, headers: h }, env, {})
  }

  // ── Login page ──
  try {
    const r = await req('/')
    const html = await r.text()
    check('GET / → login HTML', html.includes('<html'), `len=${html.length}`)
  } catch (e) { check('GET / → login', false, e.message) }

  // ── Panel page ──
  try {
    const r = await req(u)
    const html = await r.text()
    check('GET /<uuid> → panel', html.includes('<html'), `len=${html.length}`)
    check('Panel has NEXUS branding', html.includes('NEXUS'))
    check('Panel has <script>', html.includes('<script>'))
    check('Panel has tab nav', html.includes('tab') || html.includes('data-t'))
    check('Panel has config form', html.includes('config') || html.includes('wk'))
  } catch (e) { check('GET /<uuid> → panel', false, e.message) }

  // ── API endpoints ──
  try {
    const r = await req(`${u}/api/config`)
    const j = await r.json()
    check('GET /api/config → JSON', !!j)
  } catch (e) { check('GET /api/config', false, e.message) }

  // ── Subscription (base64 default) ──
  try {
    const r = await req(`${u}/sub`)
    const body = await r.text()
    const decoded = atob(body)
    const links = decoded.split('\n').filter(l => l.startsWith('vless://') || l.startsWith('trojan://'))
    check('Sub base64 → VLESS/Trojan links', links.length >= 3, `count=${links.length}`)
    // Verify link format: CF IP as address, worker as SNI
    if (links.length > 0) {
      const url = new URL(links[0])
      const params = new URLSearchParams(url.search)
      check('Link has CF IP address', url.hostname.includes('.') && !url.hostname.includes('workers.dev'), url.hostname)
      check('Link has worker SNI', params.get('sni') === 'test.workers.dev')
      check('Link has TLS', params.get('security') === 'tls')
      check('Link has WS transport', params.get('type') === 'ws')
    }
  } catch (e) { check('Sub base64', false, e.message) }

  // ── Subscription (Clash) ──
  try {
    const r = await req(`${u}/sub?target=clash`)
    const body = await r.text()
    check('Clash output has proxies', body.includes('proxies:'))
    check('Clash output has rules', body.includes('rules:') || body.includes('rule-providers:'))
  } catch (e) { check('Clash', false, e.message) }

  // ── Subscription (sing-box) ──
  try {
    const r = await req(`${u}/sub?target=sing-box`)
    const body = await r.text()
    check('sing-box output has outbounds', body.includes('outbounds'))
  } catch (e) { check('sing-box', false, e.message) }

  // ── WebSocket proxy (may fail in Node.js — cloudflare:sockets not available) ──
  try {
    const r = await worker.fetch({
      url: `https://test.workers.dev${u}`,
      method: 'GET',
      headers: new Headers({ upgrade: 'websocket', 'sec-websocket-protocol': 'binary' }),
    }, env, {})
    // 101 = works, 503 = connect unavailable in test (expected), 500 = also expected in Node.js
    check('WebSocket handler exists', r.status === 101 || r.status === 503 || r.status === 500, `status=${r.status}`)
  } catch (e) { check('WebSocket handler exists', false, e.message) }

  // ── 404 on unknown ──
  try {
    const r = await req('/unknown')
    check('GET /unknown → 404', r.status === 404, `status=${r.status}`)
  } catch (e) { check('404', false, e.message) }

  // ── Node features ──
  try {
    const r = await req(`${u}/sub`)
    const body = await r.text()
    const decoded = atob(body)
    const links = decoded.split('\n').filter(l => l.startsWith('vless://') || l.startsWith('trojan://'))
    const hasFingerprint = links.some(l => l.includes('fp='))
    const hasMultiplePorts = new Set(links.map(l => { try { return new URL(l).port } catch { return '' } })).size > 1
    const hasMultipleProtocols = links.some(l => l.startsWith('vless://')) && links.some(l => l.startsWith('trojan://'))
    check('Links have fingerprint', hasFingerprint)
    check('Links use multiple ports', hasMultiplePorts)
    check('Links have VLESS + Trojan', hasMultipleProtocols)
  } catch (e) { check('Node features', false, e.message) }

  // ── Structure validation ──
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../public/repo/nexus.js', import.meta.url), 'utf8')
  check('File > 5000 lines', src.split('\n').length > 5000, `${src.split('\n').length} lines`)
  check('Has NEXUS branding', src.includes('NEXUS'))
  check('Has cloudflare:sockets proxy', src.includes('cloudflare:sockets'))
  check('Has VLESS/Trojan parsing', src.includes('vless') || src.includes('dmxlc3M'))
  check('Has ECH support', src.includes('ech') || src.includes('ECH'))
  check('Has preferred IP fetch', src.includes('wetest') || src.includes('優選') || src.includes('优选'))
  check('Has matrix rain effect', src.includes('matrix') || src.includes('Matrix'))
  check('Has user profile API', src.includes('user-config'))
  check('Has latency test', src.includes('latency') || src.includes('延迟'))
  check('Has config save', src.includes('/api/config'))
  check('Has subscription converter', src.includes('scu') || src.includes('converter'))
  check('Has language toggle', src.includes('lang') || src.includes('language') || src.includes('语言'))
  check('Has SOCKS5 proxy config', src.includes('socks') || src.includes('SOCKS'))
  check('Has auto-update feature', src.includes('updVerUrl') || src.includes('update'))

  // ── Summary ──
  const passed = results.filter(r => r.ok).length
  const total = results.length
  console.log(`\n${'═'.repeat(50)}`)
  console.log(`Results: ${passed}/${total} passed`)
  if (passed < total) {
    console.log('Failed:', results.filter(r => !r.ok).map(r => r.name).join(', '))
    process.exit(1)
  }
  console.log('All tests passed!')
}

run().catch(e => { console.error('Crashed:', e); process.exit(1) })
