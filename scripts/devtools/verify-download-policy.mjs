#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'devtools/manifest.json'), 'utf8'))
const checksums = JSON.parse(readFileSync(resolve(root, 'devtools/checksums.json'), 'utf8'))
const errors = []
if (manifest.security?.downloadVerification !== 'sha256') errors.push('manifest security.downloadVerification must be sha256')
if (manifest.security?.allowUnverifiedDownloads !== false) errors.push('unverified downloads must remain disabled')
if (checksums.policy?.algorithm !== 'sha256') errors.push('checksums policy must use sha256')
if (checksums.policy?.allowUnverifiedDownloads !== false) errors.push('checksums policy must reject unverified downloads')
if (errors.length) {
  for (const error of errors) console.error(`devtools: ${error}`)
  process.exit(1)
}
console.log('devtools: download verification policy is strict')
