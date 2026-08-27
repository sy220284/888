/** Package-owned durable-event invariants for model routing. @module @deepseek-ai/dsh-model-router/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-model-router'
export const name = 'model-router-invariant'
export const inject = ['invariants']

function validRoute(route: { provider: string; model: string }): boolean {
  return route.provider.trim().length > 0 && route.model.trim().length > 0
}

function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'model/route-selected') return
  const data = event.data
  if (!Number.isSafeInteger(data.turn) || data.turn < 1
    || !Number.isSafeInteger(data.step) || data.step < 1
    || !Number.isSafeInteger(data.attempt) || data.attempt < 1) {
    fail('model/route-selected turn, step, and attempt must be positive safe integers')
  }
  if (!validRoute(data.from) || !validRoute(data.to)) fail('model/route-selected routes must be non-empty')
  if (data.from.provider === data.to.provider && data.from.model === data.to.model) {
    fail('model/route-selected must change the provider/model route')
  }
  if (data.failureCode.trim().length === 0) fail('model/route-selected failureCode must be non-empty')
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) for (const event of session.events) validateEvent(event, fail)
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    validateEvent((args as [Session, SessionEvent])[1], fail)
  }, { global: true })
}, { inject: ['sessions'] })

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
