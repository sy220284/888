import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as RuntimePolicyInvariant from '@deepseek-ai/dsh-runtime-policy/invariant'
import type {} from '@deepseek-ai/dsh-runtime-policy/types'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(RuntimePolicyInvariant)
  return ctx
}

function delegatedChild(ctx: Context, parentSession = SessionId('parent')): Session {
  return ctx.sessions.create(SessionId('child'), {
    meta: { parentSession, origin: 'subagent', delegationDepth: 1 },
  })
}

function appendDelegation(session: Session, parentSession = SessionId('parent')) {
  return session.append('runtime/delegation', {
    parentSession,
    permissionCeiling: {
      defaultDecision: 'ask',
      rules: [{
        capability: 'network.*',
        resource: { kind: 'network', value: '*' },
        decision: 'deny',
        source: 'delegation',
      }],
    },
    budgetCeiling: { toolCalls: 3, tokens: 1000 },
  })
}

function appendFreeze(session: Session, delegationSeq: number) {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const permission = session.append('runtime/permission', {
    defaultDecision: 'allow',
    rules: [],
    ceiling: {
      defaultDecision: 'ask',
      rules: [{ capability: 'network.*', resource: { kind: 'network', value: '*' }, decision: 'deny', source: 'delegation' }],
    },
  })
  const budget = session.append('runtime/budget', {
    limits: { toolCalls: 3, tokens: 1000 },
    consumed: {},
    remaining: { toolCalls: 3, tokens: 1000 },
  })
  const world = session.append('runtime/world', {
    id: 'local:/workspace', capabilities: ['fs', 'process'],
    filePolicy: { mode: 'workspace-write', workspaceRoot: '/workspace' },
  })
  const config = session.append('runtime/config', {
    agentKind: 'subagent', provider: 'mock', model: 'mock', maxParallelToolCalls: 4,
    permissionPreset: 'workspace-write',
  })
  const header = session.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial',
  })
  const context = session.append('request/context', { provider: 'mock', model: 'mock' })
  return { permission, budget, world, config, header, context, delegationSeq }
}

describe('runtime delegation invariants', () => {
  it('accepts a delegation captured before the child opens a step and requires the snapshot ref', async () => {
    const ctx = await setup()
    const session = delegatedChild(ctx)
    const delegation = appendDelegation(session)
    const refs = appendFreeze(session, delegation.seq)

    expect(() => session.append('step/snapshot', {
      turn: 1, step: 1, attempt: 1, agentId: 'child-agent', surfaceSeqs: [],
      refs: {
        requestHeader: refs.header.seq,
        requestContext: refs.context.seq,
        permission: refs.permission.seq,
        budget: refs.budget.seq,
        world: refs.world.seq,
        config: refs.config.seq,
        delegation: refs.delegationSeq,
      },
    })).not.toThrow()
  })

  it('rejects a delegation whose parent does not match the durable session lineage', async () => {
    const ctx = await setup()
    const session = delegatedChild(ctx)
    expect(() => appendDelegation(session, SessionId('other-parent'))).toThrow(/does not match session header/)
  })

  it('rejects a second active delegation snapshot for the same child lineage', async () => {
    const ctx = await setup()
    const session = delegatedChild(ctx)
    appendDelegation(session)
    expect(() => appendDelegation(session)).toThrow(/captured only once/)
  })

  it('rejects a step snapshot that omits the active delegation ref', async () => {
    const ctx = await setup()
    const session = delegatedChild(ctx)
    const delegation = appendDelegation(session)
    const refs = appendFreeze(session, delegation.seq)
    expect(() => session.append('step/snapshot', {
      turn: 1, step: 1, attempt: 1, agentId: 'child-agent', surfaceSeqs: [],
      refs: {
        requestHeader: refs.header.seq,
        requestContext: refs.context.seq,
        permission: refs.permission.seq,
        budget: refs.budget.seq,
        world: refs.world.seq,
        config: refs.config.seq,
      },
    })).toThrow(/must cite runtime\/delegation/)
  })
})
