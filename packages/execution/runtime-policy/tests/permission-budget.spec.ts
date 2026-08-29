import { describe, expect, it } from 'vitest'
import {
  RuntimePolicyService,
  addBudget,
  budgetExceeded,
  budgetSnapshot,
  evaluateCapabilityPermission,
  evaluateDelegatedPermission,
  narrowBudgetLimits,
  remainingBudget,
  usageTokenDelta,
} from '@deepseek-ai/dsh-runtime-policy'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { CapabilityPermissionSnapshot, CapabilityRequirement } from '@deepseek-ai/dsh-runtime-policy/types'

const workspaceWrite: CapabilityRequirement = {
  capability: 'file.write',
  resource: { kind: 'file', value: '/workspace/src/index.ts' },
}

function usageChunk(seq: number, tokens: number, turn = 1, step = 0): SessionEvent {
  return {
    seq,
    type: 'assistant/chunk',
    data: {
      turn,
      step,
      chunk: { type: 'usage', usage: { inputTokens: tokens, outputTokens: 0 } },
    },
  } as unknown as SessionEvent
}

function usageMessage(seq: number, tokens: number, turn = 1, step = 0): SessionEvent {
  return {
    seq,
    type: 'assistant/message',
    data: { turn, step, usage: { inputTokens: tokens, outputTokens: 0 } },
  } as unknown as SessionEvent
}

function stepSnapshot(seq: number, attempt: number, turn = 1, step = 0): SessionEvent {
  return {
    seq,
    type: 'step/snapshot',
    data: { turn, step, attempt, agentId: 'agent', surfaceSeqs: [], refs: {} },
  } as unknown as SessionEvent
}

describe('runtime capability permission', () => {
  it('lets a specific rule refine a broader rule inside the same source layer', () => {
    const snapshot: CapabilityPermissionSnapshot = {
      defaultDecision: 'allow',
      rules: [
        { capability: 'file.write', resource: { kind: 'file', value: '*' }, decision: 'ask', source: 'sandbox' },
        { capability: 'file.write', resource: { kind: 'file', value: '/workspace/**' }, decision: 'allow', source: 'sandbox' },
      ],
    }
    expect(evaluateCapabilityPermission(snapshot, workspaceWrite)).toBe('allow')
  })

  it('never lets config widen a sandbox denial', () => {
    const snapshot: CapabilityPermissionSnapshot = {
      defaultDecision: 'allow',
      rules: [
        { capability: 'file.write', resource: { kind: 'file', value: '*' }, decision: 'deny', source: 'sandbox' },
        { capability: 'file.write', resource: { kind: 'file', value: '/workspace/**' }, decision: 'allow', source: 'config' },
      ],
    }
    expect(evaluateCapabilityPermission(snapshot, workspaceWrite)).toBe('deny')
  })

  it('keeps delegation monotonic even when a child asks for a wider default', () => {
    const parent: CapabilityPermissionSnapshot = {
      defaultDecision: 'ask',
      rules: [{ capability: 'network.*', resource: { kind: 'network', value: '*' }, decision: 'deny', source: 'delegation' }],
    }
    const child: CapabilityPermissionSnapshot = { defaultDecision: 'allow', rules: [] }
    const requirement: CapabilityRequirement = {
      capability: 'network.fetch', resource: { kind: 'network', value: 'https://example.com' },
    }
    expect(evaluateDelegatedPermission(parent, child, requirement)).toBe('deny')
  })

  it('walks a captured parent ceiling without flattening source-layer semantics', () => {
    const snapshot: CapabilityPermissionSnapshot = {
      defaultDecision: 'allow',
      rules: [{ capability: 'file.write', resource: { kind: 'file', value: '/workspace/**' }, decision: 'allow', source: 'runtime' }],
      ceiling: {
        defaultDecision: 'allow',
        rules: [
          { capability: 'file.write', resource: { kind: 'file', value: '*' }, decision: 'deny', source: 'sandbox' },
          { capability: 'file.write', resource: { kind: 'file', value: '/workspace/**' }, decision: 'allow', source: 'config' },
        ],
      },
    }
    expect(evaluateCapabilityPermission(snapshot, workspaceWrite)).toBe('deny')
  })
})

