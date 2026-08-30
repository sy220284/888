/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-subprocess-native`.
 * @module @deepseek-ai/dsh-subprocess-native/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-subprocess-native'

/** Cordis companion plugin name. */
export const name = 'subprocess-native-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this provider delegates process execution to the
 * native execution service and owns no independent durable state.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
