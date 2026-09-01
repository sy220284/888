import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { projectToolPath, repoRoot } from './tool-paths.mjs'

const args = process.argv.slice(2)
const check = args.includes('--check')
const separator = args.indexOf('--')
const explicitFiles = separator >= 0 ? args.slice(separator + 1) : []
const onlyIndex = args.indexOf('--only')
const requested = onlyIndex >= 0 ? String(args[onlyIndex + 1] ?? '').split(',').filter(Boolean) : []
const allScopes = ['prettier', 'python', 'shell', 'toml', 'rust']
const scopes = requested.length === 0 ? allScopes : requested
for (const scope of scopes) if (!allScopes.includes(scope)) throw new Error(`unknown format scope: ${scope}`)

const ignoredPrefixes = [
  '.agents/notes/',
  'native/landlock-run/',
  'vendor/',
  'website/.generated/',
]
const ignoredFiles = new Set(['THIRD_PARTY_NOTICES.md', 'pnpm-lock.yaml', 'python/sdk/uv.lock'])
const prettierExtensions = new Set(['.md', '.mdx', '.json', '.jsonc', '.yaml', '.yml', '.css', '.scss', '.less', '.html'])
const pythonExtensions = new Set(['.py', '.pyi'])
const shellExtensions = new Set(['.sh', '.bash'])

function run(command, commandArgs, label) {
  const useCmd = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
  const executable = useCmd ? (process.env.ComSpec || 'cmd.exe') : command
  const actualArgs = useCmd ? ['/d', '/s', '/c', command, ...commandArgs] : commandArgs
  const result = spawnSync(executable, actualArgs, { cwd: repoRoot, encoding: 'utf8', stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`)
}

function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' })
  if (result.status !== 0) throw new Error('git ls-files failed')
  return String(result.stdout ?? '').split('\0').filter(Boolean)
}

function normalizeFile(file) {
  const absolute = resolve(repoRoot, file)
  return relative(repoRoot, absolute).replaceAll('\\', '/')
}

function isIgnored(file) {
  return ignoredFiles.has(file) || ignoredPrefixes.some(prefix => file.startsWith(prefix))
}

function isFormatTarget(file) {
  const path = resolve(repoRoot, file)
  if (!existsSync(path)) return false
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function hasShellShebang(file) {
  if (extname(file) !== '' || !isFormatTarget(file)) return false
  try {
    const firstLine = readFileSync(resolve(repoRoot, file), 'utf8').split(/\r?\n/, 1)[0]
    return /^#!.*\b(?:ba|z|k)?sh\b/.test(firstLine)
  } catch {
    return false
  }
}

function validJson(file) {
  if (extname(file) !== '.json') return true
  try {
    JSON.parse(readFileSync(resolve(repoRoot, file), 'utf8'))
    return true
  } catch {
    return false
  }
}

function requireTool(name) {
  const path = projectToolPath(name)
  if (path === '' || !existsSync(path)) {
    throw new Error(`${name} is missing. Run ./dev setup full (or the matching development profile) first.`)
  }
  return path
}

function chunks(items, size = 64) {
  const result = []
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size))
  return result
}

const files = (explicitFiles.length > 0 ? explicitFiles : trackedFiles())
  .map(normalizeFile)
  .filter(file => file !== '' && !file.startsWith('../') && !isIgnored(file) && isFormatTarget(file))

if (scopes.includes('prettier')) {
  const selected = files.filter(file => prettierExtensions.has(extname(file).toLowerCase()) && validJson(file))
  if (selected.length > 0) {
    const prettier = requireTool('prettier')
    for (const batch of chunks(selected)) {
      run(prettier, [check ? '--check' : '--write', '--ignore-unknown', ...batch], `prettier ${check ? 'check' : 'write'}`)
    }
  }
}

if (scopes.includes('python')) {
  const selected = files.filter(file => pythonExtensions.has(extname(file).toLowerCase()))
  if (selected.length > 0) {
    const ruff = requireTool('ruff')
    for (const batch of chunks(selected)) {
      run(ruff, ['format', ...(check ? ['--check'] : []), ...batch], `ruff format ${check ? 'check' : 'write'}`)
    }
  }
}

if (scopes.includes('shell')) {
  const selected = files.filter(file => shellExtensions.has(extname(file).toLowerCase()) || hasShellShebang(file))
  if (selected.length > 0) {
    const shfmt = requireTool('shfmt')
    for (const batch of chunks(selected)) {
      run(shfmt, [check ? '-d' : '-w', ...batch], `shfmt ${check ? 'check' : 'write'}`)
    }
  }
}

if (scopes.includes('toml')) {
  const selected = files.filter(file => extname(file).toLowerCase() === '.toml')
  if (selected.length > 0) {
    const taplo = requireTool('taplo')
    for (const batch of chunks(selected)) {
      run(taplo, ['format', ...(check ? ['--check'] : []), ...batch], `taplo format ${check ? 'check' : 'write'}`)
    }
  }
}

if (scopes.includes('rust') && files.some(file => file.startsWith('native/execution-core/') && extname(file) === '.rs')) {
  run('cargo', ['fmt', '--manifest-path', 'native/execution-core/Cargo.toml', ...(check ? ['--', '--check'] : [])], `rustfmt ${check ? 'check' : 'write'}`)
}

console.log(`format: ${check ? 'check' : 'write'} completed for ${scopes.join(', ')}`)
