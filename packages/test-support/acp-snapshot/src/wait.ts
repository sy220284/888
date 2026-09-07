import { vi } from 'vitest'

/** Wait for one snapshot condition without losing its diagnostic to the polling deadline. */
export async function waitForSnapshotCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  try {
    await vi.waitFor(async () => {
      if (!await condition()) throw new Error(timeoutMessage)
    }, { interval: 10, timeout: timeoutMs })
  } catch (error) {
    // The first asynchronous poll may still be pending when the deadline fires.
    // Preserve the scenario diagnostic and the original timer failure together.
    if (error instanceof Error && error.message === 'Timed out in waitFor!') {
      throw new Error(timeoutMessage, { cause: error })
    }
    throw error
  }
}
