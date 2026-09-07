import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-credential-rotation-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(dir: string, config: LlmDeepSeek.Config): Promise<Context> {
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmDeepSeek, config)
  return ctx
}

async function prompt(ctx: Context) {
  return assemble(ctx, { model: 'deepseek-v4-flash', messages: [] })
}

describe('DeepSeek credential rotation', () => {
  it('rotates after an auth failure, cools the failed credential, and exposes auth/quota as default retryable codes', async () => {
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), [
      'version: 1',
      'refs:',
      '  DEEPSEEK_KEY_A: first-key',
      '  DEEPSEEK_KEY_B: second-key',
      '',
    ].join('\n'), { mode: 0o600 })
    const server = await mockServer([
      { kind: 'http-error', status: 401, body: '{"error":{"message":"bad key"}}' },
      { kind: 'sse', events: textEvents },
      { kind: 'sse', events: textEvents },
    ])
    const ctx = await boot(dir, {
      baseURL: server.url,
      apiKeyEnvs: ['DEEPSEEK_KEY_A', 'DEEPSEEK_KEY_B'],
    })

    const policy = ctx.llm.providerRetryPolicy('deepseek-official')
    expect(policy?.mode).toBe('normal')
    if (policy?.mode !== 'normal') throw new Error('expected normal retry policy')
    expect(policy.retryableCodes).toEqual(expect.arrayContaining(['AUTH', 'QUOTA']))

    const failed = await prompt(ctx)
    expect(failed.finish).toMatchObject({ kind: 'error', failure: { code: 'AUTH' } })
    const recovered = await prompt(ctx)
    expect(recovered.finish).toMatchObject({ kind: 'stop' })
    const stillHealthy = await prompt(ctx)
    expect(stillHealthy.finish).toMatchObject({ kind: 'stop' })

    expect(server.headers.map(headers => headers.authorization)).toEqual([
      'Bearer first-key',
      'Bearer second-key',
      'Bearer second-key',
    ])
  })

  it('keeps an explicit retry policy authoritative', async () => {
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), [
      'version: 1',
      'refs:',
      '  DEEPSEEK_KEY_A: first-key',
      '  DEEPSEEK_KEY_B: second-key',
      '',
    ].join('\n'), { mode: 0o600 })
    const ctx = await boot(dir, {
      baseURL: 'http://127.0.0.1:1',
      apiKeyEnvs: ['DEEPSEEK_KEY_A', 'DEEPSEEK_KEY_B'],
      retryPolicy: { mode: 'normal', retryableCodes: ['SERVER'] },
    })
    const policy = ctx.llm.providerRetryPolicy('deepseek-official')
    expect(policy).toMatchObject({ mode: 'normal', retryableCodes: ['SERVER'] })
  })
})
