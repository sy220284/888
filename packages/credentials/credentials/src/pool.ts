import type { CredentialProvider, ResolvedCredential } from './index.ts'
import type { CredentialRef } from './types.ts'

/** Minimal resolver contract consumed by the runtime-only pool. */
export type CredentialResolver = Pick<CredentialProvider, 'resolve'>

/** One credential selected for a single provider operation. */
export interface CredentialLease extends ResolvedCredential {
  readonly ref: CredentialRef
  /** Monotonic pool-local identity used to order out-of-order outcomes. */
  readonly leaseId: number
}

/** Runtime-only health policy for deterministic credential rotation. */
export interface CredentialPoolOptions {
  readonly maxFailures?: number
  readonly cooldownMs?: number
  readonly now?: () => number
}

interface CredentialHealth {
  failures: number
  cooldownUntil: number
}

const DEFAULT_MAX_FAILURES = 1
const DEFAULT_COOLDOWN_MS = 30_000

/**
 * Per-operation credential resolver with deterministic rotation, bounded
 * cooldown, and concurrency-aware leases. Secrets are never persisted or
 * cached: every acquisition resolves its selected reference through the
 * authoritative resolver.
 */
export class CredentialPool {
  private cursor = 0
  private nextLeaseId = 0
  private readonly health = new Map<CredentialRef, CredentialHealth>()
  private readonly lastOutcomeLeaseIds = new Map<CredentialRef, number>()
  private readonly inFlight = new Map<CredentialRef, number>()
  private readonly activeLeases = new Map<number, CredentialRef>()
  private readonly maxFailures: number
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(
    private readonly provider: CredentialResolver,
    private readonly refs: readonly CredentialRef[],
    options: CredentialPoolOptions = {},
  ) {
    if (refs.length === 0)
      throw new TypeError('credential pool requires at least one reference')
    if (new Set(refs).size !== refs.length)
      throw new TypeError('credential pool references must be unique')
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.now = options.now ?? Date.now
    if (!Number.isSafeInteger(this.maxFailures) || this.maxFailures < 1)
      throw new TypeError(
        'credential pool maxFailures must be a positive safe integer',
      )
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 0)
      throw new TypeError(
        'credential pool cooldownMs must be a non-negative safe integer',
      )
  }

  /**
   * Resolve the next healthy configured reference. Selection advances before
   * the provider await and prefers the least-busy reference, so concurrent
   * callers do not all observe the same cursor.
   */
  async acquire(): Promise<CredentialLease | undefined> {
    const attempted = new Set<CredentialRef>()
    while (attempted.size < this.refs.length) {
      const selected = this.select(attempted)
      if (selected === undefined) return undefined
      const { index, ref } = selected
      attempted.add(ref)
      this.cursor = (index + 1) % this.refs.length
      const resolved = await this.provider.resolve(ref)
      if (resolved === undefined) continue
      const leaseId = ++this.nextLeaseId
      this.activeLeases.set(leaseId, ref)
      this.inFlight.set(ref, (this.inFlight.get(ref) ?? 0) + 1)
      const lease = { ref, ...resolved } as CredentialLease
      Object.defineProperty(lease, 'leaseId', {
        value: leaseId,
        enumerable: false,
        writable: false,
        configurable: false,
      })
      return Object.freeze(lease)
    }
    return undefined
  }

  /** Mark a successful operation; stale out-of-order success cannot erase a newer failure. */
  reportSuccess(lease: CredentialLease | CredentialRef): void {
    const settled = this.settle(lease)
    if (settled === undefined) return
    const { ref, leaseId } = settled
    if (leaseId < (this.lastOutcomeLeaseIds.get(ref) ?? 0)) return
    this.lastOutcomeLeaseIds.set(ref, leaseId)
    this.health.delete(ref)
  }

  /** Mark a credential-scoped failure; repeated failures put the reference into cooldown. */
  reportFailure(lease: CredentialLease | CredentialRef): void {
    const settled = this.settle(lease)
    if (settled === undefined) return
    const { ref, leaseId } = settled
    if (leaseId < (this.lastOutcomeLeaseIds.get(ref) ?? 0)) return
    this.lastOutcomeLeaseIds.set(ref, leaseId)
    const current = this.health.get(ref) ?? {
      failures: 0,
      cooldownUntil: 0,
    }
    const failures = current.failures + 1
    this.health.set(
      ref,
      failures >= this.maxFailures
        ? {
          failures: 0,
          cooldownUntil: this.now() + this.cooldownMs,
        }
        : { failures, cooldownUntil: 0 },
    )
  }

  /** Release an operation that says nothing about credential health. */
  release(lease: CredentialLease | CredentialRef): void {
    this.settle(lease)
  }

  /** Safe health snapshot containing references, timers, and counts only. */
  status(): readonly {
    ref: CredentialRef
    coolingDown: boolean
    cooldownUntil: number
    inFlight: number
  }[] {
    const now = this.now()
    return this.refs.map((ref) => {
      const state = this.health.get(ref)
      return {
        ref,
        coolingDown: (state?.cooldownUntil ?? 0) > now,
        cooldownUntil: state?.cooldownUntil ?? 0,
        inFlight: this.inFlight.get(ref) ?? 0,
      }
    })
  }

  private select(attempted: ReadonlySet<CredentialRef>): {
    index: number
    ref: CredentialRef
  } | undefined {
    const now = this.now()
    let best:
      | { index: number; ref: CredentialRef; inFlight: number; offset: number }
      | undefined
    for (let offset = 0; offset < this.refs.length; offset++) {
      const index = (this.cursor + offset) % this.refs.length
      const ref = this.refs[index]
      if (ref === undefined) continue
      if (attempted.has(ref)) continue
      const state = this.health.get(ref)
      if (state !== undefined && state.cooldownUntil > now) continue
      const inFlight = this.inFlight.get(ref) ?? 0
      if (
        best === undefined ||
        inFlight < best.inFlight ||
        (inFlight === best.inFlight && offset < best.offset)
      ) {
        best = { index, ref, inFlight, offset }
      }
    }
    return best
  }

  private settle(lease: CredentialLease | CredentialRef): {
    ref: CredentialRef
    leaseId: number
  } | undefined {
    if (typeof lease === 'string') {
      this.requireMember(lease)
      const active = [...this.activeLeases.entries()].find(([, ref]) => ref === lease)
      if (active === undefined) return { ref: lease, leaseId: ++this.nextLeaseId }
      const [leaseId] = active
      this.activeLeases.delete(leaseId)
      this.decrementInFlight(lease)
      return { ref: lease, leaseId }
    }
    this.requireMember(lease.ref)
    const activeRef = this.activeLeases.get(lease.leaseId)
    if (activeRef === undefined) return undefined
    if (activeRef !== lease.ref)
      throw new Error('credential lease identity does not match its reference')
    this.activeLeases.delete(lease.leaseId)
    this.decrementInFlight(lease.ref)
    return { ref: lease.ref, leaseId: lease.leaseId }
  }

  private decrementInFlight(ref: CredentialRef): void {
    const remaining = (this.inFlight.get(ref) ?? 1) - 1
    if (remaining <= 0) this.inFlight.delete(ref)
    else this.inFlight.set(ref, remaining)
  }

  private requireMember(ref: CredentialRef): void {
    if (!this.refs.includes(ref))
      throw new Error(
        `credential reference ${JSON.stringify(ref)} does not belong to this pool`,
      )
  }
}
