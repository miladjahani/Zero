/**
 * Pure unit checks for the "deploy any GitHub repository" URL handling
 * (shared/github-source.ts) and for the wrangler-config reader the deploy
 * engine uses to find a repo's entry file.
 *
 * These are the parts that decide *which file* gets deployed, so they are
 * pinned here: a URL shape that parsed wrongly would deploy the wrong file from
 * the right repository, which is exactly the class of bug this feature exists
 * to avoid.
 *
 * Run: bun scripts/smoke-github-source.ts
 */
import {
  GITHUB_ENTRY_CANDIDATES,
  WRANGLER_CONFIG_FILES,
  githubRepoLabel,
  githubUrlNamesFile,
  isWorkerEntryPath,
  parseGithubSourceUrl,
  rawGithubFileUrl,
} from '../shared/github-source'
import { parseWranglerHints } from '../worker/deploy'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Parse and assert success, returning the ref. */
function ok(input: string) {
  const parsed = parseGithubSourceUrl(input)
  if (!parsed.ok) throw new Error(`expected ${input} to parse, got: ${parsed.error}`)
  return parsed
}

function rejected(input: string): string {
  const parsed = parseGithubSourceUrl(input)
  if (parsed.ok) throw new Error(`expected ${input} to be rejected`)
  return parsed.error
}

console.log('\n── accepted URL shapes ──')
{
  const repo = ok('https://github.com/owner/repo')
  check('a plain repo URL resolves the repo', repo.ok && repo.source === 'repo' && repo.ref.owner === 'owner' && repo.ref.repo === 'repo')
  check('with no branch and no path', repo.ok && repo.ref.branch === '' && repo.ref.path === '')

  const withSlash = ok('https://github.com/owner/repo/')
  check('a trailing slash is tolerated', withSlash.ok && withSlash.ref.repo === 'repo')

  const gitSuffix = ok('https://github.com/owner/repo.git')
  check('a .git suffix is stripped', gitSuffix.ok && gitSuffix.ref.repo === 'repo')

  const blob = ok('https://github.com/owner/repo/blob/main/worker.js')
  check('a blob URL yields branch + path', blob.ok && blob.source === 'blob' && blob.ref.branch === 'main' && blob.ref.path === 'worker.js')

  const nested = ok('https://github.com/owner/repo/blob/dev/src/edge/worker.ts')
  check('a nested path is preserved', nested.ok && nested.ref.path === 'src/edge/worker.ts')

  const tree = ok('https://github.com/owner/repo/tree/develop/workers/api')
  check('a tree URL is a repo/dir reference', tree.ok && tree.source === 'repo' && tree.ref.branch === 'develop' && tree.ref.path === 'workers/api')

  const raw = ok('https://raw.githubusercontent.com/owner/repo/main/dist/index.js')
  check('a raw URL yields branch + path', raw.ok && raw.source === 'raw' && raw.ref.path === 'dist/index.js')

  const shorthand = ok('owner/repo')
  check('the owner/repo shorthand works', shorthand.ok && shorthand.ref.owner === 'owner')

  const noScheme = ok('github.com/owner/repo/blob/main/_worker.js')
  check('a scheme-less github.com URL works', noScheme.ok && noScheme.ref.path === '_worker.js')

  const branchWithSlash = ok('https://github.com/owner/repo/blob/feat/new-stuff/worker.js')
  check('a branch containing a slash keeps the file path intact', branchWithSlash.ok && branchWithSlash.ref.branch === 'feat' && branchWithSlash.ref.path === 'new-stuff/worker.js')

  const encoded = ok('https://github.com/owner/repo/blob/main/src/my%20worker.js')
  check('percent-encoded paths are decoded', encoded.ok && encoded.ref.path === 'src/my worker.js')
}

console.log('\n── rejected inputs ──')
{
  check('an empty value is refused', rejected('').includes('وارد کنید'))
  check('a non-GitHub host is refused', rejected('https://gitlab.com/owner/repo').includes('github.com'))
  check('a gist is refused', rejected('https://gist.github.com/owner/1234').includes('github.com') || rejected('https://gist.github.com/owner/1234').length > 0)
  check('a non-source GitHub page is refused', rejected('https://github.com/owner/repo/issues/3').includes('کد مخزن'))
  check('a bare owner without a repo is refused', rejected('https://github.com/owner').includes('owner'))
  check('a malformed URL is refused', rejected('https://').length > 0)
  check('a raw URL without a file is refused', rejected('https://raw.githubusercontent.com/owner/repo/main').includes('نام فایل'))
}

