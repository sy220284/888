#!/usr/bin/env node

import { readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const ignored = new Set([
  '.git', 'node_modules', 'lib', 'dist', 'coverage', '.turbo', '.vitepress',
  'tests', '__tests__', '__snapshots__', 'fixtures', 'snapshots',
])

function dirs(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort()
}

function sourceEntries(path) {
  const src = join(path, 'src')
  try {
    if (!statSync(src).isDirectory()) return []
  } catch {
    return []
  }
  return readdirSync(src, { withFileTypes: true })
    .filter(entry => !ignored.has(entry.name) && !entry.name.startsWith('.'))
    .map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
    .sort()
}

const lines = []
lines.push('deepseek-harness/')

for (const app of dirs(join(root, 'apps'))) {
  lines.push(`├── apps/${app}/`)
  const entries = sourceEntries(join(root, 'apps', app))
  for (const entry of entries) lines.push(`│   └── src/${entry}`)
}

const groups = dirs(join(root, 'packages'))
for (const group of groups) {
  lines.push(`├── packages/${group}/`)
  const packages = dirs(join(root, 'packages', group))
  for (let index = 0; index < packages.length; index += 1) {
    const pkg = packages[index]
    const last = index === packages.length - 1
    lines.push(`│   ${last ? '└──' : '├──'} ${pkg}/`)
    const entries = sourceEntries(join(root, 'packages', group, pkg))
    for (const entry of entries) {
      lines.push(`│   ${last ? '    ' : '│   '}└── src/${entry}`)
    }
  }
}

for (const native of dirs(join(root, 'native'))) lines.push(`├── native/${native}/`)
for (const py of dirs(join(root, 'python'))) lines.push(`├── python/${py}/`)
lines.push('├── scripts/                 # repository tooling and architecture gates')
lines.push('└── docs/                    # design, subsystem, user, and upgrade documents')

console.log(lines.join('\n'))
