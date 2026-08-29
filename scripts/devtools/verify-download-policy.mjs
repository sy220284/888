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

const shfmtVersion = manifest.tools?.shfmt?.version
const shfmt = checksums.tools?.shfmt
if (!shfmtVersion) errors.push('manifest must pin shfmt.version')
else if (shfmt?.version !== shfmtVersion) errors.push(`shfmt checksum version mismatch: ${shfmt?.version ?? 'missing'} != ${shfmtVersion}`)
const shfmtAssets = Object.entries(shfmt?.assets ?? {})
if (shfmtAssets.length === 0) errors.push('shfmt checksum assets must not be empty')
for (const [platform, asset] of shfmtAssets) {
  const expectedPrefix = `https://github.com/mvdan/sh/releases/download/v${shfmtVersion}/`
  if (typeof asset?.url !== 'string' || !asset.url.startsWith(expectedPrefix)) {
    errors.push(`shfmt ${platform} must use the official mvdan/sh v${shfmtVersion} release`)
  }
  if (typeof asset?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
    errors.push(`shfmt ${platform} must declare a lowercase SHA-256 digest`)
  }
}

if (errors.length) {
  for (const error of errors) console.error(`devtools: ${error}`)
  process.exit(1)
}
console.log('devtools: download verification policy is strict')
