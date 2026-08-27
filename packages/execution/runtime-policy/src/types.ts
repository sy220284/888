import type { CallId } from '@deepseek-ai/dsh-llm/brand'

/** Closed permission decision ordered from most to least permissive. */
export type CapabilityDecision = 'allow' | 'ask' | 'deny'

/** Resource addressed by a capability decision. `value` is canonical within its kind. */
export interface CapabilityResource {
  readonly kind: 'file' | 'process' | 'network' | 'browser' | 'computer' | 'tool' | 'agent' | 'custom'
  readonly value: string
}

/** One concrete operation the runtime is about to perform. */
export interface CapabilityRequirement {
  readonly capability: string
  readonly resource: CapabilityResource
  /** Non-negative risk points charged when the operation actually dispatches. */
  readonly risk?: number
  /** True when the operation may change state outside the Harness event log. */
  readonly effect?: boolean
}

/** Fine-grained capability + resource rule. `*` and a trailing `/**` are supported selectors. */
export interface CapabilityPermission {
  readonly capability: string
  readonly resource: CapabilityResource
  readonly decision: CapabilityDecision
  readonly source: 'sandbox' | 'config' | 'delegation' | 'runtime'
}

/** Canonical permission state frozen for one or more model attempts. */
export interface CapabilityPermissionSnapshot {
  readonly defaultDecision: CapabilityDecision
  readonly rules: readonly CapabilityPermission[]
}

/** Budget dimensions owned by one global ledger. All values are non-negative safe integers. */
export type BudgetDimension = 'tokens' | 'costMicros' | 'wallTimeMs' | 'toolCalls' | 'agentStarts' | 'riskPoints'
export type BudgetVector = Partial<Record<BudgetDimension, number>>

/** Canonical budget state at a model-dispatch boundary. */
export interface GlobalBudgetSnapshot {
  readonly limits: BudgetVector
  readonly consumed: BudgetVector
  readonly remaining: BudgetVector
}

/** Durable debit applied when a real operation starts or settles. */
export interface GlobalBudgetCharge {
  readonly charge: BudgetVector
  readonly reason: 'tool-dispatch' | 'tool-settle' | 'agent-start' | 'provider-cost' | 'runtime'
  readonly callId?: CallId
}

/** The execution substrates visible to this session at the freeze boundary. */
export interface ExecutionWorldSnapshot {
  readonly id: string
  readonly capabilities: readonly ('fs' | 'process' | 'network' | 'browser' | 'computer')[]
  readonly filePolicy: {
    readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access'
    readonly workspaceRoot: string
  }
}

/** Coarse execution role used for budget and delegation policy. */
export type AgentKind = 'primary' | 'subagent' | 'fork-agent' | 'team-member' | 'background-session-agent'

/** Non-message configuration facts that must not drift inside one frozen attempt. */
export interface ResolvedRuntimeConfigSnapshot {
  readonly agentKind: AgentKind
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly maxParallelToolCalls: number
  readonly permissionPreset: string
}

/** Durable marker written before a potentially state-changing world operation. */
export interface WorldEffectStart {
  readonly receiptId: string
  readonly callId: CallId
  readonly toolName: string
  readonly requirements: readonly CapabilityRequirement[]
  readonly startedAt: number
}

/** Final audit receipt. Missing receipt after a start means crash-time `result-unknown`. */
export interface WorldEffectReceipt {
  readonly receiptId: string
  readonly startSeq: number
  readonly callId: CallId
  readonly toolName: string
  readonly status: 'succeeded' | 'failed'
  readonly endedAt: number
}

/** Extra Step Snapshot refs owned by the execution policy domain. */
export interface RuntimeSnapshotRefs {
  readonly permission: number
  readonly budget: number
  readonly world: number
  readonly config: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface StepSnapshotRefs {
    permission?: number
    budget?: number
    world?: number
    config?: number
  }

  interface SessionEventMap {
    /** Freezes the effective capability/resource permission state for one model-dispatch boundary. */
    'runtime/permission': CapabilityPermissionSnapshot
    /** Freezes configured global budget limits and the durable consumption observed at the dispatch boundary. */
    'runtime/budget': GlobalBudgetSnapshot
    /** Records one durable global-budget debit caused by a real operation or observed provider/runtime usage. */
    'runtime/budget-charge': GlobalBudgetCharge
    /** Freezes the execution world and file-policy substrate visible to the current agent attempt. */
    'runtime/world': ExecutionWorldSnapshot
    /** Freezes non-message runtime configuration that must not drift inside the current model attempt. */
    'runtime/config': ResolvedRuntimeConfigSnapshot
    /** Marks a potentially state-changing world operation before its external side effect can begin. */
    'world/effect-start': WorldEffectStart
    /** Settles a prior world/effect-start; a missing receipt after restart means result-unknown. */
    'world/effect-receipt': WorldEffectReceipt
  }
}
