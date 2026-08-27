#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'devtools/manifest.json'), 'utf8'))
const profiles = JSON.parse(readFileSync(resolve(root, 'devtools/profiles.json'), 'utf8')).profiles
const cargoManifest = 'native/execution-core/Cargo.toml'

function run(command, args = [], options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...options.env },
  })
}

function must(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`)
}

function output(command, args = []) {
  const result = run(command, args, { capture: true })
  return result.status === 0 ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : ''
}

function commandExists(command, args = ['--version']) {
  return run(command, args, { capture: true }).status === 0
}

function expandProfile(name, seen = new Set()) {
  const profile = profiles[name]
  if (!profile) throw new Error(`unknown profile: ${name}`)
  if (seen.has(name)) throw new Error(`profile inheritance cycle: ${[...seen, name].join(' -> ')}`)
  seen.add(name)
  const parents = profile.extends === undefined ? [] : Array.isArray(profile.extends) ? profile.extends : [profile.extends]
  const aggregate = { tools: [], dependencyScopes: [], checks: [] }
  for (const parent of parents) {
    const inherited = expandProfile(parent, new Set(seen))
    aggregate.tools.push(...inherited.tools)
    aggregate.dependencyScopes.push(...inherited.dependencyScopes)
    aggregate.checks.push(...inherited.checks)
  }
  aggregate.tools.push(...(profile.tools ?? []))
  aggregate.dependencyScopes.push(...(profile.dependencyScopes ?? []))
  aggregate.checks.push(...(profile.checks ?? []))
  return {
    tools: [...new Set(aggregate.tools)],
    dependencyScopes: [...new Set(aggregate.dependencyScopes)],
    checks: [...new Set(aggregate.checks)],
  }
}

function parseVersion(text) {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1, 4).map(Number) : null
}

function atLeast(actualText, minimum) {
  const actual = parseVersion(actualText)
  const wanted = parseVersion(minimum)
  if (!actual || !wanted) return false
  for (let i = 0; i < 3; i++) {
    if (actual[i] > wanted[i]) return true
    if (actual[i] < wanted[i]) return false
  }
  return true
}

function toolState(name) {
  switch (name) {
    case 'git': {
      const text = output('git', ['--version'])
      return { ok: text !== '' && atLeast(text, manifest.tools.git.minimumVersion), actual: text || 'missing' }
    }
    case 'node': {
      const text = output('node', ['--version'])
      return { ok: text.includes(manifest.tools.node.version), actual: text || 'missing' }
    }
    case 'pnpm': {
      const text = output('pnpm', ['--version'])
      return { ok: text === manifest.tools.pnpm.version, actual: text || 'missing' }
    }
    case 'rust': {
      const rustc = output('rustc', ['--version'])
      const cargo = output('cargo', ['--version'])
      const fmt = commandExists('cargo', ['fmt', '--version'])
      const clippy = commandExists('cargo', ['clippy', '--version'])
      return { ok: rustc.includes(manifest.tools.rust.version) && cargo !== '' && fmt && clippy, actual: rustc || 'missing' }
    }
    case 'python': {
      const command = process.platform === 'win32' ? 'python' : (commandExists('python3') ? 'python3' : 'python')
      const text = output(command, ['--version'])
      return { ok: text !== '' && atLeast(text, manifest.tools.python.minimumVersion), actual: text || 'missing' }
    }
    case 'uv': {
      const text = output('uv', ['--version'])
      return { ok: text.includes(manifest.tools.uv.version), actual: text || 'missing' }
    }
    case 'powershell': {
      const text = output('pwsh', ['--version'])
      return { ok: text !== '', actual: text || 'optional/missing' }
    }
    case 'native-build-chain': {
      if (process.platform === 'win32') {
        const ok = commandExists('cl', []) || commandExists('clang-cl', ['--version'])
        return { ok, actual: ok ? 'MSVC/clang-cl available' : 'missing MSVC/clang-cl' }
      }
      const candidates = ['cc', 'clang', 'gcc']
      const found = candidates.find(item => commandExists(item, ['--version']))
      return { ok: found !== undefined, actual: found ?? 'missing C toolchain' }
    }
    default:
      return { ok: false, actual: 'unknown tool' }
  }
}

function lockFiles(profile) {
  return profile.dependencyScopes.map(scope => manifest.dependencyLocks[scope]).filter(Boolean)
}

function doctor(profileName = 'test') {
  const profile = expandProfile(profileName)
  let failed = false
  console.log(`Harness 2.0 development environment: ${profileName}`)
  for (const name of profile.tools) {
    const state = toolState(name)
    const optional = name === 'powershell'
    failed ||= !state.ok && !optional
    console.log(`${state.ok ? '✓' : optional ? '!' : '×'} ${name.padEnd(20)} ${state.actual}`)
  }
  for (const lock of lockFiles(profile)) {
    const ok = existsSync(resolve(root, lock))
    failed ||= !ok
    console.log(`${ok ? '✓' : '×'} ${lock}`)
  }
  if (failed) {
    console.error(`\nEnvironment does not satisfy profile ${profileName}. Run: ./dev setup ${profileName}`)
    process.exitCode = 1
  }
}

function installTool(name) {
  const state = toolState(name)
  if (state.ok) {
    console.log(`${name}: already satisfies project requirement (${state.actual})`)
    return
  }
  if (name === 'pnpm') {
    if (!commandExists('corepack', ['--version'])) throw new Error('corepack is required; bootstrap the pinned Node toolchain first')
    must(run('corepack', ['enable']), 'corepack enable')
    must(run('corepack', ['prepare', `pnpm@${manifest.tools.pnpm.version}`, '--activate']), 'install pnpm')
    return
  }
  if (name === 'rust') {
    if (!commandExists('rustup', ['--version'])) throw new Error('rustup is missing; run the platform bootstrap first')
    must(run('rustup', ['toolchain', 'install', manifest.tools.rust.version, '--profile', 'minimal', '--component', 'rustfmt', '--component', 'clippy']), 'install Rust toolchain')
    must(run('rustup', ['override', 'set', manifest.tools.rust.version]), 'select project Rust toolchain')
    return
  }
  if (name === 'uv') {
    const py = process.platform === 'win32' ? 'python' : (commandExists('python3') ? 'python3' : 'python')
    if (!commandExists(py, ['--version'])) throw new Error('Python is required before installing uv')
    must(run(py, ['-m', 'pip', 'install', '--user', `uv==${manifest.tools.uv.version}`]), `install uv ${manifest.tools.uv.version}`)
    return
  }
  if (name === 'node') throw new Error('Node must be installed by bootstrap because this command runs on Node')
  if (name === 'git' || name === 'python' || name === 'native-build-chain' || name === 'powershell') {
    throw new Error(`${name} is a platform tool; use the bootstrap instructions or system package manager`)
  }
  throw new Error(`unsupported tool: ${name}`)
}

function installDependencies(scopes) {
  for (const scope of scopes) {
    if (scope === 'npm') must(run('pnpm', ['install', '--frozen-lockfile']), 'pnpm frozen install')
    else if (scope === 'cargo') must(run('cargo', ['fetch', '--locked', '--manifest-path', cargoManifest]), 'cargo locked fetch')
    else if (scope === 'python') must(run('uv', ['sync', '--frozen', '--project', 'python/sdk', '--group', 'test']), 'uv frozen test sync')
  }
}

function verifyDependencies() {
  must(run('node', ['scripts/devtools/verify-locks.mjs']), 'dependency lock verification')
}

function setup(profileName) {
  const profile = expandProfile(profileName)
  for (const tool of profile.tools) {
    if (tool === 'git' || tool === 'node' || tool === 'python' || tool === 'native-build-chain' || tool === 'powershell') {
      const state = toolState(tool)
      if (!state.ok && tool !== 'powershell') console.warn(`${tool}: ${state.actual}; bootstrap/system installation may be required`)
      continue
    }
    installTool(tool)
  }
  installDependencies(profile.dependencyScopes)
  doctor(profileName)
}

function runMinimalChecks() {
  must(run('pnpm', ['run', 'typecheck']), 'typecheck')
  must(run('pnpm', ['run', 'lint']), 'lint')
  must(run('pnpm', ['run', 'test']), 'test')
}

function check(profileName = 'test') {
  const profile = expandProfile(profileName)
  doctor(profileName)
  if (process.exitCode) return
  if (profileName === 'minimal' || profileName === 'python') runMinimalChecks()
  else must(run('pnpm', ['run', 'check:all']), 'full TypeScript/project checks')
  if (profile.dependencyScopes.includes('cargo')) must(run('node', ['scripts/devtools/native-gates.mjs']), 'Rust native gates')
  if (profile.dependencyScopes.includes('python')) must(run('node', ['scripts/devtools/python-gates.mjs']), 'Python SDK gates')
}

function usage() {
  console.log(`Usage:\n  ./dev setup <minimal|test|native|python|full>\n  ./dev doctor [--profile <profile>]\n  ./dev tool install <tool>\n  ./dev deps install <profile>\n  ./dev deps verify\n  ./dev check [profile]\n  ./dev download <profile>`)
}

const args = process.argv.slice(2)
const command = args[0]
try {
  if (command === 'setup') setup(args[1] ?? 'test')
  else if (command === 'doctor') {
    const index = args.indexOf('--profile')
    doctor(index >= 0 ? args[index + 1] : (args[1] ?? 'test'))
  } else if (command === 'tool' && args[1] === 'install') installTool(args[2])
  else if (command === 'deps' && args[1] === 'install') installDependencies(expandProfile(args[2] ?? 'test').dependencyScopes)
  else if (command === 'deps' && args[1] === 'verify') verifyDependencies()
  else if (command === 'check') check(args[1] ?? 'test')
  else if (command === 'download') {
    console.error('Run ./scripts/devtools/bootstrap.sh download <profile> or .\\scripts\\devtools\\bootstrap.ps1 download <profile>.')
    process.exitCode = 2
  } else usage()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
