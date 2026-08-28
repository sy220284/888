#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const target = resolve(process.argv[2] ?? '.')
const out = resolve(process.argv[3] ?? resolve(target, 'SHA256SUMS.txt'))

function walk(dir) {
  return readdirSync(dir)
    .flatMap(name => {
      const path = resolve(dir, name)
      if (resolve(path) === out) return []
      return statSync(path).isDirectory() ? walk(path) : [path]
    })
}

const lines = walk(target).sort().map(path => {
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  const rel = relative(target, path).replaceAll('\\', '/')
  return `${hash}  ${rel}`
})
writeFileSync(out, `${lines.join('\n')}\n`)
console.log(`wrote ${out}`)
