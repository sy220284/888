import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import RecoveryService from '../src/index.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(RecoveryService)
  return ctx
}
function fakeAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return { id: session.id, session } as Agent
}
describe('RecoveryService', () => {
  it('uses priority order and stops at the first owning strategy', async () => {
    const ctx = await setup(); const seen: string[] = []
    ctx.recovery.register('low', async () => { seen.push('low'); return { strategy: 'low', action: 'retry', reason: 'low' } }, { priority: 0 })
    ctx.recovery.register('high', async () => { seen.push('high'); return { strategy: 'high', action: 'retry', reason: 'high' } }, { priority: 10 })
    const result = await ctx.recovery.resolve({ agent: fakeAgent(ctx, 'recovery-priority'), turn: 1, step: 1, attempt: 1, provider: 'mock', model: 'm', failure: { message: 'busy', code: 'SERVER' }, retryPolicy: undefined, signal: new AbortController().signal })
    expect(result?.strategy).toBe('high'); expect(seen).toEqual(['high'])
  })
  it('rejects mismatched strategy identities', async () => {
    const ctx = await setup(); ctx.recovery.register('owner', async () => ({ strategy: 'other', action: 'retry', reason: 'bad' }))
    await expect(ctx.recovery.resolve({ agent: fakeAgent(ctx, 'recovery-mismatch'), turn: 1, step: 1, attempt: 1, provider: 'mock', model: 'm', failure: { message: 'busy', code: 'SERVER' }, retryPolicy: undefined, signal: new AbortController().signal })).rejects.toThrow(/mismatched strategy/)
  })
  it('allows the same strategy identity in separate agent scopes', async () => {
    const ctx = await setup()
    const first = fakeAgent(ctx, 'recovery-scope-first')
    const second = fakeAgent(ctx, 'recovery-scope-second')
    ctx.recovery.register('scoped', async () => ({ strategy: 'scoped', action: 'retry', reason: 'first' }), { agent: first })
    ctx.recovery.register('scoped', async () => ({ strategy: 'scoped', action: 'retry', reason: 'second' }), { agent: second })

    const request = { turn: 1, step: 1, attempt: 1, provider: 'mock', model: 'm', failure: { message: 'busy', code: 'SERVER' as const }, retryPolicy: undefined, signal: new AbortController().signal }
    await expect(ctx.recovery.resolve({ ...request, agent: first })).resolves.toMatchObject({ reason: 'first' })
    await expect(ctx.recovery.resolve({ ...request, agent: second })).resolves.toMatchObject({ reason: 'second' })
  })
})
