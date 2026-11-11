/**
 * Comprehensive verification test for Zero-1101 first-time deployment, cold-start
 * optimization, D1 schema pre-seeding, subrequest budget protection, and auth security.
 */
import { optimizeWorkerSourceForColdStart, runDeployment, uploadPagesDeployment, type DeployJob } from '../worker/deploy'
import { ensureSchema } from '../worker/schema'
import { edgetunnelSubToken, hashPassword, verifyPassword, timingSafeEqualStr } from '../worker/util'
import { handleLogin } from '../worker/auth'
import { gitBlobSha1 } from '../worker/source-verify'
import { renderProgressBar, diagnoseDeployError } from '../worker/telegram-core'
import type { Env } from '../worker/env'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 1. Per-deployment polymorphic edgetunnel-method obfuscator & cold-start optimizer ──
console.log('\n── ۱) مبهم‌ساز چندریختی به روش edgetunnel (منحصربه‌فرد برای هر استقرار + حذف کامل Error 1101) ──')
{
  const terserSample = `const n=["${Buffer.from('vless://hello-mili').map((b, i) => b ^ ((90 + 31 * i) & 255)).toString('base64')}"],e=Object.create(null);function t(t){if(void 0!==e[t])return e[t];const a=atob(n[t]),r=new Uint8Array(a.length);for(let n=0;n<a.length;n++)r[n]=a.charCodeAt(n)^90+31*n&255;const o=(new TextDecoder).decode(r);return e[t]=o,o}export const out=t(0);`
  const optimized1 = optimizeWorkerSourceForColdStart(terserSample)
  const optimized2 = optimizeWorkerSourceForColdStart(terserSample)
  check('Terser-minified Mili vault is re-keyed polymorphically (never exposed as plaintext)', !optimized1.includes('vless://hello-mili') && !optimized1.includes('^90+31*'))
  check('Two deployments produce 100% unique obfuscated code', optimized1 !== optimized2)
  const fn = new Function(optimized1.replace(/export const out=t\(0\);[\s\S]*$/, 'return t(0);'))
  check('Polymorphic decoder produces exact original plaintext at runtime', fn() === 'vless://hello-mili', String(fn()))

  const edgeSample = `const 基础64文本解码器 = new TextDecoder();
function 解码64(文本) {
  const 二进制 = atob(文本);
  const 字节 = new Uint8Array(二进制.length);
  for (let 索引 = 0; 索引 < 二进制.length; 索引++) 字节[索引] = 二进制.charCodeAt(索引);
  return 基础64文本解码器.decode(字节);
}
const proto = 解码64('dmxlc3M=');
const plain = 'trojan://secret';
export const res = proto + ':' + plain;`
  const edgeObf1 = optimizeWorkerSourceForColdStart(edgeSample)
  const edgeObf2 = optimizeWorkerSourceForColdStart(edgeSample)
  check('edgetunnel 解码64 literals and plain sensitive literals are encrypted with unique per-deploy keys', !edgeObf1.includes('dmxlc3M=') && !edgeObf1.includes('trojan://secret') && edgeObf1 !== edgeObf2)
  const edgeFn = new Function(edgeObf1.replace(/export const res = [\s\S]*$/, 'return proto + ":" + plain;'))
  check('edgetunnel polymorphic runtime decodes exact strings with O(1) cache', edgeFn() === 'vless:trojan://secret', String(edgeFn()))

  const nexusSample = `let 连接 = null;\ntry { 连接 = (await import("cloudflare:sockets")).connect; } catch {}\nexport default {}`
  const optNexus = optimizeWorkerSourceForColdStart(nexusSample)
  check('NEXUS top-level await is converted to static cloudflare:sockets import', !optNexus.includes('await import("cloudflare:sockets")') && optNexus.includes("import { connect as 连接 } from 'cloudflare:sockets';"))
  check('Telegram progress bar renders animated blocks', renderProgressBar(60).includes('██████░░░░'))
  check('Smart Error Alert diagnoses token/D1/1101 errors', diagnoseDeployError('invalid cloudflare token').includes('Edit Cloudflare Workers'))
}

