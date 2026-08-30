/** Harness 2.0 execution-policy spine: permission, budget, world freeze, and effect receipts. */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue, type EpochHeader, type Session, type SessionEvent, type StepSnapshotRefs } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {
  AgentKind,
  BudgetVector,
  CapabilityAccess,
  CapabilityDecision,
  CapabilityPermission,
  CapabilityPermissionSnapshot,
  CapabilityRequirement,
  ExecutionWorldSnapshot,
  GlobalBudgetCharge,
  GlobalBudgetSnapshot,
  ResolvedRuntimeConfigSnapshot,
  RuntimeDelegationSnapshot,
  RuntimeSnapshotRefs,
  WorldEffectReceipt,
} from './types.ts'
import { addBudget, assertBudgetVector, budgetExceeded, budgetSnapshot, narrowBudgetLimits } from './budget.ts'
import { evaluateCapabilityPermission } from './permission.ts'
import { ResourceScheduler } from './resource-scheduler.ts'

export type * from './types.ts'
export * from './budget.ts'
export * from './permission.ts'
export * from './resource-scheduler.ts'

export interface Config {
  /** Optional deployment-wide hard ceilings. Omission means unbounded for that dimension. */
  readonly limits?: BudgetVector
  /** Additional capability rules layered over the sandbox-derived rules. */
  readonly permissions?: readonly CapabilityPermission[]
  /** Default decision for capabilities not named by any rule. */
  readonly defaultDecision?: CapabilityDecision
}

/** Optional declaration hook for tools/plugins that can classify their own concrete execution resources. */
export type ToolRequirementClassifier = (exec: Readonly<ToolExecution>) => readonly CapabilityRequirement[] | undefined
export interface ToolRequirementClassifierOptions { readonly priority?: number }
interface RegisteredRequirementClassifier {
  readonly id: string
  readonly priority: number
  readonly order: number
  readonly classify: ToolRequirementClassifier
}

const budgetSchema = z.object({
  tokens: z.natural().max(Number.MAX_SAFE_INTEGER),
  costMicros: z.natural().max(Number.MAX_SAFE_INTEGER),
  wallTimeMs: z.natural().max(Number.MAX_SAFE_INTEGER),
  toolCalls: z.natural().max(Number.MAX_SAFE_INTEGER),
  agentStarts: z.natural().max(Number.MAX_SAFE_INTEGER),
  riskPoints: z.natural().max(Number.MAX_SAFE_INTEGER),
})

const resourceSchema = z.object({
  kind: z.union(['file', 'process', 'network', 'browser', 'computer', 'tool', 'agent', 'custom'] as const).required(),
  value: z.string().required(),
})

const permissionSchema = z.object({
  capability: z.string().required(),
  resource: resourceSchema.required(),
  decision: z.union(['allow', 'ask', 'deny'] as const).required(),
  source: z.union(['sandbox', 'config', 'delegation', 'runtime'] as const).required(),
})

export const Config: z<Config> = z.object({
  limits: budgetSchema,
  defaultDecision: z.union(['allow', 'ask', 'deny'] as const).default('allow'),
  permissions: z.array(permissionSchema).default([]),
}) as unknown as z<Config>

declare module '@deepseek-ai/cordis' {
  interface Context { runtimePolicy: RuntimePolicyService }
}

const resourceKinds = new Set(['file', 'process', 'network', 'browser', 'computer', 'tool', 'agent', 'custom'])
const accesses = new Set<CapabilityAccess>(['read', 'write', 'execute', 'control'])

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

type RuntimeSnapshotEventType = 'runtime/permission' | 'runtime/budget' | 'runtime/world' | 'runtime/config'

function appendOrReuse(
  session: Session,
  type: RuntimeSnapshotEventType,
  data: never,
): number {
  const latest = session.events.findLast(event => event.type === type)
  if (latest !== undefined && sameJson(latest.data, data)) return latest.seq
  return session.append(type, data).seq
}

/** Return only the delegation snapshot owned by this session's direct parent lineage. */
function delegationEvent(session: Session): SessionEvent<'runtime/delegation'> | undefined {
  const parentSession = session.header.parentSession
  if (parentSession === undefined) return undefined
  return session.events.findLast((event): event is SessionEvent<'runtime/delegation'> => (
    event.type === 'runtime/delegation' && event.data.parentSession === parentSession
  ))
}

