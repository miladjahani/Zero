/**
 * Smoke test for worker/source-verify.ts — the gate that stops a half-downloaded
 * (or otherwise wrong) worker file from ever reaching Cloudflare.
 *
 * It pins the three things that matter:
 *   • our git blob hash really is git's object id (compared against a hash
 *     produced by `git hash-object` itself), because that is the number GitHub
 *     publishes and the number the checksum comparison uses;
 *   • a file whose bytes do not match the published revision is **rejected** —
 *     verified with a stubbed GitHub API that answers with the true size/hash of
 *     the complete file while the download is torn in half;
 *   • when GitHub cannot vouch for the bytes (the panel-bundled copy, a mirror,
 *     an unreachable API) a broken file is still rejected locally, and a
 *     complete one is accepted *as unverified* rather than silently trusted.
 *
 * The last section runs against the live repository when the network is
 * available (skipped, not failed, when it is not): real upstream file, real
 * published blob hash.
 */
import {
  commitPinnedRawUrl,
  gitBlobSha1,
  parseRawGithubUrl,
  sha256Hex,
  verifyWorkerSource,
  MIN_WORKER_SOURCE_BYTES,
  type RawGithubRef,
} from '../worker/source-verify'

/** The real fetch, kept before the stubs below take over the global. */
const realFetch = globalThis.fetch

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const bytes = (text: string): number => new TextEncoder().encode(text).length

/** A complete, realistic module worker (~4 KB so a tear in half keeps size). */
function makeSource(helpers = 80): string {
  // The entry point comes first, so a tear in the middle leaves a file that
  // still *looks* like a worker and can only be caught by the checksum — which
  // is exactly the failure mode the old size+marker screen missed.
  const lines = ['// worker source — smoke fixture', "const NAME = 'fixture'"]
  lines.push('export default {')
  lines.push('  async fetch(request) {')
  lines.push("    return new Response(NAME + new URL(request.url).pathname, { headers: { 'content-type': 'text/plain' } })")
  lines.push('  },')
  lines.push('}')
  for (let i = 0; i < helpers; i++) lines.push(`function helper${i}(value) { return value + ${i} * ${helpers} }`)
  return lines.join('\n') + '\n'
}

const GOOD = makeSource()
const TORN = GOOD.slice(0, Math.floor(GOOD.length * 0.55))
const ref: RawGithubRef = { owner: 'panel-zeus', repo: 'Z-E-U-S', branch: 'main', path: 'Source.js' }

