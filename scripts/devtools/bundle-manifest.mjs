#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const profile = process.argv[2] ?? 'test'
const out = resolve(process.argv[3] ?? `.artifacts/devtools-${profile}`)
mkdirSync(out, { recursive: true })
for (const file of ['dev', 'dev.ps1', 'rust-toolchain.toml']) cpSync(resolve(root, file), resolve(out, file))
cpSync(resolve(root, 'devtools'), resolve(out, 'devtools'), { recursive: true })
cpSync(resolve(root, 'scripts/devtools'), resolve(out, 'scripts/devtools'), { recursive: true })
const profiles = JSON.parse(readFileSync(resolve(root, 'devtools/profiles.json'), 'utf8')).profiles
if (!profiles[profile]) throw new Error(`unknown profile: ${profile}`)
writeFileSync(resolve(out, 'PROFILE.txt'), `${profile}\n`)
console.log(out)