function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

interface UsageSample {
  readonly turn: number
  readonly step: number
  readonly tokens: number
}

function usageSample(event: SessionEvent): UsageSample | undefined {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    return { turn: event.data.turn, step: event.data.step, tokens: usageTokens(event.data.chunk.usage) }
  }
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    return { turn: event.data.turn, step: event.data.step, tokens: usageTokens(event.data.usage) }
  }
  return undefined
}

function usageStepKey(sample: Pick<UsageSample, 'turn' | 'step'>): string {
  return `${sample.turn}:${sample.step}`
}

/** Latest durable model-attempt boundary preceding one usage sample. */
function usageAttemptBoundary(
  events: readonly SessionEvent[],
  event: SessionEvent,
  sample: Pick<UsageSample, 'turn' | 'step'>,
): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index]
    if (candidate === undefined || candidate.seq >= event.seq || candidate.type !== 'step/snapshot') continue
    if (candidate.data.turn === sample.turn && candidate.data.step === sample.step) return candidate.seq
  }
  return undefined
}

/**
 * Return only the positive provider-usage delta introduced by one persisted
 * sample. Usage is cumulative only inside one model attempt: retries reuse the
 * same turn/step but own a new step/snapshot boundary and must be billed again.
 */
export function usageTokenDelta(events: readonly SessionEvent[], event: SessionEvent): number {
  const sample = usageSample(event)
  if (sample === undefined) return 0
  const boundary = usageAttemptBoundary(events, event, sample)
  let previous = 0
  for (const candidate of events) {
    if (candidate.seq >= event.seq) break
    if (boundary !== undefined && candidate.seq <= boundary) continue
    const prior = usageSample(candidate)
    if (prior === undefined || prior.turn !== sample.turn || prior.step !== sample.step) continue
    previous = Math.max(previous, prior.tokens)
  }
  return Math.max(0, sample.tokens - previous)
}

/** Fold durable charges plus the maximum provider usage observed in each model attempt. */
function foldCharges(events: readonly SessionEvent[]): BudgetVector {
  let consumed: BudgetVector = {}
  let tokens = 0
  const attemptBoundaryByStep = new Map<string, number>()
  const usageByAttempt = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'step/snapshot') {
      attemptBoundaryByStep.set(`${event.data.turn}:${event.data.step}`, event.seq)
    }
    const sample = usageSample(event)
    if (sample !== undefined) {
      const stepKey = usageStepKey(sample)
      const boundary = attemptBoundaryByStep.get(stepKey)
      const key = boundary === undefined ? stepKey : `${stepKey}@${boundary}`
      const previous = usageByAttempt.get(key) ?? 0
      if (sample.tokens > previous) {
        tokens += sample.tokens - previous
        usageByAttempt.set(key, sample.tokens)
      }
    }
    if (event.type === 'runtime/budget-charge') consumed = addBudget(consumed, event.data.charge)
  }
  if (tokens > 0) consumed = addBudget(consumed, { tokens })
  return consumed
}

/** Child budget accounting starts after its owned delegation snapshot, never inside an inherited fork seed. */
function foldSessionCharges(session: Session): BudgetVector {
  const delegation = delegationEvent(session)
  return foldCharges(delegation === undefined ? session.events : session.events.slice(delegation.seq + 1))
}

function requirementRisk(requirements: readonly CapabilityRequirement[]): number {
  return requirements.reduce((sum, requirement) => sum + (requirement.risk ?? 0), 0)
}

