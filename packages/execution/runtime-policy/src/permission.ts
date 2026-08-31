import type {
  CapabilityDecision,
  CapabilityPermission,
  CapabilityPermissionSnapshot,
  CapabilityRequirement,
} from './types.ts'
import { selectorContains } from './selector.ts'

const rank: Record<CapabilityDecision, number> = { deny: 0, ask: 1, allow: 2 }
const sources: readonly CapabilityPermission['source'][] = ['sandbox', 'config', 'delegation', 'runtime']

function specificity(rule: CapabilityPermission): number {
  const capability = rule.capability === '*' ? 0 : rule.capability.endsWith('.*') ? 1 : 2
  const resource = rule.resource.value === '*' ? 0 : rule.resource.value.endsWith('/**') ? 1 : 2
  return capability * 10 + resource
}

function narrow(left: CapabilityDecision, right: CapabilityDecision): CapabilityDecision {
  return rank[left] <= rank[right] ? left : right
}

/** Resolve one source layer using most-specific match, with strictest decision winning ties. */
function evaluateLayer(
  rules: readonly CapabilityPermission[],
  source: CapabilityPermission['source'],
  requirement: CapabilityRequirement,
): CapabilityDecision | undefined {
  let best = -1
  let decision: CapabilityDecision | undefined
  for (const rule of rules) {
    if (rule.source !== source || rule.resource.kind !== requirement.resource.kind) continue
    if (!selectorContains(rule.capability, requirement.capability)) continue
    if (!selectorContains(rule.resource.value, requirement.resource.value)) continue
    const score = specificity(rule)
    if (score > best) {
      best = score
      decision = rule.decision
    } else if (score === best && decision !== undefined) {
      decision = narrow(decision, rule.decision)
    }
  }
  return decision
}

/** Resolve one local permission snapshot without consulting its delegation ceiling. */
function evaluateLocal(
  snapshot: CapabilityPermissionSnapshot,
  requirement: CapabilityRequirement,
): CapabilityDecision {
  let decision = snapshot.defaultDecision
  for (const source of sources) {
    const layer = evaluateLayer(snapshot.rules, source, requirement)
    if (layer !== undefined) decision = narrow(decision, layer)
  }
  return decision
}

/**
 * Resolve one capability request. Each snapshot first applies its own source
 * layers; immutable delegation ceilings are then walked iteratively and may
 * only narrow the result. This keeps child policy monotonic without flattening
 * parent layers (flattening could let a specific allow override an independent
 * parent deny).
 * @param snapshot - local permission state and optional parent ceiling.
 * @param requirement - concrete capability request.
 * @returns the strictest applicable decision.
 */
export function evaluateCapabilityPermission(
  snapshot: CapabilityPermissionSnapshot,
  requirement: CapabilityRequirement,
): CapabilityDecision {
  let current: CapabilityPermissionSnapshot | undefined = snapshot
  let decision: CapabilityDecision = 'allow'
  let depth = 0
  while (current !== undefined) {
    decision = narrow(decision, evaluateLocal(current, requirement))
    current = current.ceiling
    depth++
    if (depth > 1024) throw new Error('capability permission ceiling depth exceeds 1024')
  }
  return decision
}

/**
 * Monotonically narrow a parent decision with a child decision.
 * @param parent - parent permission decision.
 * @param child - child permission decision.
 * @returns the stricter decision.
 */
export function narrowCapabilityDecision(parent: CapabilityDecision, child: CapabilityDecision): CapabilityDecision {
  return narrow(parent, child)
}

/**
 * Apply child rules without permitting any requirement the parent would not permit.
 * @param parent - parent permission snapshot.
 * @param child - child permission snapshot.
 * @param requirement - concrete capability request.
 * @returns the strictest parent or child decision.
 */
export function evaluateDelegatedPermission(
  parent: CapabilityPermissionSnapshot,
  child: CapabilityPermissionSnapshot,
  requirement: CapabilityRequirement,
): CapabilityDecision {
  return narrow(
    evaluateCapabilityPermission(parent, requirement),
    evaluateCapabilityPermission(child, requirement),
  )
}
