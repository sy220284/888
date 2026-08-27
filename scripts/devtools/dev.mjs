#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'devtools/manifest.json'), 'utf8'))
const profiles = JSON.parse(readFileSync(resolve(root, 'devtools/profiles.json'), 'utf8')).profiles
const cargoManifest = 'native/execution-core/Cargo.toml'

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...options.env },
  })
  return result
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
      return { ok: text !== '', actual: text || 'missing' }
    }
    case 'powershell': {
      const cmd = process.platform === 'win32' ? 'pwsh' : 'pwsh'
      const text = output(cmd, ['--version'])
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

function doctor(profileName = 'test') {
  const profile = expandProfile(profileName)
  const rows = []
  let failed = false
  for (const name of profile.tools) {
    const state = toolState(name)
    failed ||= !state.ok && name !== 'powershell'
    rows.push({ name, ...state })
  }
  console.log(`Harness 2.0 development environment: ${profileName}`)
  for (const row of rows) console.log(`${row.ok ? '✓' : '×'} ${row.name.padEnd(20)} ${row.actual}`)
  for (const lock of manifest.dependencyLocks) {
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
    if (!commandExists('corepack', ['--version'])) throw new Error('corepack is required to install the pinned pnpm; use bootstrap to install the pinned Node toolchain first')
    must(run('corepack', ['enable']), 'corepack enable')
    must(run('corepack', ['prepare', `pnpm@${manifest.tools.pnpm.version}`, '--activate']), 'install pnpm')
    return
  }
  if (name === 'rust') {
    if (!commandExists('rustup', ['--version'])) throw new Error('rustup is missing; run the platform bootstrap script or install rustup from the official Rust distribution first')
    must(run('rustup', ['toolchain', 'install', manifest.tools.rust.version, '--profile', 'minimal', '--component', 'rustfmt', '--component', 'clippy']), 'install Rust toolchain')
    must(run('rustup', ['override', 'set', manifest.tools.rust.version]), 'select project Rust toolchain')
    return
  }
  if (name === 'uv') {
    const py = process.platform === 'win32' ? 'python' : (commandExists('python3') ? 'python3' : 'python')
    if (!commandExists(py, ['--version'])) throw new Error('Python is required before installing uv')
    must(run(py, ['-m', 'pip', 'install', '--user', 'uv==0.12.0']), 'install uv 0.12.0')
    return
  }
  if (name === 'node') throw new Error('Node must be installed by bootstrap because this command itself runs on Node')
  if (name === 'git' || name === 'python' || name === 'native-build-chain' || name === 'powershell') {
    throw new Error(`${name} is a system/platform tool; install it through the platform bootstrap instructions or system package manager`)
  }
  throw new Error(`unsupported tool: ${name}`)
}

function must(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`)
}

function installDependencies(scopes) {
  for (const scope of scopes) {
    if (scope === 'npm') must(run('pnpm', ['install', '--frozen-lockfile']), 'pnpm frozen install')
    else if (scope === 'cargo') must(run('cargo', ['fetch', '--locked', '--manifest-path', cargoManifest]), 'cargo locked fetch')
    else if (scope === 'python') must(run('uv', ['sync', '--frozen', '--project', 'python/sdk']), 'uv frozen sync')
  }
}

function verifyDependencies() {
  let failed = false
  for (const lock of manifest.dependencyLocks) {
    const ok = existsSync(resolve(root, lock))
    console.log(`${ok ? '✓' : '×'} ${lock}`)
    failed ||= !ok
  }
  if (commandExists('pnpm')) failed ||= run('pnpm', ['install', '--frozen-lockfile', '--lockfile-only'], { capture: true }).status !== 0
  if (commandExists('cargo') && existsSync(resolve(root, 'native/execution-core/Cargo.lock'))) {
    failed ||= run('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', cargoManifest], { capture: true }).status !== 0
  }
  if (commandExists('uv') && existsSync(resolve(root, 'python/sdk/uv.lock'))) {
    failed ||= run('uv', ['lock', '--check', '--project', 'python/sdk'], { capture: true }).status !== 0
  }
  if (failed) process.exitCode = 1
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

function check(profileName = 'test') {
  doctor(profileName)
  if (process.exitCode) return
  if (profileName === 'minimal') {
    must(run('pnpm', ['run', 'typecheck']), 'typecheck')
    must(run('pnpm', ['run', 'lint']), 'lint')
    must(run('pnpm', ['run', 'test']), 'test')
    return
  }
  must(run('pnpm', ['run', 'check:all']), 'full project checks')
}

function usage() {
  console.log(`Usage:\n  ./dev setup <minimal|test|native|python|full>\n  ./dev doctor [--profile <profile>]\n  ./dev tool install <tool>\n  ./dev deps install <profile>\n  ./dev deps verify\n  ./dev check [profile]\n  ./dev download <profile>\n\nThe download command is handled by the platform bootstrap layer so it can work before Node is installed.`)
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
