/** Harness 2.0 execution-policy spine: permission, budget, world freeze, and effect receipts. */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, Session, SessionEvent, StepSnapshotRefs } from '@deepseek-ai/dsh-session'
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
  ResolvedRuntimeConfigSnapshot,
  RuntimeSnapshotRefs,
  WorldEffectReceipt,
} from './types.ts'
import { addBudget, assertBudgetVector, budgetExceeded, budgetSnapshot } from './budget.ts'
import { evaluateCapabilityPermission } from './permission.ts'

export type * from './types.ts'
export * from './budget.ts'
export * from './permission.ts'

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

function appendOrReuse<T extends 'runtime/permission' | 'runtime/budget' | 'runtime/world' | 'runtime/config'>(
  session: Session,
  type: T,
  data: Parameters<Session['append']>[1],
): number {
  const latest = session.events.findLast(event => event.type === type)
  if (latest !== undefined && sameJson(latest.data, data)) return latest.seq
  return session.append(type, data as never).seq
}

function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

function usageSample(event: SessionEvent): { turn: number; step: number; tokens: number } | undefined {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
    return { turn: event.data.turn, step: event.data.step, tokens: usageTokens(event.data.chunk.usage) }
  }
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    return { turn: event.data.turn, step: event.data.step, tokens: usageTokens(event.data.usage) }
  }
  return undefined
}

/** Fold durable charges plus provider usage, replacing repeated samples for the same step. */
function foldCharges(events: readonly SessionEvent[]): BudgetVector {
  let consumed: BudgetVector = {}
  let tokens = 0
  let lastUsage: { turn: number; step: number; tokens: number } | undefined
  for (const event of events) {
    const sample = usageSample(event)
    if (sample !== undefined) {
      if (lastUsage !== undefined && lastUsage.turn === sample.turn && lastUsage.step === sample.step) {
        tokens = tokens - lastUsage.tokens + sample.tokens
      } else {
        tokens += sample.tokens
      }
      lastUsage = sample
    }
    if (event.type === 'runtime/budget-charge') consumed = addBudget(consumed, event.data.charge)
  }
  if (tokens > 0) consumed = addBudget(consumed, { tokens })
  return consumed
}

function requirementRisk(requirements: readonly CapabilityRequirement[]): number {
  return requirements.reduce((sum, requirement) => sum + (requirement.risk ?? 0), 0)
}

/** Transitional first-party classifier. P3 registrations may override this without changing RuntimePolicy. */
export function defaultToolRequirements(exec: Pick<ToolExecution, 'name' | 'arguments'>): CapabilityRequirement[] {
  const args = exec.arguments as Record<string, unknown> | undefined
  const stringArg = (...keys: string[]): string | undefined => {
    if (args === undefined || typeof args !== 'object') return undefined
    for (const key of keys) if (typeof args[key] === 'string') return args[key] as string
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
  // They require explicit approval and receive a conservative effect receipt
  // until a plugin registers a more precise classifier (which may return []).
  return [{
    capability: 'tool.execute',
    resource: { kind: 'tool', value: exec.name },
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
  return { ...requirement, resource: { ...requirement.resource, value } }
}

function agentKind(agent: Agent): AgentKind {
  const header = agent.session.header
  if (header.origin === 'subagent') return header.seedLength !== undefined && header.seedLength > 0 ? 'fork-agent' : 'subagent'
  return 'primary'
}

export class RuntimePolicyService extends Service {
  static Config = Config
  static inject = ['tools', 'sandboxPolicy', 'permissionPresets', 'agentLoop']

  readonly limits: BudgetVector
  private readonly configuredPermissions: readonly CapabilityPermission[]
  private readonly defaultDecision: CapabilityDecision
  private readonly requirementClassifiers: RegisteredRequirementClassifier[] = []
  private nextRequirementClassifierOrder = 0

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'runtimePolicy')
    this.limits = { ...(config.limits ?? {}) }
    assertBudgetVector(this.limits, 'runtime-policy limits')
    this.configuredPermissions = [...(config.permissions ?? [])]
    this.defaultDecision = config.defaultDecision ?? 'allow'

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
        return { kind: 'ask', reason: downstream.kind === 'ask' ? downstream.reason : 'runtime capability policy requires approval' }
      }
      return { kind: 'allow' }
    })

    // This boundary is after approval and before the tool body, so every real
    // state-changing operation receives an effect-start record first.
    ctx.on('tools/execute', async (exec, next) => this.executeWithPolicy(exec, next))
  }

  /** Register a tool-owned requirement classifier. First non-undefined result wins. */
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

  requirements(exec: ToolExecution): CapabilityRequirement[] {
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
    return [...requirements].map((requirement, index) => {
      const normalized = normalizeRequirement(requirement, `tool requirement ${index}`)
      return exec.agent === undefined ? normalized : canonicalRequirement(exec.agent, normalized, workspaceRoot)
    })
  }

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
    return { defaultDecision: this.defaultDecision, rules }
  }

  budgetSnapshot(session: Session) {
    return budgetSnapshot(this.limits, foldCharges(session.events))
  }

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

  /** Persist/reuse all execution-domain freeze facts and return their exact seqs. */
  freeze(agent: Agent, header: EpochHeader): RuntimeSnapshotRefs {
    const permission = appendOrReuse(agent.session, 'runtime/permission', this.permissionSnapshot(agent) as never)
    const budget = appendOrReuse(agent.session, 'runtime/budget', this.budgetSnapshot(agent.session) as never)
    const world = appendOrReuse(agent.session, 'runtime/world', this.worldSnapshot(agent) as never)
    const config = appendOrReuse(agent.session, 'runtime/config', this.resolvedConfig(agent, header) as never)
    return { permission, budget, world, config }
  }

  private admitCharge(session: Session, data: GlobalBudgetCharge): string | undefined {
    const exceeded = budgetExceeded(this.limits, foldCharges(session.events), data.charge)
    if (exceeded !== undefined) return `global ${exceeded} budget exceeded`
    session.append('runtime/budget-charge', data)
    return undefined
  }

  /** Record observed usage even when it crosses a ceiling; future admission sees the overrun. */
  private recordCharge(session: Session, data: GlobalBudgetCharge): void {
    assertBudgetVector(data.charge, 'runtime budget charge')
    session.append('runtime/budget-charge', data)
  }

  private async executeWithPolicy(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const agent = exec.agent
    if (agent === undefined) return next()
    const requirements = this.requirements(exec)
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
  }
}

export default RuntimePolicyService
