import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForSnapshotCondition } from '../src/wait.ts'

afterEach(() => { vi.useRealTimers() })

describe('snapshot persistence polling', () => {
  it('retains the scenario diagnostic when the first poll outlives the deadline', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<boolean>()
    const result = waitForSnapshotCondition(() => pending.promise, 20, 'missing post-turn event')
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(20)
    expect(await result).toMatchObject({
      message: 'missing post-turn event',
      cause: { message: 'Timed out in waitFor!' },
    })
    pending.resolve(true)
  })

  it('retries a missing record and accepts it before the deadline', async () => {
    vi.useFakeTimers()
    let ready = false
    const result = waitForSnapshotCondition(() => ready, 100, 'missing event')
    await vi.advanceTimersByTimeAsync(10)
    ready = true
    await vi.advanceTimersByTimeAsync(10)
    await expect(result).resolves.toBeUndefined()
  })

  it('preserves validation failures instead of relabeling them as a missing record', async () => {
    vi.useFakeTimers()
    const failure = new Error('malformed session record')
    const result = waitForSnapshotCondition(() => { throw failure }, 20, 'missing event')
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(20)
    expect(await result).toBe(failure)
  })
})
