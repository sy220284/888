/**
 * Context-overflow recovery strategy backed by the active compaction service.
 * @module @deepseek-ai/dsh-recovery-compaction
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction'
import type { RecoveryResolution } from '@deepseek-ai/dsh-recovery'

export const name = 'recovery-compaction'
export const inject = ['recovery', 'compaction']

/** Install the context-window overflow strategy ahead of model fallback. */
export function apply(ctx: Context): void {
  const dispose = ctx.recovery.register('context-compaction', async (request): Promise<RecoveryResolution | undefined> => {
    if (request.failure.code !== 'CONTEXT_WINDOW_EXCEEDED') return undefined
    request.signal.throwIfAborted()
    const compacted = await ctx.compaction.compactIfNeeded(request.agent, 'context-overflow', request.signal)
    request.signal.throwIfAborted()
    if (compacted === null) return undefined
    return {
      strategy: 'context-compaction',
      action: 'retry',
      reason: 'compacted model-visible history after provider-confirmed context overflow',
    }
  }, { priority: 100, ...ctx.agent === undefined ? {} : { agent: ctx.agent } })
  ctx.effect(() => () => { dispose() }, 'recovery-compaction: unregister strategy')
}
