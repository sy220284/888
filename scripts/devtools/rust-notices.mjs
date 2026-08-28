#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const out = resolve(root, 'THIRD_PARTY_NOTICES_RUST.md')
const manifest = 'native/execution-core/Cargo.toml'
const result = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', manifest], {
  cwd: root,
  encoding: 'utf8',
})
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? '')
  process.exit(result.status ?? 1)
}
const metadata = JSON.parse(result.stdout)
const packages = metadata.packages
  .filter(pkg => typeof pkg.source === 'string' && pkg.source.startsWith('registry+'))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const missing = packages.filter(pkg => !pkg.license || !(pkg.repository || pkg.homepage))
if (missing.length > 0) {
  throw new Error(`Rust dependency metadata incomplete: ${missing.map(pkg => `${pkg.name}@${pkg.version}`).join(', ')}`)
}

const lines = [
  '# Rust third-party notices',
  '',
  'Generated from `cargo metadata --locked` for `native/execution-core/Cargo.toml`.',
  '',
  '| Package | Version | License | Source |',
  '| --- | --- | --- | --- |',
  ...packages.map(pkg => `| ${pkg.name} | ${pkg.version} | ${pkg.license} | ${pkg.repository || pkg.homepage} |`),
  '',
]
const text = `${lines.join('\n')}\n`
if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== text) {
    console.error('THIRD_PARTY_NOTICES_RUST.md is stale. Run: node scripts/devtools/rust-notices.mjs')
    process.exit(1)
  }
  console.log('Rust third-party notices are current.')
} else {
  writeFileSync(out, text)
  console.log('wrote THIRD_PARTY_NOTICES_RUST.md')
}
