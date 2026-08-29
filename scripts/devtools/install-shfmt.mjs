import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { projectToolPath, repoRoot } from './tool-paths.mjs'

const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'devtools/manifest.json'), 'utf8'))
const checksums = JSON.parse(readFileSync(resolve(repoRoot, 'devtools/checksums.json'), 'utf8'))
const version = manifest.tools.shfmt.version
const key = `${process.platform}-${process.arch}`
const declaration = checksums.tools?.shfmt?.assets?.[key]

if (checksums.tools?.shfmt?.version !== version) {
  throw new Error(`shfmt checksum declaration version mismatch: ${checksums.tools?.shfmt?.version ?? 'missing'} != ${version}`)
}
if (!declaration) throw new Error(`shfmt ${version} has no verified asset for ${key}`)
if (!/^https:\/\/github\.com\/mvdan\/sh\/releases\/download\//.test(declaration.url)) {
  throw new Error(`shfmt ${key} download must use the official mvdan/sh GitHub release`)
}
if (!/^[0-9a-f]{64}$/.test(declaration.sha256)) throw new Error(`shfmt ${key} is missing a valid SHA-256 digest`)

const response = await fetch(declaration.url, { redirect: 'follow' })
if (!response.ok) throw new Error(`shfmt download failed: HTTP ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
const actual = createHash('sha256').update(bytes).digest('hex')
if (actual !== declaration.sha256) throw new Error(`shfmt ${key} SHA-256 mismatch: ${actual} != ${declaration.sha256}`)

const destination = projectToolPath('shfmt')
mkdirSync(resolve(repoRoot, '.devtools', 'bin'), { recursive: true })
writeFileSync(destination, bytes)
if (process.platform !== 'win32') chmodSync(destination, 0o755)
console.log(`shfmt ${version}: installed verified ${key} binary at ${destination}`)
