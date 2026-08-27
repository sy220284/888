import { describe, expect, it } from 'vitest'
import {
  addBudget,
  budgetExceeded,
  budgetSnapshot,
  evaluateCapabilityPermission,
  evaluateDelegatedPermission,
  narrowBudgetLimits,
  remainingBudget,
} from '@deepseek-ai/dsh-runtime-policy'
import type { CapabilityPermissionSnapshot, CapabilityRequirement } from '@deepseek-ai/dsh-runtime-policy/types'

const workspaceWrite: CapabilityRequirement = {
  capability: 'file.write',
  resource: { kind: 'file', value: '/workspace/src/index.ts' },
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
})
