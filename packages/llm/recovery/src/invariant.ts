/** Package-owned durable-event invariants for request recovery. @module @deepseek-ai/dsh-recovery/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-recovery'
export const name = 'recovery-invariant'
export const inject = ['invariants']

function positive(value: number): boolean { return Number.isSafeInteger(value) && value >= 1 }
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'recovery/decision') return
  const data = event.data
  if (!positive(data.turn) || !positive(data.step) || !positive(data.attempt)) fail('recovery/decision turn, step, and attempt must be positive safe integers')
  if (data.provider.trim().length === 0 || data.model.trim().length === 0) fail('recovery/decision provider and model must be non-empty')
  if (data.strategy.trim().length === 0 || data.reason.trim().length === 0) fail('recovery/decision strategy and reason must be non-empty')
  const action: unknown = data.action
  if (action !== 'retry') fail(`recovery/decision carries unsupported action ${JSON.stringify(action)}`)
  if (data.route !== undefined && (data.route.provider.trim().length === 0 || data.route.model.trim().length === 0)) fail('recovery/decision route must carry non-empty provider and model')
}
function validateHistory(ctx: Context, fail: InvariantFailure): void {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  validateHistory(ctx, fail)
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
