import type { CapabilityAccess, CapabilityRequirement } from './types.ts'
import { selectorContains } from './selector.ts'

/** Idempotent release handle for one granted resource set. */
export interface ResourceLease {
  release(): void
}

interface Waiter {
  readonly id: number
  readonly requirements: readonly CapabilityRequirement[]
  readonly ancestors: ReadonlySet<number>
  readonly signal?: AbortSignal
  readonly resolve: (lease: ResourceLease) => void
  readonly reject: (error: Error) => void
  abortListener?: () => void
}

interface ActiveLease {
  readonly requirements: readonly CapabilityRequirement[]
  readonly ancestors: ReadonlySet<number>
}

/**
 * Return whether two exact or wildcard resource values overlap.
 * @param left - first resource value.
 * @param right - second resource value.
 * @returns whether either selector contains the other value.
 */
export function resourceValuesOverlap(left: string, right: string): boolean {
  return selectorContains(left, right) || selectorContains(right, left)
}

function accessOf(requirement: CapabilityRequirement): CapabilityAccess {
  return requirement.access ?? 'control'
}

/** Conservative fallback emitted for an unclassified tool: it may touch any external resource. */
function isGlobalUnknown(requirement: CapabilityRequirement): boolean {
  return requirement.capability === 'tool.execute'
    && requirement.resource.kind === 'tool'
    && requirement.resource.value === '*'
}

/**
 * Read/read may overlap; every write, execute, or control access is exclusive on overlapping resources.
 * @param left - first capability requirement set.
 * @param right - second capability requirement set.
 * @returns whether the sets must execute exclusively.
 */
export function requirementsConflict(
  left: readonly CapabilityRequirement[],
  right: readonly CapabilityRequirement[],
): boolean {
  for (const a of left) {
    for (const b of right) {
      if (isGlobalUnknown(a) || isGlobalUnknown(b)) return true
      if (a.resource.kind !== b.resource.kind) continue
      if (!resourceValuesOverlap(a.resource.value, b.resource.value)) continue
      if (accessOf(a) === 'read' && accessOf(b) === 'read') continue
      return true
    }
  }
  return false
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason === undefined ? new Error('resource acquisition aborted') : asError(signal.reason)
}

/**
 * Fair resource-lock scheduler. Disjoint work may bypass an earlier waiter,
 * but a waiter may never bypass an earlier queued request that conflicts with
 * it. This preserves FIFO ordering per overlapping resource while retaining
 * concurrency across unrelated resources.
 */
export class ResourceScheduler {
  private readonly active = new Map<number, ActiveLease>()
  private readonly leaseIds = new WeakMap<ResourceLease, number>()
  private readonly queue: Waiter[] = []
  private nextId = 1
  private disposed = false

  /** Current grant count. @returns number of currently granted leases. */
  get activeCount(): number { return this.active.size }
  /** Current queue depth. @returns number of requests waiting for compatible resources. */
  get queuedCount(): number { return this.queue.length }

  /**
   * Queue a resource set and resolve when FIFO conflict rules permit it.
   * @param requirements - resources required by one operation.
   * @param signal - optional cancellation signal while queued.
   * @param parent - live enclosing lease; descendants still conflict with siblings and unrelated work.
   * @returns a lease that releases the granted resources.
   */
  acquire(requirements: readonly CapabilityRequirement[], signal?: AbortSignal, parent?: ResourceLease): Promise<ResourceLease> {
    if (this.disposed) return Promise.reject(new Error('resource scheduler is disposed'))
    if (signal?.aborted === true) return Promise.reject(abortError(signal))
    const parentId = parent === undefined ? undefined : this.leaseIds.get(parent)
    const enclosing = parentId === undefined ? undefined : this.active.get(parentId)
    if (parent !== undefined && enclosing === undefined) {
      return Promise.reject(new Error('parent resource lease is not active in this scheduler'))
    }
    const ancestors = new Set(enclosing?.ancestors)
    if (parentId !== undefined) ancestors.add(parentId)

    return new Promise<ResourceLease>((resolve, reject) => {
      const waiter: Waiter = {
        id: this.nextId++,
        requirements: Object.freeze([...requirements]),
        ancestors,
        ...(signal === undefined ? {} : { signal }),
        resolve,
        reject,
      }
      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.queue.indexOf(waiter)
          if (index < 0) return
          this.queue.splice(index, 1)
          reject(abortError(signal))
          this.drain()
        }
        waiter.abortListener = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.queue.push(waiter)
      this.drain()
    })
  }

  /**
   * Reject queued acquisitions and prevent future grants.
   * @param reason - error propagated to queued callers.
   */
  dispose(reason: unknown = new Error('resource scheduler disposed')): void {
    if (this.disposed) return
    this.disposed = true
    for (const waiter of this.queue.splice(0)) {
      if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.abortListener)
      }
      waiter.reject(asError(reason))
    }
  }

  private canGrant(index: number): boolean {
    const waiter = this.queue[index]
    if (waiter === undefined) return false
    for (const [id, lease] of this.active) {
      if (waiter.ancestors.has(id)) continue
      if (requirementsConflict(waiter.requirements, lease.requirements)) return false
    }
    for (let earlier = 0; earlier < index; earlier++) {
      const queued = this.queue[earlier]
      if (queued === undefined || !requirementsConflict(waiter.requirements, queued.requirements)) continue
      // An unrelated waiter blocked by our enclosing lease cannot run until
      // this execution tree drains. Let descendants finish; preserve sibling FIFO.
      const blockedByAncestor = [...waiter.ancestors].some((id) => {
        const ancestor = this.active.get(id)
        return ancestor !== undefined && !queued.ancestors.has(id)
          && requirementsConflict(queued.requirements, ancestor.requirements)
      })
      if (!blockedByAncestor) return false
    }
    return true
  }

  private drain(): void {
    if (this.disposed) return
    let changed = true
    while (changed) {
      changed = false
      for (let index = 0; index < this.queue.length; index++) {
        if (!this.canGrant(index)) continue
        const waiter = this.queue[index]
        if (waiter === undefined) continue
        this.queue.splice(index, 1)
        if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
          waiter.signal.removeEventListener('abort', waiter.abortListener)
        }
        this.active.set(waiter.id, { requirements: waiter.requirements, ancestors: waiter.ancestors })
        let released = false
        const lease: ResourceLease = {
          release: () => {
            if (released) return
            released = true
            this.active.delete(waiter.id)
            this.drain()
          },
        }
        this.leaseIds.set(lease, waiter.id)
        waiter.resolve(lease)
        changed = true
        break
      }
    }
  }
}

export default ResourceScheduler
