import { describe, expect, it } from 'vitest'
import { ResourceScheduler, requirementsConflict } from '@deepseek-ai/dsh-runtime-policy'
import type { CapabilityRequirement } from '@deepseek-ai/dsh-runtime-policy'

const read = (value: string): CapabilityRequirement => ({ capability: 'file.read', resource: { kind: 'file', value }, access: 'read' })
const write = (value: string): CapabilityRequirement => ({ capability: 'file.write', resource: { kind: 'file', value }, access: 'write', effect: true })
const unknown: CapabilityRequirement = {
  capability: 'tool.execute',
  resource: { kind: 'tool', value: '*' },
  access: 'control',
  risk: 2,
  effect: true,
}

describe('ResourceScheduler', () => {
  it('allows read/read overlap and blocks a write on the same resource', async () => {
    const scheduler = new ResourceScheduler()
    const first = await scheduler.acquire([read('/workspace/a')])
    const second = await scheduler.acquire([read('/workspace/a')])
    let writeGranted = false
    const waiting = scheduler.acquire([write('/workspace/a')]).then((lease) => { writeGranted = true; return lease })
    await Promise.resolve()
    expect(writeGranted).toBe(false)
    first.release()
    await Promise.resolve()
    expect(writeGranted).toBe(false)
    second.release()
    const third = await waiting
    expect(writeGranted).toBe(true)
    third.release()
  })

  it('lets disjoint resources bypass an earlier blocked waiter without violating FIFO on conflicts', async () => {
    const scheduler = new ResourceScheduler()
    const active = await scheduler.acquire([write('/workspace/a')])
    let sameGranted = false
    const same = scheduler.acquire([write('/workspace/a')]).then((lease) => { sameGranted = true; return lease })
    const disjoint = await scheduler.acquire([write('/workspace/b')])
    expect(sameGranted).toBe(false)
    disjoint.release()
    active.release()
    const queued = await same
    expect(sameGranted).toBe(true)
    queued.release()
  })

  it('treats selector roots as overlapping concrete resources', () => {
    expect(requirementsConflict([read('/workspace/**')], [write('/workspace/src/a.ts')])).toBe(true)
    expect(requirementsConflict([read('/workspace/**')], [read('/workspace/src/a.ts')])).toBe(false)
    expect(requirementsConflict([write('/workspace/**')], [write('/other/a.ts')])).toBe(false)
  })

  it('treats an unclassified tool as a global external-resource barrier', () => {
    expect(requirementsConflict([unknown], [read('/workspace/a')])).toBe(true)
    expect(requirementsConflict([unknown], [{ capability: 'network.fetch', resource: { kind: 'network', value: 'https://example.com' }, access: 'read' }])).toBe(true)
  })

  it('removes an aborted waiter from the queue', async () => {
    const scheduler = new ResourceScheduler()
    const active = await scheduler.acquire([write('/workspace/a')])
    const controller = new AbortController()
    const waiting = scheduler.acquire([write('/workspace/a')], controller.signal)
    expect(scheduler.queuedCount).toBe(1)
    controller.abort(new Error('cancelled'))
    await expect(waiting).rejects.toThrow('cancelled')
    expect(scheduler.queuedCount).toBe(0)
    active.release()
  })
})