/** Stub the GitHub contents API with the true metadata of a given text. */
function stubChecksumApi(meta: { sha: string; size: number } | null, mode: 'ok' | 'down' = 'ok'): void {
  globalThis.fetch = (async (input: any) => {
    if (mode === 'down') throw new Error('network down')
    if (!String(input).includes('/contents/')) throw new Error(`unexpected fetch ${input}`)
    return new Response(JSON.stringify(meta ? { ...meta, type: 'file' } : {}), {
      status: meta ? 200 : 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

async function main(): Promise<void> {
  console.log('\n── git object id ──')
  // `printf 'hello world\n' | git hash-object --stdin`
  const hello = await gitBlobSha1('hello world\n')
  check('sha1 blob hash matches git hash-object', hello === '3b18e512dba79e4c8300dd08aeb37f8e728b8dad', hello)
  check(
    'sha256 of the empty string is the well-known digest',
    (await sha256Hex('')) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )

  console.log('\n── URL parsing ──')
  const parsed = parseRawGithubUrl('https://raw.githubusercontent.com/IRNova/Nova-Proxy/main/worker.js')
  check(
    'raw GitHub URL → owner/repo/branch/path',
    parsed?.owner === 'IRNova' && parsed?.repo === 'Nova-Proxy' && parsed?.branch === 'main' && parsed?.path === 'worker.js',
    JSON.stringify(parsed),
  )
  const nested = parseRawGithubUrl('https://raw.githubusercontent.com/miladjahani/miliconfigpro-v1/main/public/repo/nexus.js')
  check('nested path is kept whole', nested?.path === 'public/repo/nexus.js', nested?.path ?? '')
  check('the bundled copy is not a GitHub file', parseRawGithubUrl('/repo/nexus.js') === null)
  check('another host is not a GitHub file', parseRawGithubUrl('https://example.com/owner/repo/main/x.js') === null)
  check(
    'pinned URL points at the commit',
    parsed ? commitPinnedRawUrl(parsed, 'abc123') === 'https://raw.githubusercontent.com/IRNova/Nova-Proxy/abc123/worker.js' : false,
  )

  console.log('\n── checksum verification (stubbed upstream) ──')
  stubChecksumApi({ sha: await gitBlobSha1(GOOD), size: bytes(GOOD) })
  const good = await verifyWorkerSource(GOOD, { ref })
  check('a matching file passes and is marked checksum-verified', good.ok && good.checksumVerified, good.reason ?? '')
  check('the verified revision is reported back', good.commitSha === 'main' && good.blobSha === (await gitBlobSha1(GOOD)))

  stubChecksumApi({ sha: await gitBlobSha1(GOOD), size: bytes(GOOD) })
  const torn = await verifyWorkerSource(TORN, { ref })
  check('a torn download is rejected even though upstream is reachable', !torn.ok, torn.reason ?? 'accepted!')
  check('the rejection names the checksum', (torn.reason ?? '').includes('چک‌سام'), torn.reason ?? '')
  check('a rejected file is never marked verified', !torn.checksumVerified)

  stubChecksumApi({ sha: await gitBlobSha1(GOOD), size: bytes(GOOD) - 3 })
  const sizeMismatch = await verifyWorkerSource(GOOD, { ref })
  check('a size that does not match the published one is rejected too', !sizeMismatch.ok)

  console.log('\n── unverified copies (no published checksum) ──')
  stubChecksumApi(null, 'down')
  const offlineTorn = await verifyWorkerSource(TORN, { ref })
  check('an unreachable API does not turn a torn file into an acceptable one', !offlineTorn.ok, offlineTorn.reason ?? 'accepted!')
  check('that rejection is explained, not silently accepted', (offlineTorn.reason ?? '').length > 0)

  const bundled = await verifyWorkerSource(GOOD, { ref: null })
  check('a complete bundled copy is accepted, flagged unverified', bundled.ok && !bundled.checksumVerified)
  check('and it says so, so the deploy log can report it', typeof bundled.note === 'string' && bundled.note.length > 0)

  const html = await verifyWorkerSource('<html><body>404 not found</body></html>'.repeat(80), { ref: null })
  check('an error page served as 200 is rejected', !html.ok, html.reason ?? 'accepted!')

  const tiny = await verifyWorkerSource('export default {}', { ref: null })
  check(`a file under ${MIN_WORKER_SOURCE_BYTES} bytes is rejected`, !tiny.ok, tiny.reason ?? 'accepted!')

  console.log('\n── live upstream (skipped without network) ──')
  try {
    // The stubs above own the global; the live check must use the real one.
    globalThis.fetch = realFetch
    const url = 'https://raw.githubusercontent.com/IRNova/Nova-Proxy/main/worker.js'
    const realRef = parseRawGithubUrl(url)
    const resp = await realFetch(url)
    const code = await resp.text()
    if (!resp.ok || !code.length) {
      console.log('  ⚠ skipped — upstream not reachable from this environment')
    } else {
      const live = await verifyWorkerSource(code, { ref: realRef })
      check(
        `the real ${realRef?.repo}/${realRef?.path} verifies against GitHub's published blob hash`,
        live.ok && live.checksumVerified,
        live.reason ?? `sha ${live.blobSha?.slice(0, 10)}…`,
      )
      check('and its size is the published size', live.bytes === bytes(code), `${live.bytes} bytes`)
    }
  } catch (err) {
    console.log(`  ⚠ skipped — ${err instanceof Error ? err.message : 'network error'}`)
  }

  console.log(failures ? `\n${failures} بررسی ناموفق ❌` : '\nهمهٔ بررسی‌ها موفق ✅')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error('smoke run crashed:', err)
  process.exit(1)
})
