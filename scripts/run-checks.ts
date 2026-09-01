/** Run explicitly requested local validation groups. */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'

export type CheckMode = 'check-all' | 'doc-sync' | 'hygiene'

interface Check {
  script: string
  env?: Record<string, string>
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
  { script: 'verify-vendored-links' },
]

const documentationChecks: Check[] = [
  { script: 'doc-typecheck' },
  { script: 'verify-doc-graphs' },
  { script: 'verify-md-links' },
  { script: 'verify-type-equiv' },
  { script: 'verify-cordis-catalog' },
  { script: 'verify-mermaid' },
  { script: 'verify-scoped-events' },
  { script: 'verify-md-wrap' },
  { script: 'verify-client-catalog' },
  { script: 'verify-export-jsdoc' },
  { script: 'verify-tool-catalog' },
  { script: 'verify-config-catalog' },
  { script: 'verify-persistence-catalog' },
  { script: 'verify-public-repository-links' },
  { script: 'verify-doc-refs' },
  { script: 'verify-package-paths' },
  { script: 'verify-config-source-ownership' },
  { script: 'verify-agent-note-classification' },
  { script: 'verify-agent-note-format' },
  { script: 'verify-archived-agent-notes' },
  { script: 'verify-skill-invocation-metadata' },
  { script: 'verify-doc-budgets' },
  { script: 'docs:check' },
  { script: 'verify-package-readme-limitations' },
]

export function checksForMode(mode: CheckMode): Check[] {
  if (mode === 'hygiene') return hygieneChecks
  if (mode === 'doc-sync') return documentationChecks
  return [
    { script: 'verify-runtime-closure' },
    { script: 'verify-cordis-config' },
    { script: 'verify-client-domain-graph' },
    { script: 'test' },
    { script: 'duplication' },
    { script: 'build' },
    { script: 'build:web' },
    { script: 'test:snapshot', env: { DSH_EXAMPLE_MODE: 'lib' } },
    ...hygieneChecks,
    ...documentationChecks,
    { script: 'verify-module-graph' },
  ]
}

function parseMode(raw: string | undefined): CheckMode {
  if (raw === 'check-all' || raw === 'doc-sync' || raw === 'hygiene') return raw
  throw new Error(`run-checks: expected check-all | doc-sync | hygiene, got ${JSON.stringify(raw)}.`)
}

async function runCheck(check: Check): Promise<number> {
  const invocation = pnpmInvocation(['run', check.script])
  console.log(`run-checks: ${check.script}`)
  return await new Promise((resolveStatus, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: root,
      env: { ...process.env, ...check.env },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`run-checks: ${check.script} terminated by ${signal}.`))
      else resolveStatus(code ?? 1)
    })
  })
}

async function main(args: string[]): Promise<number> {
  const mode = parseMode(args[0])
  for (const check of checksForMode(mode)) {
    const status = await runCheck(check)
    if (status !== 0) return status
  }
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
