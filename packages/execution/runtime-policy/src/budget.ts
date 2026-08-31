import type { BudgetDimension, BudgetVector, GlobalBudgetSnapshot } from './types.ts'

/** Ordered set of dimensions accepted in budget vectors. */
export const BUDGET_DIMENSIONS: readonly BudgetDimension[] = [
  'tokens', 'costMicros', 'wallTimeMs', 'toolCalls', 'agentStarts', 'riskPoints',
]

function assertVector(vector: BudgetVector, label: string): void {
  for (const [key, value] of Object.entries(vector) as Array<[string, unknown]>) {
    if (!BUDGET_DIMENSIONS.includes(key as BudgetDimension)) throw new TypeError(`${label}: unknown dimension ${key}`)
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label}.${key} must be a non-negative safe integer`)
    }
  }
}

/**
 * Add two sparse budget vectors without mutating either.
 * @param left - current budget values.
 * @param right - values to add.
 * @returns the summed sparse vector.
 */
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

/**
 * Monotonically narrow deployment limits with a delegated ceiling. An
 * unbounded side adopts the bounded side; when both are bounded the smaller
 * value wins. The result can never widen either input.
 * @param base - locally configured limits.
 * @param ceiling - optional delegated upper bounds.
 * @returns the intersection of both limit vectors.
 */
export function narrowBudgetLimits(base: BudgetVector, ceiling?: BudgetVector): BudgetVector {
  assertVector(base, 'runtime budget limits')
  if (ceiling === undefined) return { ...base }
  assertVector(ceiling, 'delegated budget ceiling')
  const limits: BudgetVector = {}
  for (const dimension of BUDGET_DIMENSIONS) {
    const local = base[dimension]
    const delegated = ceiling[dimension]
    const value = local === undefined
      ? delegated
      : delegated === undefined
        ? local
        : Math.min(local, delegated)
    if (value !== undefined) limits[dimension] = value
  }
  return limits
}

/**
 * Build remaining values only for dimensions that have configured limits.
 * @param limits - configured upper bounds.
 * @param consumed - debits already charged.
 * @returns remaining values for bounded dimensions.
 */
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

/**
 * Return the first dimension a proposed charge would exceed.
 * @param limits - configured upper bounds.
 * @param consumed - debits already charged.
 * @param charge - proposed additional debit.
 * @returns the first exceeded dimension, or undefined when the charge fits.
 */
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

/**
 * Build an immutable-style snapshot of one global budget ledger.
 * @param limits - configured upper bounds.
 * @param consumed - debits already charged.
 * @returns copied limits, consumption, and derived remaining values.
 */
export function budgetSnapshot(limits: BudgetVector, consumed: BudgetVector): GlobalBudgetSnapshot {
  assertVector(limits, 'limits')
  assertVector(consumed, 'consumed')
  return { limits: { ...limits }, consumed: { ...consumed }, remaining: remainingBudget(limits, consumed) }
}

/**
 * Assert that a sparse budget vector contains only valid dimensions and values.
 * @param vector - vector to validate.
 * @param label - diagnostic name for validation errors.
 */
export function assertBudgetVector(vector: BudgetVector, label = 'budget'): void {
  assertVector(vector, label)
}
