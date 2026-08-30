import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('Harness 2.0 workflows', () => {
  it('keeps the primary CI lanes scoped, parallel, pinned, and complete', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const events = record(workflow.on, 'ci.yml must define workflow events')
    expect(Object.keys(events).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(events.push).toMatchObject({ branches: ['main'] })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toMatchObject({ 'cancel-in-progress': true })

    const jobs = record(workflow.jobs, 'ci.yml must define jobs')
    expect(Object.keys(jobs).sort()).toEqual([
      'changes',
      'native',
      'python',
      'typescript',
      'typescript-build',
      'typescript-static',
      'typescript-tests',
    ])

    const changes = job(workflow, 'changes')
    expect(changes['runs-on']).toBe('ubuntu-latest')
    expect(workflowSteps(changes).find(step => step.uses === 'actions/checkout@v4')).toMatchObject({
      with: { 'fetch-depth': 0 },
    })
    expect(commands(changes).join('\n')).toContain('git diff --name-only')
    expect(commands(changes).join('\n')).toContain('code=true')
    expect(commands(changes).join('\n')).toContain('native=true')
    expect(commands(changes).join('\n')).toContain('python=true')

    const typescriptStatic = job(workflow, 'typescript-static')
    expect(typescriptStatic.needs).toBe('changes')
    expect(commands(typescriptStatic)).toEqual([
      'corepack enable',
      'corepack prepare pnpm@11.7.0 --activate',
      'pnpm install --frozen-lockfile',
      'pnpm run constraints',
      'pnpm run verify-runtime-closure',
      'pnpm run verify-package-invariants',
      'pnpm run build:lib:host',
      'pnpm run typecheck:contracts-ready',
      'pnpm run lint:contracts-ready',
    ])
    expect(setupNodeVersions(typescriptStatic)).toEqual(['22.19.0'])

    const typescriptTests = job(workflow, 'typescript-tests')
    expect(typescriptTests.needs).toBe('changes')
    expect(typescriptTests.strategy).toMatchObject({
      'fail-fast': false,
      matrix: { shard: [1, 2, 3] },
    })
    expect(commands(typescriptTests)).toEqual([
      'corepack enable',
      'corepack prepare pnpm@11.7.0 --activate',
      'pnpm install --frozen-lockfile',
      'pnpm run build:lib:host',
      'pnpm exec vitest run --shard=${{ matrix.shard }}/3',
    ])
    expect(setupNodeVersions(typescriptTests)).toEqual(['22.19.0'])

    const typescriptBuild = job(workflow, 'typescript-build')
    expect(typescriptBuild.needs).toBe('changes')
    expect(commands(typescriptBuild)).toEqual([
      'corepack enable',
      'corepack prepare pnpm@11.7.0 --activate',
      'pnpm install --frozen-lockfile',
      'pnpm run build:lib:host',
      'pnpm run build:official',
      'pnpm run publint',
      'pnpm run verify-node-next-types',
      'pnpm run verify-built-package-invariants',
    ])
    expect(setupNodeVersions(typescriptBuild)).toEqual(['22.19.0'])

    const typescript = job(workflow, 'typescript')
    expect(typescript['runs-on']).toBe('ubuntu-latest')
    expect(typescript.needs).toEqual(['changes', 'typescript-static', 'typescript-tests', 'typescript-build'])
    expect(commands(typescript).join('\n')).toContain('A TypeScript lane did not succeed')

    const native = job(workflow, 'native')
    expect(native.needs).toBe('changes')
    expect(commands(native).join('\n')).toContain('rustup toolchain install 1.98.0')
    expect(commands(native)).toContain('node scripts/devtools/native-gates.mjs')
    expect(commands(native)).toContain('node scripts/devtools/rust-notices.mjs --check')

    const python = job(workflow, 'python')
    expect(python.needs).toBe('changes')
    expect(commands(python)).toContain("python -m pip install 'uv==0.12.0'")
    expect(commands(python)).toContain('uv sync --frozen --project python/sdk --group test')
    expect(commands(python)).toContain('node scripts/devtools/python-gates.mjs')
  })

  it('verifies all dependency locks and keeps refresh write-back explicit', () => {
    const verification = loadWorkflow('.github/workflows/dependency-lock.yml')
    expect(verification.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(record(verification.on, 'dependency lock events')).sort())
      .toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(commands(job(verification, 'locks'))).toEqual(expect.arrayContaining([
      'pnpm install --lockfile-only --frozen-lockfile',
      'cargo metadata --locked --no-deps --format-version 1 --manifest-path native/execution-core/Cargo.toml',
      'uv lock --check --project python/sdk',
      'node scripts/devtools/verify-locks.mjs',
    ]))

    const refresh = loadWorkflow('.github/workflows/dependency-lock-refresh.yml')
    expect(Object.keys(record(refresh.on, 'dependency refresh events'))).toEqual(['workflow_dispatch'])
    expect(refresh.permissions).toEqual({ contents: 'write' })
    const refreshJob = job(refresh, 'refresh')
    const steps = workflowSteps(refreshJob)
    expect(steps.find(step => step.name === 'Commit generated files')).toMatchObject({
      if: '${{ inputs.write_back }}',
    })
    expect(steps.find(step => step.uses === 'actions/upload-artifact@v7')).toMatchObject({
      with: { 'if-no-files-found': 'error' },
    })
  })

  it('smokes the test profile on Linux, macOS, and Windows', () => {
    const workflow = loadWorkflow('.github/workflows/environment-smoke.yml')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const smoke = job(workflow, 'smoke')
    expect(smoke['runs-on']).toBe('${{ matrix.os }}')
    expect(smoke.strategy).toMatchObject({
      'fail-fast': false,
      matrix: { os: ['ubuntu-latest', 'macos-latest', 'windows-latest'] },
    })
    expect(commands(smoke)).toEqual([
      'sh ./dev setup test',
      '.\\dev.ps1 setup test',
      'sh ./dev doctor --profile test',
      '.\\dev.ps1 doctor --profile test',
    ])
  })

  it('keeps development tool verification read-only and bundle creation dispatch-only', () => {
    const verification = loadWorkflow('.github/workflows/devtools-verify.yml')
    expect(Object.keys(record(verification.on, 'devtools verification events')).sort())
      .toEqual(['pull_request', 'workflow_dispatch'])
    expect(verification.permissions).toEqual({ contents: 'read' })
    expect(commands(job(verification, 'verify'))).toEqual(expect.arrayContaining([
      'node scripts/devtools/verify-manifest.mjs',
      'node scripts/devtools/verify-download-policy.mjs',
      'node scripts/devtools/dev.mjs doctor --profile minimal',
    ]))

    const release = loadWorkflow('.github/workflows/devtools-release.yml')
    expect(Object.keys(record(release.on, 'devtools release events'))).toEqual(['workflow_dispatch'])
    expect(release.permissions).toEqual({ contents: 'read' })
    expect(job(release, 'bundle').strategy).toMatchObject({
      'fail-fast': false,
      matrix: { os: ['ubuntu-latest', 'macos-latest', 'windows-latest'] },
    })
  })
})

