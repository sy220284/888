import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import RecoveryService from '@deepseek-ai/dsh-recovery'
import ModelRouter from '../src/index.ts'

class EmptyAdapter extends LlmAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function fakeAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  return { id: session.id, session } as Agent
}

async function setupCatalogAware(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(RecoveryService)
  await ctx.plugin(ModelRouter, {
    models: [
      { id: 'primary-fast', provider: 'primary', model: 'fast', contextWindow: 32_000, capabilities: ['tools'] },
      { id: 'backup-small', provider: 'backup', model: 'small', contextWindow: 16_000, capabilities: ['tools'] },
      { id: 'backup-stable', provider: 'backup', model: 'stable', contextWindow: 64_000, capabilities: ['tools'] },
      { id: 'third-no-tools', provider: 'third', model: 'last', contextWindow: 128_000, capabilities: ['vision'] },
    ],
    fallbacks: [{
      from: { provider: 'primary', model: 'fast' },
      to: [
        { provider: 'missing', model: 'unregistered' },
        { provider: 'backup', model: 'small' },
        { provider: 'third', model: 'last' },
        { provider: 'backup', model: 'stable' },
      ],
    }],
  })
  ctx.llm.registerAdapter(['primary', 'backup', 'third', 'missing'], new EmptyAdapter())
  return ctx
}

describe('ModelRouter catalog authority', () => {
  it('requires fallback routes to be registered once the catalog is populated', async () => {
    const ctx = await setupCatalogAware()
    const agent = fakeAgent(ctx, 'router-catalog')
    const result = await ctx.recovery.resolve({
      agent, turn: 1, step: 1, attempt: 1, provider: 'primary', model: 'fast',
      failure: { message: 'busy', code: 'SERVER' }, retryPolicy: undefined,
      signal: new AbortController().signal,
    })
    expect(result?.route).toEqual({ provider: 'backup', model: 'small' })
  })

  it('uses context capacity and capabilities when choosing a fallback', async () => {
    const ctx = await setupCatalogAware()
    const agent = fakeAgent(ctx, 'router-capacity')
    const result = await ctx.recovery.resolve({
      agent, turn: 1, step: 1, attempt: 1, provider: 'primary', model: 'fast',
      failure: { message: 'too long', code: 'CONTEXT_WINDOW_EXCEEDED' }, retryPolicy: undefined,
      signal: new AbortController().signal,
    })
    expect(result?.route).toEqual({ provider: 'backup', model: 'stable' })
  })
})
