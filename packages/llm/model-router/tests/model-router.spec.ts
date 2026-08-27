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

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(RecoveryService)
  await ctx.plugin(ModelRouter, {
    fallbacks: [{
      from: { provider: 'primary', model: 'fast' },
      to: [{ provider: 'backup', model: 'stable' }, { provider: 'third', model: 'last' }],
    }],
  })
  ctx.llm.registerAdapter(['primary', 'backup', 'third'], new EmptyAdapter())
  return ctx
}

function fakeAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  return { id: session.id, session } as Agent
}

describe('ModelRouter', () => {
  it('selects each configured fallback at most once in a step', async () => {
    const ctx = await setup()
    const agent = fakeAgent(ctx, 'router-fallback')
    const base = {
      agent, turn: 1, step: 1, provider: 'primary', model: 'fast',
      retryPolicy: undefined, signal: new AbortController().signal,
    }
    const first = await ctx.recovery.resolve({ ...base, attempt: 1, failure: { message: 'busy', code: 'SERVER' } })
    expect(first?.route).toEqual({ provider: 'backup', model: 'stable' })
    const second = await ctx.recovery.resolve({
      ...base, provider: 'backup', model: 'stable', attempt: 2, failure: { message: 'busy', code: 'SERVER' },
    })
    expect(second?.route).toEqual({ provider: 'third', model: 'last' })
    const third = await ctx.recovery.resolve({
      ...base, provider: 'third', model: 'last', attempt: 3, failure: { message: 'busy', code: 'SERVER' },
    })
    expect(third).toBeUndefined()
    expect(agent.session.events.filter(event => event.type === 'model/route-selected')).toHaveLength(2)
  })

  it('does not fallback for a terminal unconfigured failure code', async () => {
    const ctx = await setup()
    const agent = fakeAgent(ctx, 'router-terminal')
    const result = await ctx.recovery.resolve({
      agent, turn: 1, step: 1, attempt: 1, provider: 'primary', model: 'fast',
      failure: { message: 'bad request', code: 'INVALID_REQUEST' }, retryPolicy: undefined,
      signal: new AbortController().signal,
    })
    expect(result).toBeUndefined()
  })
})