// ── 2. Pages _worker.bundle compatibility_flags ──────────────────────────────
console.log('\n── ۲) ارسال compatibility_flags در متادیتای Pages (_worker.bundle) ──')
{
  const realFetch = globalThis.fetch
  let capturedBundleText = ''
  // @ts-expect-error test shim
  globalThis.fetch = async (_url: any, init?: any) => {
    const form = init?.body as FormData
    const bundle = form?.get('_worker.bundle') as Blob
    if (bundle) capturedBundleText = await bundle.text()
    return new Response(JSON.stringify({ success: true, result: { url: 'https://test.pages.dev' } }), { status: 200 })
  }
  const res = await uploadPagesDeployment('acct-1', 'proj-1', 'export default {}', { Authorization: 'Bearer x' }, '2026-07-30', ['nodejs_compat'])
  globalThis.fetch = realFetch
  check('Pages upload succeeded', res.ok === true)
  check('_worker.bundle metadata includes compatibility_flags', capturedBundleText.includes('"compatibility_flags":["nodejs_compat"]'))
}

// ── 3. Deployer own D1 schema bootstrap (batch + zero redundant ALTERs) ──────
console.log('\n── ۳) راه‌اندازی اولیه دیتابیس خود استقرارکننده با یک Batch (بدون ۷۴ کوئری ترتیبی) ──')
{
  let batchCalls = 0
  let alterCalls = 0
  const fakeEnv = {
    DB: {
      batch: async (stmts: unknown[]) => {
        batchCalls += 1
        return stmts
      },
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => null,
          run: async () => {
            if (/^\s*ALTER\s+TABLE/i.test(sql)) alterCalls++
            return { meta: { changes: 1 } }
          },
        }),
        first: async () => null,
        run: async () => {
          if (/^\s*ALTER\s+TABLE/i.test(sql)) alterCalls++
          return { meta: { changes: 1 } }
        },
      }),
    },
  } as unknown as Env
  await ensureSchema(fakeEnv)
  check('Fresh database uses single DB.batch() call for all tables/indexes', batchCalls === 1, `batchCalls=${batchCalls}`)
  check('Fresh database skips all 40 legacy ALTER TABLE statements', alterCalls === 0, `alterCalls=${alterCalls}`)
}