/** Transitional first-party classifier. P3 registrations may override this without changing RuntimePolicy. */
export function defaultToolRequirements(exec: Pick<ToolExecution, 'name' | 'arguments'>): CapabilityRequirement[] {
  const args = exec.arguments as Record<string, unknown> | undefined
  const stringArg = (...keys: string[]): string | undefined => {
    if (args === undefined || typeof args !== 'object') return undefined
    for (const key of keys) if (typeof args[key] === 'string') return args[key]
    return undefined
  }

  if (exec.name === 'read' || exec.name === 'read_image') {
    return [{ capability: 'file.read', resource: { kind: 'file', value: stringArg('file_path', 'path') ?? '*' }, access: 'read' }]
  }
  if (exec.name === 'glob' || exec.name === 'grep') {
    return [{ capability: 'file.search', resource: { kind: 'file', value: stringArg('path') ?? '*' }, access: 'read' }]
  }
  if (exec.name === 'write' || exec.name === 'edit' || exec.name === 'str_replace_editor') {
    return [{ capability: 'file.write', resource: { kind: 'file', value: stringArg('file_path', 'path') ?? '*' }, access: 'write', risk: 1, effect: true }]
  }
  if (exec.name === 'bash' || exec.name === 'pwsh') {
    return [{ capability: 'process.spawn', resource: { kind: 'process', value: stringArg('command') ?? exec.name }, access: 'execute', risk: 2, effect: true }]
  }
  if (exec.name === 'web_fetch') {
    return [{ capability: 'network.fetch', resource: { kind: 'network', value: stringArg('url') ?? '*' }, access: 'read' }]
  }
  if (exec.name === 'web_search') {
    return [{ capability: 'network.search', resource: { kind: 'network', value: '*' }, access: 'read' }]
  }
  if (exec.name === 'subagent' || exec.name.startsWith('subagent_')) {
    return [{ capability: 'agent.spawn', resource: { kind: 'agent', value: exec.name }, access: 'control', risk: 2, effect: true }]
  }
  if (exec.name === 'send_message' || exec.name === 'interrupt_agent' || exec.name === 'job_kill') {
    return [{ capability: 'agent.control', resource: { kind: 'agent', value: stringArg('agent_id', 'job_id') ?? '*' }, access: 'control', risk: 1, effect: true }]
  }

  // Unclassified tools must never become an implicit permission/effect hole.
  // They require explicit approval and receive a conservative effect receipt.
  // The wildcard resource is also a global scheduler barrier until a plugin
  // registers a precise classifier (which may explicitly return []).
  return [{
    capability: 'tool.execute',
    resource: { kind: 'tool', value: '*' },
    access: 'control',
    risk: 2,
    effect: true,
  }]
}

function normalizeRequirement(requirement: CapabilityRequirement, label: string): CapabilityRequirement {
  if (typeof requirement.capability !== 'string' || requirement.capability.trim().length === 0) {
    throw new TypeError(`${label}.capability must be a non-empty string`)
  }
  if (!resourceKinds.has(requirement.resource.kind)) throw new TypeError(`${label}.resource.kind is invalid`)
  if (typeof requirement.resource.value !== 'string' || requirement.resource.value.length === 0) {
    throw new TypeError(`${label}.resource.value must be a non-empty string`)
  }
  if (requirement.access !== undefined && !accesses.has(requirement.access)) throw new TypeError(`${label}.access is invalid`)
  if (requirement.risk !== undefined && (!Number.isSafeInteger(requirement.risk) || requirement.risk < 0)) {
    throw new TypeError(`${label}.risk must be a non-negative safe integer`)
  }
  if (requirement.effect !== undefined && typeof requirement.effect !== 'boolean') throw new TypeError(`${label}.effect must be boolean`)
  return Object.freeze({ ...requirement, resource: Object.freeze({ ...requirement.resource }) })
}

function canonicalRequirement(agent: Agent, requirement: CapabilityRequirement, workspaceRoot: string): CapabilityRequirement {
  if (requirement.resource.kind !== 'file' || requirement.resource.value === '*') return requirement
  const value = path.isAbsolute(requirement.resource.value)
    ? path.resolve(requirement.resource.value)
    : path.resolve(agent.session.header.cwd ?? workspaceRoot, requirement.resource.value)
  return Object.freeze({ ...requirement, resource: Object.freeze({ ...requirement.resource, value }) })
}

function agentKind(agent: Agent): AgentKind {
  const header = agent.session.header
  if (header.origin === 'subagent') return header.seedLength !== undefined && header.seedLength > 0 ? 'fork-agent' : 'subagent'
  return 'primary'
}

/** Runtime permission, budget, resource scheduling, and world-freeze service. */
export class RuntimePolicyService extends Service {
  static Config = Config
  static inject = ['tools', 'sandboxPolicy', 'permissionPresets', 'agentLoop', 'sessions']

