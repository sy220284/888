#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const result = spawnSync('uv', ['run', '--frozen', '--project', 'python/sdk', 'pytest'], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
