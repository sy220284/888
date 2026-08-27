#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const target = resolve(process.argv[2] ?? '.')
const out = resolve(process.argv[3] ?? join(target, 'SHA256SUMS.txt'))
const files = readdirSync(target)
  .map(name => join(target, name))
  .filter(path => statSync(path).isFile() && resolve(path) !== out)
  .sort()
const lines = files.map(path => {
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  return `${hash}  ${basename(path)}`
})
writeFileSync(out, `${lines.join('\n')}\n`)
console.log(`wrote ${out}`)