// ── 4. Mili D1 pre-seeding + 3-zone cap in runDeployment ─────────────────────
console.log('\n── ۴) پیش‌ساخت جداول ۶گانه D1 برای پنل میلی و رعایت سقف ۵۰ ساب‌ریکوئست ──')
{
  const realFetch = globalThis.fetch
  const miliSource = `// MILICONFIG fixture\nimport { connect } from 'cloudflare:sockets';\nexport default { async fetch() { return new Response('ok'); } }\n` + 'x'.repeat(1200)
  let d1SqlQueries: string[] = []
  let zonePatchCalls = 0
  // @ts-expect-error test shim
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
    if (/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\//.test(url)) return json({ sha: '1111222233334444555566667777888899990000' })
    if (/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\//.test(url)) {
      return json({ sha: await gitBlobSha1(miliSource), size: new TextEncoder().encode(miliSource).length, type: 'file' })
    }
    if (url.startsWith('https://raw.githubusercontent.com/')) return new Response(miliSource, { status: 200 })
    if (url.endsWith('/user/tokens/verify')) return json({ success: true })
    if (/\/accounts\?per_page=50$/.test(url)) return json({ success: true, result: [{ id: 'acct-1', name: 'Acct' }] })
    if (method === 'POST' && /\/d1\/database$/.test(url)) return json({ success: true, result: { uuid: 'db-mili-1' } })
    if (/\/d1\/database\/db-mili-1\/query$/.test(url)) {
      const body = JSON.parse(String(init?.body ?? '{}'))
      d1SqlQueries.push(String(body.sql ?? ''))
      return json({ success: true, result: [{ success: true }] })
    }
    if (/\/r2\/buckets/.test(url)) return json({ success: true, result: { name: 'r2-1' } })
    if (/\/workers\/scripts\/[^/]+$/.test(url)) return json({ success: method !== 'GET' }, method === 'GET' ? 404 : 200)
    if (/\/workers\/scripts\/[^/]+\/(subdomain|settings)$/.test(url)) return json({ success: true })
    if (/\/zones\?per_page=50$/.test(url)) {
      // Return 20 zones to verify the engine caps patches at 3 zones (6 subrequests)
      return json({ success: true, result: Array.from({ length: 20 }, (_, i) => ({ id: `z-${i}`, name: `z${i}.com` })) })
    }
    if (/\/zones\/[^/]+\/settings\/(grpc|websockets)$/.test(url)) {
      zonePatchCalls++
      return json({ success: true })
    }
    if (url.endsWith('/workers/subdomain')) return json({ success: true, result: { subdomain: 'sub1' } })
    if (/^https:\/\/[^/]+\.workers\.dev/.test(url)) return new Response('ok', { status: 200 })
    return json({ success: true })
  }

  const rows = new Map<string, any>([
    ['dep-mili', { id: 'dep-mili', user_id: 'u1', name: 'mili-test', uuid: '11111111-2222-3333-4444-555555555555', status: 'deploying', method: 'workers', worker_source: 'milios', config: '{}', logs: '' }],
  ])
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: any[]) => ({
          first: async () => rows.get('dep-mili') ?? null,
          run: async () => {
            if (sql.startsWith('UPDATE deployments SET status =')) {
              rows.get('dep-mili').status = binds[0]
            }
            return { meta: { changes: 1 } }
          },
        }),
      }),
    },
  } as unknown as Env

  const job: DeployJob = {
    deployment_id: 'dep-mili',
    worker_name: 'mili-test',
    cf_token: 'tok',
    uuid: '11111111-2222-3333-4444-555555555555',
    method: 'workers',
    worker_source: 'milios',
    origin: 'https://panel.example',
    retried_on_pages: true,
  }
  await runDeployment(env, job)
  globalThis.fetch = realFetch

  check('Mili D1 schema was pre-seeded before first worker request', d1SqlQueries.length === 1 && d1SqlQueries[0].includes('CREATE TABLE IF NOT EXISTS preferred_nodes'))
  check('Zone settings loop capped at 3 zones (6 PATCH calls instead of 40)', zonePatchCalls === 6, `zonePatchCalls=${zonePatchCalls}`)
  check('Mili deployment succeeded on first attempt', rows.get('dep-mili')?.status === 'deployed')
}

// ── 5. Security & Crypto Helpers ─────────────────────────────────────────────
console.log('\n── ۵) بررسی‌های امنیتی (PBKDF2، MD5، مقایسه زمان‌ثابت و ضد بروت‌فورس) ──')
{
  const h = await hashPassword('MySecretPass!123')
  check('New password hash uses 60,000 PBKDF2 iterations (safe under 10ms CPU limit)', h.startsWith('pbkdf2$60000$'))
  check('verifyPassword validates correct password', await verifyPassword('MySecretPass!123', h))
  check('verifyPassword rejects wrong password', !(await verifyPassword('WrongPass', h)))
  check('timingSafeEqualStr matches identical strings and rejects different ones', timingSafeEqualStr('abc123', 'abc123') && !timingSafeEqualStr('abc123', 'abc124'))
  const subTok = await edgetunnelSubToken('test.workers.dev', '11111111-2222-3333-4444-555555555555')
  check('edgetunnelSubToken works in Node/WebCrypto via MD5 fallback', /^[0-9a-f]{32}$/.test(subTok), subTok)

  // Brute-force login rate limiter check
  const fakeAuthEnv = {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
        }),
      }),
    },
  } as unknown as Env
  let lastStatus = 200
  for (let i = 0; i < 11; i++) {
    const req = new Request('https://panel.example/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.77' },
      body: JSON.stringify({ email: 'attacker@example.com', password: 'bad' }),
    })
    const resp = await handleLogin(fakeAuthEnv, req)
    lastStatus = resp.status
  }
  check('Brute-force login rate limiter blocks 11th failed attempt from same IP with HTTP 429', lastStatus === 429, `status=${lastStatus}`)
}

console.log(failures === 0 ? '\n✅ تمام بررسی‌های ضد ۱۱۰۱ و امنیتی با موفقیت پاس شدند.' : `\n❌ ${failures} بررسی ناموفق بود.`)
process.exit(failures === 0 ? 0 : 1)
