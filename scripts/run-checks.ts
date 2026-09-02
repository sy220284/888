/** Run repository validation groups. */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'

export type CheckMode = 'check-all' | 'hygiene'

interface Check {
  script: string
}

const root = resolve(import.meta.dirname, '..')

const hygieneChecks: Check[] = [
  { script: 'rescope-vendor:check' },
  { script: 'knip' },
  { script: 'publint' },
  { script: 'constraints' },
  { script: 'verify-dsh-package-licenses' },
  { script: 'verify-package-invariants' },
  { script: 'verify-built-package-invariants' },
  { script: 'verify-node-next-types' },
  { script: 'verify-optional-dependency-imports' },
  { script: 'verify-client-packages' },
  { script: 'verify-cordis-config' },
  { script: 'verify-runtime-closure' },
]

export function checksForMode(mode: CheckMode): Check[] {
  if (mode === 'hygiene') return hygieneChecks
  return [
    { script: 'lint' },
    { script: 'typecheck' },
    { script: 'test' },
    { script: 'duplication' },
    { script: 'build' },
    ...hygieneChecks,
  ]
}

function parseMode(raw: string | undefined): CheckMode {
  if (raw === 'check-all' || raw === 'hygiene') return raw
  throw new Error(`run-checks: expected check-all | hygiene, got ${JSON.stringify(raw)}.`)
}

async function runCheck(check: Check): Promise<number> {
  const invocation = pnpmInvocation(['run', check.script])
  console.log(`run-checks: ${check.script}`)
  return await new Promise((resolveStatus, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: root, env: process.env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`run-checks: ${check.script} terminated by ${signal}.`))
      else resolveStatus(code ?? 1)
    })
  })
}

const mode = parseMode(process.argv[2])
for (const check of checksForMode(mode)) {
  const status = await runCheck(check)
  if (status !== 0) {
    process.exitCode = status
    break
  }
}
