import type { BudgetDimension, BudgetVector, GlobalBudgetSnapshot } from './types.ts'

export const BUDGET_DIMENSIONS: readonly BudgetDimension[] = [
  'tokens', 'costMicros', 'wallTimeMs', 'toolCalls', 'agentStarts', 'riskPoints',
]

function assertVector(vector: BudgetVector, label: string): void {
  for (const [key, value] of Object.entries(vector)) {
    if (!BUDGET_DIMENSIONS.includes(key as BudgetDimension)) throw new TypeError(`${label}: unknown dimension ${key}`)
    if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label}.${key} must be a non-negative safe integer`)
    }
  }
}

/** Add two sparse budget vectors without mutating either. */
export function addBudget(left: BudgetVector, right: BudgetVector): BudgetVector {
  assertVector(left, 'budget')
  assertVector(right, 'charge')
  const out: BudgetVector = { ...left }
  for (const dimension of BUDGET_DIMENSIONS) {
    const sum = (left[dimension] ?? 0) + (right[dimension] ?? 0)
    if (!Number.isSafeInteger(sum)) throw new RangeError(`budget ${dimension} overflow`)
    if (sum !== 0) out[dimension] = sum
  }
  return out
}

/** Build remaining values only for dimensions that have configured limits. */
export function remainingBudget(limits: BudgetVector, consumed: BudgetVector): BudgetVector {
  assertVector(limits, 'limits')
  assertVector(consumed, 'consumed')
  const remaining: BudgetVector = {}
  for (const dimension of BUDGET_DIMENSIONS) {
    const limit = limits[dimension]
    if (limit !== undefined) remaining[dimension] = Math.max(0, limit - (consumed[dimension] ?? 0))
  }
  return remaining
}

/** Return the first dimension a proposed charge would exceed, or undefined when it fits. */
export function budgetExceeded(limits: BudgetVector, consumed: BudgetVector, charge: BudgetVector): BudgetDimension | undefined {
  assertVector(limits, 'limits')
  assertVector(consumed, 'consumed')
  assertVector(charge, 'charge')
  for (const dimension of BUDGET_DIMENSIONS) {
    const limit = limits[dimension]
    if (limit === undefined) continue
    if ((consumed[dimension] ?? 0) + (charge[dimension] ?? 0) > limit) return dimension
  }
  return undefined
}

export function budgetSnapshot(limits: BudgetVector, consumed: BudgetVector): GlobalBudgetSnapshot {
  assertVector(limits, 'limits')
  assertVector(consumed, 'consumed')
  return { limits: { ...limits }, consumed: { ...consumed }, remaining: remainingBudget(limits, consumed) }
}

export function assertBudgetVector(vector: BudgetVector, label = 'budget'): void {
  assertVector(vector, label)
}
