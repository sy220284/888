import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const repoRoot = resolve(import.meta.dirname, '../..')

function windowsSuffix(kind) {
  if (process.platform !== 'win32') return ''
  return kind === 'cmd' ? '.cmd' : '.exe'
}

function uvToolBinDir() {
  const result = spawnSync('uv', ['tool', 'dir', '--bin'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  return result.status === 0 ? String(result.stdout ?? '').trim() : ''
}

export function projectToolPath(name) {
  switch (name) {
    case 'prettier':
      return resolve(repoRoot, '.devtools', 'npm', 'node_modules', '.bin', `prettier${windowsSuffix('cmd')}`)
    case 'shfmt':
      return resolve(repoRoot, '.devtools', 'bin', `shfmt${windowsSuffix('exe')}`)
    case 'taplo':
      return resolve(repoRoot, '.devtools', 'cargo', 'bin', `taplo${windowsSuffix('exe')}`)
    case 'ruff': {
      const bin = uvToolBinDir()
      return bin === '' ? '' : join(bin, `ruff${windowsSuffix('exe')}`)
    }
    default:
      return ''
  }
}

export function projectToolExists(name) {
  const path = projectToolPath(name)
  return path !== '' && existsSync(path)
}
