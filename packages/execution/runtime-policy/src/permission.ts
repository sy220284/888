import type {
  CapabilityDecision,
  CapabilityPermission,
  CapabilityPermissionSnapshot,
  CapabilityRequirement,
} from './types.ts'

const rank: Record<CapabilityDecision, number> = { deny: 0, ask: 1, allow: 2 }
const sources: readonly CapabilityPermission['source'][] = ['sandbox', 'config', 'delegation', 'runtime']

function selectorMatch(selector: string, value: string): boolean {
  if (selector === '*') return true
  if (selector.endsWith('/**')) {
    const root = selector.slice(0, -3).replace(/\/$/, '')
    return value === root || value.startsWith(`${root}/`)
  }
  if (selector.endsWith('.*')) {
    const root = selector.slice(0, -2)
    return value === root || value.startsWith(`${root}.`)
  }
  return selector === value
}

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
    if (!selectorMatch(rule.capability, requirement.capability)) continue
    if (!selectorMatch(rule.resource.value, requirement.resource.value)) continue
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

/**
 * Resolve one capability request. Specific rules may refine a rule inside the
 * same source layer, while independent layers only narrow one another. This
 * prevents config/delegation/runtime rules from widening a sandbox boundary.
 */
export function evaluateCapabilityPermission(
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

/** Monotonically narrow a parent decision with a child decision. */
export function narrowCapabilityDecision(parent: CapabilityDecision, child: CapabilityDecision): CapabilityDecision {
  return narrow(parent, child)
}

/** Apply child rules without permitting any requirement the parent would not permit. */
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
