#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const locks = [
  'pnpm-lock.yaml',
  'native/execution-core/Cargo.lock',
  'python/sdk/uv.lock',
]
let failed = false
for (const lock of locks) {
  const ok = existsSync(resolve(root, lock))
  console.log(`${ok ? '✓' : '×'} ${lock}`)
  failed ||= !ok
}

function check(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  if (result.status === 0) {
    console.log(`✓ ${label}`)
    return
  }
  failed = true
  console.error(`× ${label}`)
  if (result.stderr) console.error(result.stderr.trim())
}

if (spawnSync('pnpm', ['--version'], { cwd: root, stdio: 'ignore' }).status === 0) {
  check('pnpm', ['install', '--lockfile-only', '--frozen-lockfile'], 'pnpm lock is current')
}
if (existsSync(resolve(root, 'native/execution-core/Cargo.lock')) && spawnSync('cargo', ['--version'], { cwd: root, stdio: 'ignore' }).status === 0) {
  check('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', 'native/execution-core/Cargo.toml'], 'Cargo lock is current')
}
if (spawnSync('uv', ['--version'], { cwd: root, stdio: 'ignore' }).status === 0) {
  check('uv', ['lock', '--check', '--project', 'python/sdk'], 'uv lock is current')
}

if (failed) process.exit(1)