  readonly limits: BudgetVector
  readonly resourceScheduler: ResourceScheduler = new ResourceScheduler()
  private readonly configuredPermissions: readonly CapabilityPermission[]
  private readonly defaultDecision: CapabilityDecision
  private readonly requirementClassifiers: RegisteredRequirementClassifier[] = []
  private readonly requirementCache = new WeakMap<ToolExecution, readonly CapabilityRequirement[]>()
  private nextRequirementClassifierOrder = 0

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'runtimePolicy')
    this.limits = { ...(config.limits ?? {}) }
    assertBudgetVector(this.limits, 'runtime-policy limits')
    this.configuredPermissions = [...(config.permissions ?? [])]
    this.defaultDecision = config.defaultDecision ?? 'allow'

    ctx.effect(() => () => {
      this.resourceScheduler.dispose(new Error('runtime policy disposed'))
    }, 'runtime-policy: dispose resource scheduler')

    // Internal signal: execution-domain facts are persisted before the core
    // writes the canonical step/snapshot envelope that references them.
    ctx.on('agent/step-snapshot', async (payload, next): Promise<StepSnapshotRefs> => {
      const base = await next()
      return { ...base, ...this.freeze(payload.agent, payload.header) }
    })

    ctx.on('tools/pre-execute', async (exec, next) => {
      const downstream = await next()
      if (exec.agent === undefined || downstream.kind === 'deny') return downstream
      const requirements = this.requirements(exec)
      let local: CapabilityDecision = 'allow'
      for (const requirement of requirements) {
        const decision = evaluateCapabilityPermission(this.permissionSnapshot(exec.agent), requirement)
        if (decision === 'deny') {
          return { kind: 'deny', reason: `runtime permission denied ${requirement.capability} on ${requirement.resource.value}` }
        }
        if (decision === 'ask') local = 'ask'
      }
      if (local === 'ask' || downstream.kind === 'ask') {
        if (downstream.kind === 'ask') {
          return downstream.reason === undefined ? { kind: 'ask' } : { kind: 'ask', reason: downstream.reason }
        }
        return { kind: 'ask', reason: 'runtime capability policy requires approval' }
      }
      return { kind: 'allow' }
    })

    // Only the body/around-dispatch stage overlaps. Resource locks therefore
    // compose beneath ordered pre-execute/approval and preserve model-order
    // result finalization in the existing AgentLoop scheduler.
    ctx.on('tools/execute', async (exec, next) => this.executeWithPolicy(exec, next))

    // Usage chunks are durable even when the provider request later fails. Mirror
    // each positive per-attempt delta immediately; a final assistant/message then
    // contributes only any remaining cumulative delta instead of double-counting.
    ctx.on('session/event', (session, event) => {
      if (session.header.parentSession === undefined) return
      const tokens = usageTokenDelta(session.events, event)
      if (tokens <= 0) return
      this.mirrorChargeToAncestors(session, { charge: { tokens }, reason: 'delegated', sourceSession: session.id })
    }, { global: true })
  }

  /**
   * Register a tool-owned requirement classifier. First non-undefined result wins.
   * @param id Stable classifier identifier.
   * @param classify Requirement classifier.
   * @param options Ordering options.
   * @returns Function that unregisters the classifier.
   */
  registerToolRequirements(
    id: string,
    classify: ToolRequirementClassifier,
    options: ToolRequirementClassifierOptions = {},
  ): () => void {
    if (id.trim().length === 0) throw new TypeError('tool requirement classifier id must be non-empty')
    if (this.requirementClassifiers.some(entry => entry.id === id)) {
      throw new Error(`tool requirement classifier "${id}" is already registered`)
    }
    const priority = options.priority ?? 0
    if (!Number.isFinite(priority)) throw new TypeError('tool requirement classifier priority must be finite')
    const entry: RegisteredRequirementClassifier = {
      id,
      priority,
      order: this.nextRequirementClassifierOrder++,
      classify,
    }
    this.requirementClassifiers.push(entry)
    this.requirementClassifiers.sort((left, right) => right.priority - left.priority || left.order - right.order)
    const dispose = this.ctx.effect(() => () => {
      const index = this.requirementClassifiers.indexOf(entry)
      if (index >= 0) this.requirementClassifiers.splice(index, 1)
    }, `runtimePolicy.registerToolRequirements(${id})`)
    return () => void dispose()
  }

  /**
   * Resolve requirements exactly once for a registry-minted execution. The
   * same frozen snapshot is reused by approval, resource scheduling, budget,
   * and effect auditing so a stateful classifier cannot make those stages drift.
   * @param exec Registry-minted tool execution.
   * @returns Detached normalized capability requirements.
   */
  requirements(exec: ToolExecution): CapabilityRequirement[] {
    const cached = this.requirementCache.get(exec)
    if (cached !== undefined) return [...cached]

    const workspaceRoot = exec.agent === undefined
      ? this.ctx.sandboxPolicy.workspaceRoot
      : this.ctx.sandboxPolicy.resolve({ session: exec.agent.session }).workspaceRoot
    let selected: readonly CapabilityRequirement[] | undefined
    for (const classifier of [...this.requirementClassifiers]) {
      const candidate = classifier.classify(exec)
      if (candidate === undefined) continue
      selected = candidate
      break
    }
    const requirements = selected ?? defaultToolRequirements(exec)
    const normalized = Object.freeze([...requirements].map((requirement, index) => {
      const value = normalizeRequirement(requirement, `tool requirement ${index}`)
      return exec.agent === undefined ? value : canonicalRequirement(exec.agent, value, workspaceRoot)
    }))
    this.requirementCache.set(exec, normalized)
    return [...normalized]
  }

  /**
   * Resolve the effective permission snapshot for an agent.
   * @param agent Agent whose policy is resolved.
   * @returns Effective immutable permission snapshot.
   */
  permissionSnapshot(agent: Agent): CapabilityPermissionSnapshot {
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    const rules: CapabilityPermission[] = [
      { capability: 'file.read', resource: { kind: 'file', value: '*' }, decision: 'allow', source: 'sandbox' },
      { capability: 'file.search', resource: { kind: 'file', value: '*' }, decision: 'allow', source: 'sandbox' },
      // A tool that has not declared concrete requirements is never treated as
      // requirement-free. The conservative fallback classifier emits this
      // capability, which always asks unless a precise classifier replaces it.
      { capability: 'tool.execute', resource: { kind: 'tool', value: '*' }, decision: 'ask', source: 'runtime' },
    ]
    if (policy.mode === 'read-only') {
      rules.push({ capability: 'file.write', resource: { kind: 'file', value: '*' }, decision: 'deny', source: 'sandbox' })
    } else if (policy.mode === 'workspace-write') {
      rules.push(
        { capability: 'file.write', resource: { kind: 'file', value: '*' }, decision: 'ask', source: 'sandbox' },
        { capability: 'file.write', resource: { kind: 'file', value: `${policy.workspaceRoot.replace(/\/$/, '')}/**` }, decision: 'allow', source: 'sandbox' },
      )
    } else {
      rules.push({ capability: 'file.write', resource: { kind: 'file', value: '*' }, decision: 'allow', source: 'sandbox' })
    }
    rules.push(...this.configuredPermissions)
    const delegation = delegationEvent(agent.session)?.data
    return {
      defaultDecision: this.defaultDecision,
      rules,
      ...(delegation === undefined ? {} : { ceiling: delegation.permissionCeiling }),
    }
  }

  /**
   * Resolve effective session-local budget limits.
   * @param session Session whose delegation ceiling is applied.
   * @returns Effective budget limits.
   */
  budgetLimits(session: Session): BudgetVector {
    return narrowBudgetLimits(this.limits, delegationEvent(session)?.data.budgetCeiling)
  }

  /**
   * Resolve the current global budget snapshot.
   * @param session Session whose durable charges are folded.
   * @returns Current limits, consumption, and remaining budget.
   */
  budgetSnapshot(session: Session): GlobalBudgetSnapshot {
    return budgetSnapshot(this.budgetLimits(session), foldSessionCharges(session))
  }

  /**
   * Capture the parent's exact permission ceiling and remaining budget before
   * the child publication boundary. A later parent policy switch belongs to
   * the parent's future and cannot widen an already delegated child.
   * @param parent Parent agent at the delegation boundary.
   * @returns Frozen child delegation ceiling.
   */
  captureDelegation(parent: Agent): RuntimeDelegationSnapshot {
    const permissionCeiling = snapshotJsonValue(this.permissionSnapshot(parent))
    const budgetCeiling = snapshotJsonValue(this.budgetSnapshot(parent.session).remaining)
    if (permissionCeiling === undefined || budgetCeiling === undefined) {
      throw new Error('runtime delegation snapshot is not losslessly JSON-serializable')
    }
    return Object.freeze({
      parentSession: parent.session.id,
      permissionCeiling,
      budgetCeiling,
    })
  }

  /**
   * Capture the execution world visible to an agent.
   * @param agent Agent whose sandbox and capabilities are captured.
   * @returns Execution world snapshot.
   */
  worldSnapshot(agent: Agent): ExecutionWorldSnapshot {
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    const capabilities: ExecutionWorldSnapshot['capabilities'][number][] = ['fs', 'process']
    if (this.ctx.get('web') !== undefined) capabilities.push('network', 'browser')
    if (this.ctx.get('computer') !== undefined) capabilities.push('computer')
    return {
      id: `local:${policy.workspaceRoot}`,
      capabilities,
      filePolicy: { mode: policy.mode, workspaceRoot: policy.workspaceRoot },
    }
  }

  /**
   * Capture the resolved runtime configuration for one epoch.
   * @param agent Agent whose runtime configuration is captured.
   * @param header Durable epoch header.
   * @returns Resolved runtime configuration snapshot.
   */
  resolvedConfig(agent: Agent, header: EpochHeader): ResolvedRuntimeConfigSnapshot {
    return {
      agentKind: agentKind(agent),
      provider: header.config.provider,
      model: header.config.model,
      ...header.config.maxTokens === undefined ? {} : { maxTokens: header.config.maxTokens },
      maxParallelToolCalls: this.ctx.agentLoop.config.maxParallelToolCalls,
      permissionPreset: this.ctx.permissionPresets.current(agent.session.events),
    }
  }

  /**
   * Persist or reuse all execution-domain freeze facts.
   * @param agent Agent whose execution facts are frozen.
   * @param header Durable epoch header.
   * @returns Exact sequence references for the frozen facts.
   */
  freeze(agent: Agent, header: EpochHeader): RuntimeSnapshotRefs {
    const delegation = delegationEvent(agent.session)?.seq
    const permission = appendOrReuse(agent.session, 'runtime/permission', this.permissionSnapshot(agent) as never)
    const budget = appendOrReuse(agent.session, 'runtime/budget', this.budgetSnapshot(agent.session) as never)
    const world = appendOrReuse(agent.session, 'runtime/world', this.worldSnapshot(agent) as never)
    const config = appendOrReuse(agent.session, 'runtime/config', this.resolvedConfig(agent, header) as never)
    return {
      permission,
      budget,
      world,
      config,
      ...(delegation === undefined ? {} : { delegation }),
    }
  }

  /** Walk the currently-live parent chain. Missing ancestors end live mirroring but never widen the child's captured ceiling. */
  private liveAncestors(session: Session): Session[] {
    const ancestors: Session[] = []
    const seen = new Set<string>([session.id])
    let parentId = session.header.parentSession
    let depth = 0
    while (parentId !== undefined) {
      if (seen.has(parentId)) throw new Error(`runtime budget lineage cycle at session ${parentId}`)
      seen.add(parentId)
      const parent = this.ctx.sessions.get(parentId)
      if (parent === undefined) break
      ancestors.push(parent)
      parentId = parent.header.parentSession
      depth++
      if (depth > 1024) throw new Error('runtime budget lineage depth exceeds 1024')
    }
    return ancestors
  }

  private mirrorChargeToAncestors(session: Session, data: GlobalBudgetCharge): void {
    assertBudgetVector(data.charge, 'delegated runtime budget charge')
    for (const ancestor of this.liveAncestors(session)) {
      ancestor.append('runtime/budget-charge', {
        charge: data.charge,
        reason: 'delegated',
        ...(data.callId === undefined ? {} : { callId: data.callId }),
        sourceSession: session.id,
      })
    }
  }

  private admitCharge(session: Session, data: GlobalBudgetCharge): string | undefined {
    assertBudgetVector(data.charge, 'runtime budget charge')
    const lineage = [session, ...this.liveAncestors(session)]
    for (const target of lineage) {
      const exceeded = budgetExceeded(this.budgetLimits(target), foldSessionCharges(target), data.charge)
      if (exceeded !== undefined) {
        return target === session
          ? `global ${exceeded} budget exceeded`
          : `ancestor ${target.id} ${exceeded} budget exceeded`
      }
    }

    // Check + all durable debits are synchronous: parallel siblings cannot both
    // observe the same parent remainder before either reservation is recorded.
    session.append('runtime/budget-charge', data)
    for (const ancestor of lineage.slice(1)) {
      ancestor.append('runtime/budget-charge', {
        charge: data.charge,
        reason: 'delegated',
        ...(data.callId === undefined ? {} : { callId: data.callId }),
        sourceSession: session.id,
      })
    }
    return undefined
  }

  /** Record observed usage even when it crosses a ceiling; future admission sees the overrun. */
  private recordCharge(session: Session, data: GlobalBudgetCharge): void {
    assertBudgetVector(data.charge, 'runtime budget charge')
    session.append('runtime/budget-charge', data)
    this.mirrorChargeToAncestors(session, data)
  }

  private async executeWithPolicy(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const requirements = this.requirements(exec)
    const lease = await this.resourceScheduler.acquire(requirements, exec.signal)
    try {
      exec.signal.throwIfAborted()
      const agent = exec.agent
      if (agent === undefined) return await next()

      const riskPoints = requirementRisk(requirements)
      const agentStarts = requirements.some(requirement => requirement.capability === 'agent.spawn') ? 1 : 0
      const charge: BudgetVector = {
        toolCalls: 1,
        ...(riskPoints > 0 ? { riskPoints } : {}),
        ...(agentStarts > 0 ? { agentStarts } : {}),
      }
      const denial = this.admitCharge(agent.session, { charge, reason: 'tool-dispatch', callId: exec.callId })
      if (denial !== undefined) {
        return {
          content: [{ type: 'text', text: `Error: ${denial}` }],
          isError: true,
          error: { message: denial, info: { name: 'BudgetExceededError', code: 'GLOBAL_BUDGET_EXCEEDED' } },
        }
      }

      const effects = requirements.filter(requirement => requirement.effect === true)
      const startedAt = Date.now()
      let startSeq: number | undefined
      let receiptId: string | undefined
      if (effects.length > 0) {
        receiptId = randomUUID()
        startSeq = agent.session.append('world/effect-start', {
          receiptId,
          callId: exec.callId,
          toolName: exec.name,
          requirements: effects,
          startedAt,
        }).seq
      }

      try {
        const result = await next()
        const elapsed = Math.max(0, Date.now() - startedAt)
        if (elapsed > 0) {
          this.recordCharge(agent.session, { charge: { wallTimeMs: elapsed }, reason: 'tool-settle', callId: exec.callId })
        }
        if (startSeq !== undefined && receiptId !== undefined) {
          const receipt: WorldEffectReceipt = {
            receiptId,
            startSeq,
            callId: exec.callId,
            toolName: exec.name,
            status: result.isError ? 'failed' : 'succeeded',
            endedAt: Date.now(),
          }
          agent.session.append('world/effect-receipt', receipt)
        }
        return result
      } catch (error: unknown) {
        const elapsed = Math.max(0, Date.now() - startedAt)
        if (elapsed > 0) {
          this.recordCharge(agent.session, { charge: { wallTimeMs: elapsed }, reason: 'tool-settle', callId: exec.callId })
        }
        if (startSeq !== undefined && receiptId !== undefined) {
          agent.session.append('world/effect-receipt', {
            receiptId,
            startSeq,
            callId: exec.callId,
            toolName: exec.name,
            status: 'failed',
            endedAt: Date.now(),
          })
        }
        throw error
      }
    } finally {
      lease.release()
    }
  }
}

export default RuntimePolicyService
