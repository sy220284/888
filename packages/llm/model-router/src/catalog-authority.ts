import type { ModelDescriptor, ModelRoute } from './index.ts'

/** Active route metadata lookup and compatibility filter used by model fallback. */
export function createCatalogAuthority(
  activeModels: () => readonly ModelDescriptor[],
): {
  descriptorForRoute(route: ModelRoute): ModelDescriptor | undefined
  allows(source: ModelDescriptor | undefined, route: ModelRoute, failureCode: string): boolean
} {
  const descriptorForRoute = (route: ModelRoute): ModelDescriptor | undefined =>
    activeModels().find(model => model.provider === route.provider && model.model === route.model)

  return {
    descriptorForRoute,
    allows(source, route, failureCode) {
      const models = activeModels()
      if (models.length === 0) return true
      const target = descriptorForRoute(route)
      if (target === undefined) return false
      if (
        source?.capabilities !== undefined
        && source.capabilities.some(capability => !target.capabilities?.includes(capability))
      ) return false
      if (
        failureCode === 'CONTEXT_WINDOW_EXCEEDED'
        && source?.contextWindow !== undefined
        && target.contextWindow !== undefined
        && target.contextWindow <= source.contextWindow
      ) return false
      return true
    },
  }
}