describe('Git hooks', () => {
  it('leaves frozen Agent Note sidecars to the archive verifier', () => {
    const lefthook = loadWorkflow('lefthook.yml')
    for (const hookName of ['pre-commit', 'pre-merge-commit']) {
      const hook = record(lefthook[hookName], `lefthook must define ${hookName}`)
      if (!Array.isArray(hook.jobs)) throw new TypeError(`${hookName} must define jobs`)
      const jobs = hook.jobs as unknown[]
      const pairing: unknown = jobs.find(value => isRecord(value) && value.name === 'translation pairing (staged records)')
      expect(pairing).toMatchObject({ exclude: ['.agents/notes/archived/**'] })
    }
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  return record(workflow, `${path} must define a workflow`)
}

function job(workflow: Record<string, unknown>, name: string): Record<string, unknown> {
  const jobs = record(workflow.jobs, 'workflow must define jobs')
  return record(jobs[name], `workflow must define the ${name} job`)
}

function workflowSteps(value: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(value.steps)) throw new TypeError('workflow job must define steps')
  return value.steps.filter(isRecord)
}

function commands(value: Record<string, unknown>): string[] {
  return workflowSteps(value).flatMap(step => typeof step.run === 'string' ? [step.run] : [])
}

function setupNodeVersions(value: Record<string, unknown>): string[] {
  return workflowSteps(value).flatMap((step) => {
    if (step.uses !== 'actions/setup-node@v7' || !isRecord(step.with)) return []
    return typeof step.with['node-version'] === 'string' ? [step.with['node-version']] : []
  })
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(message)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
