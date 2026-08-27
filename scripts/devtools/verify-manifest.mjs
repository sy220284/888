#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'devtools/manifest.json'), 'utf8'))
const profiles = JSON.parse(readFileSync(resolve(root, 'devtools/profiles.json'), 'utf8')).profiles
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const rustToolchain = readFileSync(resolve(root, 'rust-toolchain.toml'), 'utf8')
const pyproject = readFileSync(resolve(root, 'python/sdk/pyproject.toml'), 'utf8')

const errors = []
const pnpmMatch = String(pkg.packageManager ?? '').match(/^pnpm@(.+)$/)
if (!pnpmMatch) errors.push('package.json packageManager must pin pnpm@<version>')
else if (manifest.tools.pnpm.version !== pnpmMatch[1]) errors.push(`pnpm manifest mismatch: ${manifest.tools.pnpm.version} != ${pnpmMatch[1]}`)

const nodeRange = String(pkg.engines?.node ?? '')
if (!nodeRange.includes(manifest.tools.node.version)) errors.push(`pinned Node ${manifest.tools.node.version} is not explicitly covered by package.json engines.node: ${nodeRange}`)

const rustMatch = rustToolchain.match(/channel\s*=\s*"([^"]+)"/)
if (!rustMatch) errors.push('rust-toolchain.toml does not declare channel')
else if (manifest.tools.rust.version !== rustMatch[1]) errors.push(`Rust manifest mismatch: ${manifest.tools.rust.version} != ${rustMatch[1]}`)
for (const component of manifest.tools.rust.components ?? []) {
  if (!rustToolchain.includes(`"${component}"`)) errors.push(`Rust component missing from rust-toolchain.toml: ${component}`)
}

const pythonMatch = pyproject.match(/requires-python\s*=\s*">=([^"\s]+)"/)
if (!pythonMatch) errors.push('python/sdk/pyproject.toml requires-python must use a >= lower bound')
else if (manifest.tools.python.minimumVersion !== pythonMatch[1]) errors.push(`Python manifest mismatch: ${manifest.tools.python.minimumVersion} != ${pythonMatch[1]}`)

const knownTools = new Set([...Object.keys(manifest.tools), 'native-build-chain'])
for (const [name, profile] of Object.entries(profiles)) {
  const parents = profile.extends === undefined ? [] : Array.isArray(profile.extends) ? profile.extends : [profile.extends]
  for (const parent of parents) if (!profiles[parent]) errors.push(`profile ${name} extends missing profile ${parent}`)
  for (const tool of profile.tools ?? []) if (!knownTools.has(tool)) errors.push(`profile ${name} references unknown tool ${tool}`)
}

if (errors.length) {
  for (const error of errors) console.error(`devtools: ${error}`)
  process.exit(1)
}
console.log('devtools: manifest and authoritative version declarations are consistent')
