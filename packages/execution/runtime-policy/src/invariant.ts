/** Package-owned invariants for durable runtime-policy and world-effect records. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { BUDGET_DIMENSIONS, assertBudgetVector, remainingBudget } from './budget.ts'
import type { BudgetVector, CapabilityAccess, CapabilityDecision, CapabilityPermission } from './types.ts'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-runtime-policy'

export const name = 'runtime-policy-invariant'
export const inject = ['invariants']

interface RuntimeRefs {
  permission?: number
  budget?: number
  world?: number
  config?: number
  delegation?: number
}

interface EffectTrace {
  seq: number
  callId: string
  toolName: string
  startedAt: number
  settled: boolean
}

interface Trace {
  openStep: boolean
  refs: RuntimeRefs
  authoritativeCalls: Set<string>
  effects: Map<string, EffectTrace>
}

const decisions = new Set<CapabilityDecision>(['allow', 'ask', 'deny'])
const sources = new Set<CapabilityPermission['source']>(['sandbox', 'config', 'delegation', 'runtime'])
const resourceKinds = new Set(['file', 'process', 'network', 'browser', 'computer', 'tool', 'agent', 'custom'])
const accesses = new Set<CapabilityAccess>(['read', 'write', 'execute', 'control'])
const worldCapabilities = new Set(['fs', 'process', 'network', 'browser', 'computer'])
const agentKinds = new Set(['primary', 'subagent', 'fork-agent', 'team-member', 'background-session-agent'])

function record(value: unknown, label: string, fail: InvariantFailure): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a JSON object`)
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string, fail: InvariantFailure): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`)
  return value
}

function nonNegativeSafeInteger(value: unknown, label: string, fail: InvariantFailure): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative safe integer`)
  return value as number
}

function positiveSafeInteger(value: unknown, label: string, fail: InvariantFailure): number {
  const number = nonNegativeSafeInteger(value, label, fail)
  if (number < 1) fail(`${label} must be a positive safe integer`)
  return number
}

function budgetVector(value: unknown, label: string, fail: InvariantFailure): BudgetVector {
  const candidate = record(value, label, fail) as BudgetVector
  try {
    assertBudgetVector(candidate, label)
  } catch (error) {
    fail(error instanceof Error ? error.message : `${label} is invalid`)
  }
  return candidate
}

function sameBudget(left: BudgetVector, right: BudgetVector): boolean {
  return BUDGET_DIMENSIONS.every(dimension => left[dimension] === right[dimension])
}

function validatePermission(data: unknown, fail: InvariantFailure, rootLabel = 'runtime/permission data'): void {
  let current: unknown = data
  let depth = 0
  while (current !== undefined) {
    const label = depth === 0 ? rootLabel : `${rootLabel} ceiling ${depth}`
    const value = record(current, label, fail)
    if (!decisions.has(value.defaultDecision as CapabilityDecision)) fail(`${label} defaultDecision is invalid`)
    if (!Array.isArray(value.rules)) fail(`${label} rules must be an array`)
    for (const [index, raw] of value.rules.entries()) {
      const rule = record(raw, `${label} rule ${index}`, fail)
      nonEmptyString(rule.capability, `${label} rule ${index} capability`, fail)
      if (!decisions.has(rule.decision as CapabilityDecision)) fail(`${label} rule ${index} decision is invalid`)
      if (!sources.has(rule.source as CapabilityPermission['source'])) fail(`${label} rule ${index} source is invalid`)
      const resource = record(rule.resource, `${label} rule ${index} resource`, fail)
      if (!resourceKinds.has(String(resource.kind))) fail(`${label} rule ${index} resource kind is invalid`)
      nonEmptyString(resource.value, `${label} rule ${index} resource value`, fail)
    }
    current = value.ceiling
    depth++
    if (depth > 1024) fail(`${rootLabel} ceiling depth exceeds 1024`)
  }
}

function validateBudgetSnapshot(data: unknown, fail: InvariantFailure): void {
  const value = record(data, 'runtime/budget data', fail)
  const limits = budgetVector(value.limits, 'runtime/budget limits', fail)
  const consumed = budgetVector(value.consumed, 'runtime/budget consumed', fail)
  const remaining = budgetVector(value.remaining, 'runtime/budget remaining', fail)
  if (!sameBudget(remaining, remainingBudget(limits, consumed))) fail('runtime/budget remaining does not match limits minus consumed')
}

function validateBudgetCharge(data: unknown, fail: InvariantFailure): 'delegated' | 'local' {
  const value = record(data, 'runtime/budget-charge data', fail)
  const charge = budgetVector(value.charge, 'runtime/budget-charge charge', fail)
  if (!BUDGET_DIMENSIONS.some(dimension => (charge[dimension] ?? 0) > 0)) {
    fail('runtime/budget-charge must contain at least one positive debit')
  }
  const reason = String(value.reason)
  if (!['tool-dispatch', 'tool-settle', 'agent-start', 'provider-cost', 'runtime', 'delegated'].includes(reason)) {
    fail('runtime/budget-charge reason is invalid')
  }
  if (value.callId !== undefined) nonEmptyString(value.callId, 'runtime/budget-charge callId', fail)
  if (reason === 'delegated') {
    nonEmptyString(value.sourceSession, 'runtime/budget-charge sourceSession', fail)
    return 'delegated'
  }
  if (value.sourceSession !== undefined) fail('non-delegated runtime/budget-charge cannot carry sourceSession')
  return 'local'
}

function validateDelegation(data: unknown, fail: InvariantFailure): string {
  const value = record(data, 'runtime/delegation data', fail)
  const parentSession = nonEmptyString(value.parentSession, 'runtime/delegation parentSession', fail)
  validatePermission(value.permissionCeiling, fail, 'runtime/delegation permissionCeiling')
  budgetVector(value.budgetCeiling, 'runtime/delegation budgetCeiling', fail)
  return parentSession
}

function validateWorld(data: unknown, fail: InvariantFailure): void {
  const value = record(data, 'runtime/world data', fail)
  nonEmptyString(value.id, 'runtime/world id', fail)
  if (!Array.isArray(value.capabilities)) fail('runtime/world capabilities must be an array')
  const seen = new Set<string>()
  for (const capability of value.capabilities) {
    if (!worldCapabilities.has(String(capability))) fail(`runtime/world capability ${String(capability)} is invalid`)
    if (seen.has(String(capability))) fail(`runtime/world capability ${String(capability)} is duplicated`)
    seen.add(String(capability))
  }
  const filePolicy = record(value.filePolicy, 'runtime/world filePolicy', fail)
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(String(filePolicy.mode))) {
    fail('runtime/world filePolicy mode is invalid')
  }
  nonEmptyString(filePolicy.workspaceRoot, 'runtime/world workspaceRoot', fail)
}

function validateConfig(data: unknown, fail: InvariantFailure): void {
  const value = record(data, 'runtime/config data', fail)
  if (!agentKinds.has(String(value.agentKind))) fail('runtime/config agentKind is invalid')
  nonEmptyString(value.provider, 'runtime/config provider', fail)
  nonEmptyString(value.model, 'runtime/config model', fail)
  if (value.maxTokens !== undefined) positiveSafeInteger(value.maxTokens, 'runtime/config maxTokens', fail)
  positiveSafeInteger(value.maxParallelToolCalls, 'runtime/config maxParallelToolCalls', fail)
  nonEmptyString(value.permissionPreset, 'runtime/config permissionPreset', fail)
}

function validateRequirement(value: unknown, label: string, fail: InvariantFailure): void {
  const requirement = record(value, label, fail)
  nonEmptyString(requirement.capability, `${label} capability`, fail)
  const resource = record(requirement.resource, `${label} resource`, fail)
  if (!resourceKinds.has(String(resource.kind))) fail(`${label} resource kind is invalid`)
  nonEmptyString(resource.value, `${label} resource value`, fail)
  if (requirement.access !== undefined && !accesses.has(requirement.access as CapabilityAccess)) {
    fail(`${label} access is invalid`)
  }
  if (requirement.risk !== undefined) nonNegativeSafeInteger(requirement.risk, `${label} risk`, fail)
  if (requirement.effect !== true) fail(`${label} must describe an effect=true requirement`)
}

function cloneTrace(source: Trace): Trace {
  return {
    openStep: source.openStep,
    refs: { ...source.refs },
    authoritativeCalls: new Set(source.authoritativeCalls),
    effects: new Map([...source.effects].map(([id, effect]) => [id, { ...effect }])),
  }
}

function validateRuntimeRefs(event: SessionEvent<'step/snapshot'>, trace: Trace, fail: InvariantFailure): void {
  const refs = event.data.refs as typeof event.data.refs & RuntimeRefs
  const values = [refs.permission, refs.budget, refs.world, refs.config]
  const any = values.some(value => value !== undefined)
  const all = values.every(value => value !== undefined)
  if (any && !all) fail('step/snapshot runtime refs must be all present or all absent')

  const latestValues = [trace.refs.permission, trace.refs.budget, trace.refs.world, trace.refs.config]
  const runtimeActive = latestValues.some(value => value !== undefined)
  if (!runtimeActive) return
  if (!all) fail('step/snapshot must cite runtime permission/budget/world/config after runtime policy becomes active')
  if (trace.refs.delegation !== undefined && refs.delegation === undefined) {
    fail('step/snapshot must cite runtime/delegation after delegated runtime policy becomes active')
  }
  if (trace.refs.delegation === undefined && refs.delegation !== undefined) {
    fail('step/snapshot cannot cite runtime/delegation when no delegation event is active')
  }

  for (const [key, expected] of Object.entries(trace.refs) as [keyof RuntimeRefs, number | undefined][]) {
    const actual = refs[key]
    if (expected !== undefined && actual !== expected) {
      fail(`step/snapshot ${key} ref ${String(actual)} does not match latest runtime/${key} seq ${expected}`)
    }
    if (actual !== undefined && (!Number.isSafeInteger(actual) || actual < 0 || actual >= event.seq)) {
      fail(`step/snapshot ${key} ref must point backward to a non-negative safe integer`)
    }
  }
}

function applyEvent(session: Session, trace: Trace, event: SessionEvent, fail: InvariantFailure): void {
  switch (event.type) {
    case 'step/start':
      trace.openStep = true
      return
    case 'step/end': {
      const openEffects = [...trace.effects].filter(([, effect]) => !effect.settled).map(([id]) => id)
      if (openEffects.length > 0) fail(`step/end leaves world effects without receipts: ${openEffects.join(', ')}`)
      trace.openStep = false
      trace.authoritativeCalls.clear()
      trace.effects.clear()
      return
    }
    case 'tool/call':
      trace.authoritativeCalls.add(String(event.data.callId))
      return
    case 'tool/result':
      if (event.surfaceOp === 'append') trace.authoritativeCalls.delete(String(event.data.message.source.callId))
      return
    case 'tool/code-dispatch-start':
      trace.authoritativeCalls.add(String(event.data.subCallId))
      return
    case 'tool/code-dispatch':
      trace.authoritativeCalls.delete(String(event.data.subCallId))
      return
    case 'runtime/delegation': {
      if (trace.openStep) fail('runtime/delegation must be appended outside an open step')
      const parentSession = validateDelegation(event.data, fail)
      const boundary = session.header.seedLength ?? 0
      if (event.seq >= boundary) {
        if (session.header.parentSession === undefined) fail('active runtime/delegation requires session.header.parentSession')
        if (session.header.parentSession !== parentSession) {
          fail(`runtime/delegation parentSession ${parentSession} does not match session header ${String(session.header.parentSession)}`)
        }
        if (trace.refs.delegation !== undefined && trace.refs.delegation >= boundary) {
          fail('runtime/delegation may be captured only once for the active child lineage')
        }
      }
      trace.refs.delegation = event.seq
      return
    }
    case 'runtime/permission':
      if (!trace.openStep) fail('runtime/permission must be appended inside an open step')
      validatePermission(event.data, fail)
      trace.refs.permission = event.seq
      return
    case 'runtime/budget':
      if (!trace.openStep) fail('runtime/budget must be appended inside an open step')
      validateBudgetSnapshot(event.data, fail)
      trace.refs.budget = event.seq
      return
    case 'runtime/world':
      if (!trace.openStep) fail('runtime/world must be appended inside an open step')
      validateWorld(event.data, fail)
      trace.refs.world = event.seq
      return
    case 'runtime/config':
      if (!trace.openStep) fail('runtime/config must be appended inside an open step')
      validateConfig(event.data, fail)
      trace.refs.config = event.seq
      return
    case 'runtime/budget-charge': {
      const kind = validateBudgetCharge(event.data, fail)
      if (kind === 'local' && !trace.openStep) fail('local runtime/budget-charge must be appended inside an open step')
      return
    }
    case 'step/snapshot':
      validateRuntimeRefs(event, trace, fail)
      return
    case 'world/effect-start': {
      if (!trace.openStep) fail('world/effect-start must be appended inside an open step')
      const data = record(event.data, 'world/effect-start data', fail)
      const receiptId = nonEmptyString(data.receiptId, 'world/effect-start receiptId', fail)
      const callId = nonEmptyString(data.callId, 'world/effect-start callId', fail)
      const toolName = nonEmptyString(data.toolName, 'world/effect-start toolName', fail)
      const startedAt = nonNegativeSafeInteger(data.startedAt, 'world/effect-start startedAt', fail)
      if (!Array.isArray(data.requirements) || data.requirements.length === 0) {
        fail('world/effect-start requirements must be a non-empty array')
      }
      data.requirements.forEach((requirement, index) => validateRequirement(requirement, `world/effect-start requirement ${index}`, fail))
      if (!trace.authoritativeCalls.has(callId)) fail(`world/effect-start ${receiptId} has no prior authoritative tool call ${callId}`)
      if (trace.effects.has(receiptId)) fail(`world/effect-start repeats receiptId ${receiptId}`)
      trace.effects.set(receiptId, { seq: event.seq, callId, toolName, startedAt, settled: false })
      return
    }
    case 'world/effect-receipt': {
      if (!trace.openStep) fail('world/effect-receipt must be appended inside an open step')
      const data = record(event.data, 'world/effect-receipt data', fail)
      const receiptId = nonEmptyString(data.receiptId, 'world/effect-receipt receiptId', fail)
      const effect = trace.effects.get(receiptId)
      if (effect === undefined) fail(`world/effect-receipt ${receiptId} has no matching start`)
      if (effect.settled) fail(`world/effect-receipt ${receiptId} is duplicated`)
      const startSeq = nonNegativeSafeInteger(data.startSeq, 'world/effect-receipt startSeq', fail)
      const callId = nonEmptyString(data.callId, 'world/effect-receipt callId', fail)
      const toolName = nonEmptyString(data.toolName, 'world/effect-receipt toolName', fail)
      const endedAt = nonNegativeSafeInteger(data.endedAt, 'world/effect-receipt endedAt', fail)
      if (startSeq !== effect.seq || callId !== effect.callId || toolName !== effect.toolName) {
        fail(`world/effect-receipt ${receiptId} identity diverges from its start`)
      }
      if (data.status !== 'succeeded' && data.status !== 'failed') fail(`world/effect-receipt ${receiptId} status is invalid`)
      if (endedAt < effect.startedAt) fail(`world/effect-receipt ${receiptId} endedAt precedes startedAt`)
      effect.settled = true
      return
    }
    default:
      return
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const traces = new WeakMap<Session, Trace>()
  const staged = new WeakMap<SessionEvent, { session: Session; trace: Trace }>()

  const seed = (session: Session): Trace => {
    const trace: Trace = { openStep: false, refs: {}, authoritativeCalls: new Set(), effects: new Map() }
    for (const event of session.events) applyEvent(session, trace, event, fail)
    traces.set(session, trace)
    return trace
  }

  ctx.sessions.list().forEach(seed)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const current = traces.get(session) ?? seed(session)
    const candidate = cloneTrace(current)
    applyEvent(session, candidate, event, fail)
    staged.set(event, { session, trace: candidate })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    if (candidate === undefined || candidate.session !== session) return fail('session/event reached publication without runtime-policy validation')
    staged.delete(event)
    traces.set(session, candidate.trace)
  }, { global: true })
}, { inject: ['sessions'] })

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