console.log('\n── raw URL + labels ──')
{
  const ref = ok('https://github.com/owner/repo/blob/main/worker.js')
  if (!ref.ok) throw new Error('unreachable')
  check('rawGithubFileUrl pins branch and path',
    rawGithubFileUrl(ref.ref, 'worker.js') === 'https://raw.githubusercontent.com/owner/repo/main/worker.js',
    rawGithubFileUrl(ref.ref, 'worker.js'))
  check('a leading slash in the path is normalised',
    rawGithubFileUrl(ref.ref, '/dist/worker.js') === 'https://raw.githubusercontent.com/owner/repo/main/dist/worker.js')
  check('the label is owner/repo', githubRepoLabel(ref.ref) === 'owner/repo')

  const tree = ok('https://github.com/owner/repo/tree/main')
  check('a repo-level URL does not claim to name a file', githubUrlNamesFile(tree) === false)
  const explicit = ok('https://github.com/owner/repo/blob/main/worker.js')
  check('a blob URL with a JS file does name one', githubUrlNamesFile(explicit) === true)
  const tsFile = ok('https://github.com/owner/repo/blob/main/src/index.ts')
  check('a TypeScript blob counts as a file (built output is expected)', githubUrlNamesFile(tsFile) === true)
  check('README is not a worker entry', githubUrlNamesFile(ok('https://github.com/owner/repo/blob/main/README.md')) === false)
}

console.log('\n── entry paths + candidate list ──')
{
  check('a single-file worker counts', isWorkerEntryPath('_worker.js') && isWorkerEntryPath('src/index.mjs'))
  check('a markdown file does not', !isWorkerEntryPath('README.md'))
  check('the candidate list starts with the Cloudflare conventions',
    GITHUB_ENTRY_CANDIDATES[0] === '_worker.js' && GITHUB_ENTRY_CANDIDATES.includes('worker.js'))
  check('every candidate is a JS/TS module', GITHUB_ENTRY_CANDIDATES.every(isWorkerEntryPath))
  check('all three wrangler config flavours are read', WRANGLER_CONFIG_FILES.length === 3 && WRANGLER_CONFIG_FILES[0] === 'wrangler.toml')
}

console.log('\n── wrangler config hints ──')
{
  const toml = parseWranglerHints([
    'name = "my-worker"',
    'main = "src/entry.js"',
    'compatibility_date = "2026-07-30"',
    'compatibility_flags = ["nodejs_compat", "global_fetch_strictly_public"]',
  ].join('\n'))
  check('toml main is read', toml.main === 'src/entry.js', toml.main)
  check('toml compat date is read', toml.compatDate === '2026-07-30', toml.compatDate)
  check('toml compat flags are read', toml.compatFlags?.length === 2 && toml.compatFlags[0] === 'nodejs_compat', JSON.stringify(toml.compatFlags))

  const jsonc = parseWranglerHints(`{
  // a comment JSONC allows
  "name": "nova-like",
  "main": "worker.js",
  "compatibility_date": "2026-07-30",
  "compatibility_flags": ["nodejs_compat"]
}`)
  check('jsonc main is read past comments', jsonc.main === 'worker.js', jsonc.main)
  check('jsonc compat flags are read', jsonc.compatFlags?.join(',') === 'nodejs_compat', JSON.stringify(jsonc.compatFlags))

  check('an empty config yields nothing', Object.keys(parseWranglerHints('')).length === 0)
  check('an unparseable config yields nothing instead of throwing', Object.keys(parseWranglerHints('not = { valid')).length === 0)
  const noMain = parseWranglerHints('name = "x"\ncompatibility_date = "2026-01-01"')
  check('a config without main still reports its compat date', !noMain.main && noMain.compatDate === '2026-01-01')
}

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll GitHub-source checks passed.')
