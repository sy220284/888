import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
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

function appendRuntimeFreeze(session: Session) {
  const permission = session.append('runtime/permission', { defaultDecision: 'allow', rules: [] })
  const budget = session.append('runtime/budget', {
    limits: { toolCalls: 10 }, consumed: { toolCalls: 1 }, remaining: { toolCalls: 9 },
  })
  const world = session.append('runtime/world', {
    id: 'local:/workspace', capabilities: ['fs', 'process'],
    filePolicy: { mode: 'workspace-write', workspaceRoot: '/workspace' },
  })
  const config = session.append('runtime/config', {
    agentKind: 'primary', provider: 'mock', model: 'mock', maxParallelToolCalls: 4,
    permissionPreset: 'workspace-write',
  })
  return { permission, budget, world, config }
}

function appendStepSnapshot(session: Session, refs: ReturnType<typeof appendRuntimeFreeze>) {
  const header = session.append('request/header', {
    header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial',
  })
  const context = session.append('request/context', { provider: 'mock', model: 'mock' })
  session.append('step/snapshot', {
    turn: 1, step: 1, attempt: 1, agentId: 'agent-1', surfaceSeqs: [],
    refs: {
      requestHeader: header.seq,
      requestContext: context.seq,
      permission: refs.permission.seq,
      budget: refs.budget.seq,
      world: refs.world.seq,
      config: refs.config.seq,
    },
  })
}

describe('runtime-policy invariants', () => {
  it('accepts a complete runtime freeze and a settled world effect', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const refs = appendRuntimeFreeze(session)
    appendStepSnapshot(session, refs)
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-1'), name: 'write', arguments: '{}' })
    const start = session.append('world/effect-start', {
      receiptId: 'receipt-1', callId: CallId('call-1'), toolName: 'write',
      requirements: [{ capability: 'file.write', resource: { kind: 'file', value: '/workspace/a.ts' }, risk: 1, effect: true }],
      startedAt: 100,
    })
    session.append('world/effect-receipt', {
      receiptId: 'receipt-1', startSeq: start.seq, callId: CallId('call-1'), toolName: 'write', status: 'succeeded', endedAt: 101,
    })
    expect(() => session.append('step/end', { turn: 1, step: 1 })).not.toThrow()
  })

  it('rejects a Step Snapshot carrying only part of the runtime refs', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const refs = appendRuntimeFreeze(session)
    const header = session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' } }, reason: 'initial' })
    const context = session.append('request/context', { provider: 'mock', model: 'mock' })
    expect(() => session.append('step/snapshot', {
      turn: 1, step: 1, attempt: 1, agentId: 'agent-1', surfaceSeqs: [],
      refs: { requestHeader: header.seq, requestContext: context.seq, permission: refs.permission.seq },
    })).toThrow(/runtime refs must be all present or all absent/)
  })

  it('refuses to close a step while an external effect is still result-unknown', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const refs = appendRuntimeFreeze(session)
    appendStepSnapshot(session, refs)
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-unknown'), name: 'bash', arguments: '{}' })
    session.append('world/effect-start', {
      receiptId: 'receipt-unknown', callId: CallId('call-unknown'), toolName: 'bash',
      requirements: [{ capability: 'process.spawn', resource: { kind: 'process', value: 'touch a' }, risk: 2, effect: true }],
      startedAt: 100,
    })
    expect(() => session.append('step/end', { turn: 1, step: 1 })).toThrow(/world effects without receipts/)
  })
})
