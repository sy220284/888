import type { CapabilityAccess, CapabilityRequirement } from './types.ts'

export interface ResourceLease {
  release(): void
}

interface Waiter {
  readonly id: number
  readonly requirements: readonly CapabilityRequirement[]
  readonly signal?: AbortSignal
  readonly resolve: (lease: ResourceLease) => void
  readonly reject: (error: unknown) => void
  abortListener?: () => void
}

interface ActiveLease {
  readonly requirements: readonly CapabilityRequirement[]
}

function selectorContains(selector: string, value: string): boolean {
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

/** Read/read may overlap; every write/execute/control access is exclusive on overlapping resources. */
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

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('resource acquisition aborted')
}

/**
 * Fair resource-lock scheduler. Disjoint work may bypass an earlier waiter,
 * but a waiter may never bypass an earlier queued request that conflicts with
 * it. This preserves FIFO ordering per overlapping resource while retaining
 * concurrency across unrelated resources.
 */
export class ResourceScheduler {
  private readonly active = new Map<number, ActiveLease>()
  private readonly queue: Waiter[] = []
  private nextId = 1
  private disposed = false

  get activeCount(): number { return this.active.size }
  get queuedCount(): number { return this.queue.length }

  acquire(requirements: readonly CapabilityRequirement[], signal?: AbortSignal): Promise<ResourceLease> {
    if (this.disposed) return Promise.reject(new Error('resource scheduler is disposed'))
    if (signal?.aborted === true) return Promise.reject(abortError(signal))
    if (requirements.length === 0) return Promise.resolve({ release() {} })

    return new Promise<ResourceLease>((resolve, reject) => {
      const waiter: Waiter = {
        id: this.nextId++,
        requirements: Object.freeze([...requirements]),
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

  dispose(reason: unknown = new Error('resource scheduler disposed')): void {
    if (this.disposed) return
    this.disposed = true
    for (const waiter of this.queue.splice(0)) {
      if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.abortListener)
      }
      waiter.reject(reason)
    }
  }

  private canGrant(index: number): boolean {
    const waiter = this.queue[index]
    if (waiter === undefined) return false
    for (const lease of this.active.values()) {
      if (requirementsConflict(waiter.requirements, lease.requirements)) return false
    }
    for (let earlier = 0; earlier < index; earlier++) {
      const queued = this.queue[earlier]
      if (queued !== undefined && requirementsConflict(waiter.requirements, queued.requirements)) return false
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
        this.active.set(waiter.id, { requirements: waiter.requirements })
        let released = false
        waiter.resolve({
          release: () => {
            if (released) return
            released = true
            this.active.delete(waiter.id)
            this.drain()
          },
        })
        changed = true
        break
      }
    }
  }
}

export default ResourceScheduler
