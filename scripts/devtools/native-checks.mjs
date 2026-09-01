#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const manifest = 'native/execution-core/Cargo.toml'
const checks = [
  ['format', ['fmt', '--manifest-path', manifest, '--', '--check']],
  ['check', ['check', '--locked', '--manifest-path', manifest]],
  ['clippy', ['clippy', '--locked', '--manifest-path', manifest, '--all-targets', '--', '-D', 'warnings']],
  ['test', ['test', '--locked', '--manifest-path', manifest]],
]
for (const [name, args] of checks) {
  console.log(`native check: ${name}`)
  const result = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