describe('global budget arithmetic', () => {
  it('adds sparse charges and computes remaining values', () => {
    const consumed = addBudget({ toolCalls: 2, riskPoints: 1 }, { toolCalls: 1, wallTimeMs: 50 })
    expect(consumed).toEqual({ toolCalls: 3, riskPoints: 1, wallTimeMs: 50 })
    expect(remainingBudget({ toolCalls: 5, wallTimeMs: 100 }, consumed)).toEqual({ toolCalls: 2, wallTimeMs: 50 })
  })

  it('rejects a pre-dispatch charge that crosses a configured ceiling', () => {
    expect(budgetExceeded({ toolCalls: 3 }, { toolCalls: 2 }, { toolCalls: 2 })).toBe('toolCalls')
    expect(budgetExceeded({ toolCalls: 4 }, { toolCalls: 2 }, { toolCalls: 2 })).toBeUndefined()
  })

  it('represents an observed overrun instead of hiding it', () => {
    const snapshot = budgetSnapshot({ wallTimeMs: 100 }, { wallTimeMs: 125 })
    expect(snapshot).toEqual({
      limits: { wallTimeMs: 100 },
      consumed: { wallTimeMs: 125 },
      remaining: { wallTimeMs: 0 },
    })
  })

  it('never lets a delegated ceiling widen a deployment limit', () => {
    expect(narrowBudgetLimits(
      { toolCalls: 10, wallTimeMs: 1000 },
      { toolCalls: 4, tokens: 8000 },
    )).toEqual({ toolCalls: 4, wallTimeMs: 1000, tokens: 8000 })
  })

  it('charges durable usage chunks immediately and never double-counts a final cumulative sample', () => {
    const first = usageChunk(0, 80)
    const second = usageChunk(1, 120)
    const final = usageMessage(2, 120)
    const correctedLower = usageMessage(3, 110)

    expect(usageTokenDelta([first], first)).toBe(80)
    expect(usageTokenDelta([first, second], second)).toBe(40)
    expect(usageTokenDelta([first, second, final], final)).toBe(0)
    expect(usageTokenDelta([first, second, final, correctedLower], correctedLower)).toBe(0)
  })

  it('accounts retry attempts independently inside the same turn and step', () => {
    const attempt1 = stepSnapshot(0, 1)
    const failedUsage = usageChunk(1, 80)
    const attempt2 = stepSnapshot(2, 2)
    const recoveredUsage = usageChunk(3, 60)
    const final = usageMessage(4, 60)
    const events = [attempt1, failedUsage, attempt2, recoveredUsage, final]

    expect(usageTokenDelta(events, failedUsage)).toBe(80)
    expect(usageTokenDelta(events, recoveredUsage)).toBe(60)
    expect(usageTokenDelta(events, final)).toBe(0)

    const service = {
      limits: { tokens: 1000 },
      budgetLimits: () => ({ tokens: 1000 }),
    } as unknown as RuntimePolicyService
    const session = { header: {}, events } as unknown as Session
    expect(RuntimePolicyService.prototype.budgetSnapshot.call(service, session).consumed.tokens).toBe(140)
  })

  it('ignores inherited delegation snapshots that belong to a different parent lineage', () => {
    const inheritedDelegation = {
      seq: 0,
      type: 'runtime/delegation',
      data: {
        parentSession: 'grandparent',
        permissionCeiling: { defaultDecision: 'allow', rules: [] },
        budgetCeiling: { tokens: 10 },
      },
    } as unknown as SessionEvent
    const ownedDelegation = {
      seq: 1,
      type: 'runtime/delegation',
      data: {
        parentSession: 'parent',
        permissionCeiling: { defaultDecision: 'allow', rules: [] },
        budgetCeiling: { tokens: 40 },
      },
    } as unknown as SessionEvent
    const service = { limits: { tokens: 100 } } as RuntimePolicyService
    const inheritedOnly = {
      header: { parentSession: 'parent' },
      events: [inheritedDelegation],
    } as unknown as Session
    const withOwned = {
      header: { parentSession: 'parent' },
      events: [inheritedDelegation, ownedDelegation],
    } as unknown as Session

    expect(RuntimePolicyService.prototype.budgetLimits.call(service, inheritedOnly)).toEqual({ tokens: 100 })
    expect(RuntimePolicyService.prototype.budgetLimits.call(service, withOwned)).toEqual({ tokens: 40 })
  })
})
