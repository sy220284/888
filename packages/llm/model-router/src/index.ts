/**
 * Durable model-route fallback service. Initial requests keep the agent's
 * configured route; recovery may append a step-scoped fallback decision, and
 * the agent/request waterfall replays that exact route on the next attempt.
 * @module @deepseek-ai/dsh-model-router
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RecoveryRequest, RecoveryResolution } from '@deepseek-ai/dsh-recovery'

export const name = 'model-router'

/** Provider and model pair used for one request route. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** Ordered fallback routes for one source route. */
export interface FallbackRuleConfig {
  readonly from: ModelRoute
  readonly to: readonly ModelRoute[]
}

/** Model-router fallback configuration. */
export interface Config {
  readonly fallbacks?: readonly FallbackRuleConfig[]
  /** Stable failure codes that may leave the current route after local retry exhausts. */
  readonly fallbackCodes?: readonly string[]
}

const routeSchema = z.object({ provider: z.string().required(), model: z.string().required() })
export const Config: z<Config> = z.object({
  fallbacks: z.array(z.object({ from: routeSchema, to: z.array(routeSchema) })).default([]),
  fallbackCodes: z.array(z.string()).default([
    'AUTH',
    'QUOTA',
    'RATE_LIMIT',
    'SERVER',
    'SERVICE_UNAVAILABLE',
    'TIMEOUT',
    'TRANSPORT',
    'EMPTY_RESPONSE',
    'MISSING_CREDENTIAL',
    'INVALID_CREDENTIAL',
    'CONTEXT_WINDOW_EXCEEDED',
  ]),
}) as unknown as z<Config>

interface Rule {
  readonly from: ModelRoute
  readonly to: readonly ModelRoute[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    models: ModelRouter
  }
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Step-scoped fallback route selected after one failed request attempt. */
    'model/route-selected': {
      turn: number
      step: number
      attempt: number
      from: ModelRoute
      to: ModelRoute
      reason: 'fallback'
      failureCode: string
    }
  }
}

function routeKey(route: ModelRoute): string {
  return JSON.stringify([route.provider, route.model])
}

function normalizeRoute(route: ModelRoute, path: string): ModelRoute {
  const provider = route.provider.trim()
  const model = route.model.trim()
  if (provider.length === 0 || model.length === 0) {
    throw new Error(`${path} requires non-empty provider and model`)
  }
  return Object.freeze({ provider, model })
}

function latestRouteEvent(agent: Agent, turn: number, step: number): SessionEvent<'model/route-selected'> | undefined {
  return agent.session.events.findLast((event): event is SessionEvent<'model/route-selected'> =>
    event.type === 'model/route-selected'
    && event.data.turn === turn
    && event.data.step === step,
  )
}

/** Provider/model fallback router (`ctx.models`). */
export class ModelRouter extends Service {
  static inject = ['llm', 'agents', 'recovery']
  static Config = Config

  private readonly rules = new Map<string, Rule>()
  private readonly fallbackCodes: ReadonlySet<string>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'models')
    this.fallbackCodes = new Set(config.fallbackCodes ?? [
      'AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'SERVICE_UNAVAILABLE', 'TIMEOUT', 'TRANSPORT',
      'EMPTY_RESPONSE', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED',
    ])
    for (const [index, rule] of (config.fallbacks ?? []).entries()) {
      this.addRule(rule, `model-router.fallbacks[${index}]`)
    }

    // Any route selected by a durable recovery event owns the next request
    // attempt in this step. request/header then records the exact wire route.
    ctx.on('agent/request', async ({ agent, turn, step }, next): Promise<LlmCallConfig> => {
      const config = await next()
      const selected = latestRouteEvent(agent, turn, step)
      if (selected === undefined) return config
      return Object.freeze({ ...config, ...selected.data.to })
    }, { prepend: true })

    const disposeRecovery = ctx.recovery.register('model-fallback', request => this.recover(request), { priority: -100 })
    ctx.effect(() => () => { disposeRecovery() }, 'model-router: unregister recovery strategy')
  }

  /**
   * Add or replace one fallback chain.
   * @param from Source model route.
   * @param to Ordered fallback routes.
   */
  setFallbacks(from: ModelRoute, to: readonly ModelRoute[]): void {
    const rule = this.resolveRule({ from, to }, 'model-router.setFallbacks')
    this.rules.set(routeKey(rule.from), rule)
  }

  /**
   * Return a detached configured chain for diagnostics.
   * @param from Source model route.
   * @returns Detached ordered fallback chain.
   */
  fallbacks(from: ModelRoute): readonly ModelRoute[] {
    const rule = this.rules.get(routeKey(normalizeRoute(from, 'model-router.fallbacks')))
    return rule?.to.map(route => ({ ...route })) ?? []
  }

  private addRule(config: FallbackRuleConfig, path: string): void {
    const rule = this.resolveRule(config, path)
    const key = routeKey(rule.from)
    if (this.rules.has(key)) throw new Error(`${path}: duplicate fallback source ${rule.from.provider}/${rule.from.model}`)
    this.rules.set(key, rule)
  }

  private resolveRule(config: FallbackRuleConfig, path: string): Rule {
    const from = normalizeRoute(config.from, `${path}.from`)
    if (config.to.length === 0) throw new Error(`${path}.to must not be empty`)
    const seen = new Set<string>([routeKey(from)])
    const to = config.to.map((route, index) => {
      const normalized = normalizeRoute(route, `${path}.to[${index}]`)
      const key = routeKey(normalized)
      if (seen.has(key)) throw new Error(`${path}.to contains a duplicate or source route`)
      seen.add(key)
      return normalized
    })
    return Object.freeze({ from, to: Object.freeze(to) })
  }

  private recover(request: RecoveryRequest): Promise<RecoveryResolution | undefined> {
    return Promise.resolve(this.resolveRecovery(request))
  }

  private resolveRecovery(request: RecoveryRequest): RecoveryResolution | undefined {
    if (!this.fallbackCodes.has(request.failure.code)) return undefined
    const routeEvents = request.agent.session.events.filter((event): event is SessionEvent<'model/route-selected'> =>
      event.type === 'model/route-selected'
      && event.data.turn === request.turn
      && event.data.step === request.step,
    )
    const source = routeEvents[0]?.data.from ?? { provider: request.provider, model: request.model }
    const current = routeEvents.at(-1)?.data.to ?? { provider: request.provider, model: request.model }
    const rule = this.rules.get(routeKey(source))
    if (rule === undefined) return undefined

    const used = new Set<string>([source, { provider: request.provider, model: request.model }, current].map(routeKey))
    for (const event of routeEvents) {
      used.add(routeKey(event.data.from))
      used.add(routeKey(event.data.to))
    }
    const availableProviders = new Set(this.ctx.llm.listProviders().map(provider => provider.id))
    const target = rule.to.find(route => availableProviders.has(route.provider) && !used.has(routeKey(route)))
    if (target === undefined) return undefined

    request.signal.throwIfAborted()
    request.agent.session.append('model/route-selected', {
      turn: request.turn,
      step: request.step,
      attempt: request.attempt,
      from: Object.freeze({ provider: request.provider, model: request.model }),
      to: target,
      reason: 'fallback',
      failureCode: request.failure.code,
    })
    return {
      strategy: 'model-fallback',
      action: 'retry',
      reason: `fallback after ${request.failure.code}`,
      route: target,
    }
  }
}

export default ModelRouter
