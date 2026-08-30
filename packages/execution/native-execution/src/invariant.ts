/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-native-execution`.
 * @module @deepseek-ai/dsh-native-execution/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-native-execution'

/** Cordis companion plugin name. */
export const name = 'native-execution-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No additional runtime invariant: this package defines the native execution
 * service contract and does not own independent runtime state.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
