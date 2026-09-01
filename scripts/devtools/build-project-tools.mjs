#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const config = JSON.parse(readFileSync(resolve(root, 'devtools/project-tools.json'), 'utf8'))
const output = resolve(root, process.argv[2] ?? '.artifacts/project-tools')
const binDir = resolve(output, 'bin')

rmSync(output, { recursive: true, force: true })
mkdirSync(binDir, { recursive: true })

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...options.env },
  })
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : ''
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

function executable(name) {
  return resolve(binDir, process.platform === 'win32' ? `${name}.exe` : name)
}

for (const [name, tool] of Object.entries(config.tools)) {
  if (tool.installer === 'cargo') {
    run('cargo', ['install', '--root', output, tool.package, '--version', tool.version, '--locked', '--force'])
  } else if (tool.installer === 'go') {
    run('go', ['install', tool.module], { env: { GOBIN: binDir } })
  } else {
    continue
  }

  const path = executable(tool.binary)
  if (!existsSync(path)) throw new Error(`${name}: expected binary was not produced at ${path}`)
  const versionText = run(path, ['--version'], { capture: true })
  if (!versionText.includes(tool.version)) {
    throw new Error(`${name}: expected ${tool.version}, got ${versionText}`)
  }
}

// Cargo install writes bookkeeping files that are useful only to Cargo itself.
// They are deliberately excluded from the portable artifact so every checksum
// entry corresponds to a file that GitHub Actions actually delivers.
rmSync(resolve(output, '.crates.toml'), { force: true })
rmSync(resolve(output, '.crates2.json'), { force: true })

const bundle = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  sourceCommit: process.env.GITHUB_SHA ?? null,
  tools: Object.fromEntries(
    Object.entries(config.tools)
      .filter(([, tool]) => tool.artifact !== false)
      .map(([name, tool]) => [name, { version: tool.version, binary: tool.binary }]),
  ),
}

writeFileSync(resolve(output, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`)

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = resolve(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const files = walk(output).filter(path => basename(path) !== 'SHA256SUMS.txt')
const sums = files
  .sort()
  .map(path => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${relative(output, path).replaceAll('\\', '/')}`)

writeFileSync(resolve(output, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`)
console.log(`project tools bundle: ${output}`)
