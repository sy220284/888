#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const requirements = JSON.parse(readFileSync(resolve(root, 'scripts/devtools/platform-requirements.json'), 'utf8'))
const key = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
console.log(JSON.stringify(requirements[key], null, 2))
