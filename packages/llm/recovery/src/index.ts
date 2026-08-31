/**
 * Model-request recovery seam. Provider-local retry remains owned by dsh-llm-retry;
 * this service runs only after downstream recovery declines and lets outer domains
 * add compaction, rerouting, credential rotation, or other durable recovery policies.
 * @module @deepseek-ai/dsh-recovery
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig, LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'recovery'

/** Failed model request offered to registered recovery handlers. */
export interface RecoveryRequest {
  readonly agent: Agent
  readonly turn: number
  readonly step: number
  readonly attempt: number
  readonly provider: string
  readonly model: string
  readonly failure: LlmFailure
  readonly retryPolicy: ResolvedRetryPolicy | undefined
  readonly signal: AbortSignal
}

/** Durable retry decision returned by one recovery handler. */
export interface RecoveryResolution {
  readonly strategy: string
  readonly action: 'retry'
  readonly reason: string
  readonly route?: Pick<LlmCallConfig, 'provider' | 'model'>
}

/** Recovery strategy invoked after downstream retry handling declines. */
export type RecoveryHandler = (request: RecoveryRequest) => Promise<RecoveryResolution | undefined>
/** Ordering options for a recovery handler. */
export interface RecoveryHandlerOptions { readonly priority?: number }
interface RegisteredHandler { readonly id: string; readonly priority: number; readonly order: number; readonly run: RecoveryHandler }

declare module '@deepseek-ai/cordis' { interface Context { recovery: RecoveryService } }
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'recovery/decision': {
      turn: number
      step: number
      attempt: number
      provider: string
      model: string
      failure: LlmFailure
      strategy: string
      action: 'retry'
      reason: string
      route?: Pick<LlmCallConfig, 'provider' | 'model'>
    }
  }
}

/** Empty recovery service configuration. */
export type Config = Readonly<Record<string, never>>
export const Config = z.object({}) as unknown as z<Config>

/** Ordered model-request recovery strategy registry (`ctx.recovery`). */
export class RecoveryService extends Service {
  static inject = ['agents']
  static Config = Config
  private readonly handlers: RegisteredHandler[] = []
  private nextOrder = 0

  constructor(ctx: Context, _config: Config = {}) {
    super(ctx, 'recovery')
    ctx.on('agent/request-error', async (payload, next): Promise<RequestErrorAction> => {
      const downstream = await next()
      if (downstream !== undefined) return downstream
      payload.signal.throwIfAborted()
      const snapshot = payload.agent.session.events.findLast((event): event is SessionEvent<'step/snapshot'> =>
        event.type === 'step/snapshot' && event.data.turn === payload.turn && event.data.step === payload.step,
      )
      if (snapshot === undefined) throw new Error('recovery: failed request has no durable step/snapshot')
      const requestContext = payload.agent.session.requestContext()
      if (requestContext === undefined) throw new Error('recovery: failed request has no durable request/context')
      const request: RecoveryRequest = {
        agent: payload.agent,
        turn: payload.turn,
        step: payload.step,
        attempt: snapshot.data.attempt,
        provider: payload.provider,
        model: requestContext.model,
        failure: payload.failure,
        retryPolicy: payload.retryPolicy,
        signal: payload.signal,
      }
      const resolution = await this.resolve(request)
      payload.signal.throwIfAborted()
      if (resolution === undefined) return
      payload.agent.session.append('recovery/decision', {
        turn: payload.turn,
        step: payload.step,
        attempt: snapshot.data.attempt,
        provider: payload.provider,
        model: requestContext.model,
        failure: payload.failure,
        strategy: resolution.strategy,
        action: resolution.action,
        reason: resolution.reason,
        ...resolution.route === undefined ? {} : { route: resolution.route },
      })
      return { kind: 'retry' }
    }, { prepend: true })
  }

  /**
   * Register one recovery strategy.
   * @param id Stable strategy identifier.
   * @param run Recovery handler.
   * @param options Ordering options.
   * @returns Function that unregisters the strategy.
   */
  register(id: string, run: RecoveryHandler, options: RecoveryHandlerOptions = {}): () => void {
    if (id.trim().length === 0) throw new Error('recovery strategy id must be non-empty')
    if (this.handlers.some(handler => handler.id === id)) throw new Error(`recovery strategy "${id}" is already registered`)
    const priority = options.priority ?? 0
    if (!Number.isFinite(priority)) throw new Error('recovery strategy priority must be finite')
    const handler: RegisteredHandler = { id, priority, order: this.nextOrder++, run }
    this.handlers.push(handler)
    this.handlers.sort((left, right) => right.priority - left.priority || left.order - right.order)
    const dispose = this.ctx.effect(() => () => {
      const index = this.handlers.indexOf(handler)
      if (index >= 0) this.handlers.splice(index, 1)
    }, `recovery.register(${id})`)
    return () => void dispose()
  }

  /**
   * Resolve a failed request through registered strategies.
   * @param request Failed request context.
   * @returns First accepted recovery resolution, if any.
   */
  async resolve(request: RecoveryRequest): Promise<RecoveryResolution | undefined> {
    for (const handler of [...this.handlers]) {
      request.signal.throwIfAborted()
      const resolution = await handler.run(request)
      request.signal.throwIfAborted()
      if (resolution === undefined) continue
      if (resolution.strategy !== handler.id) throw new Error(`recovery strategy "${handler.id}" returned mismatched strategy "${resolution.strategy}"`)
      if (resolution.reason.trim().length === 0) throw new Error(`recovery strategy "${handler.id}" returned an empty reason`)
      return Object.freeze({ ...resolution, ...resolution.route === undefined ? {} : { route: Object.freeze({ ...resolution.route }) } })
    }
    return undefined
  }
}

export default RecoveryService
