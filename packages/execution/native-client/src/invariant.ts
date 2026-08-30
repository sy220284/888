/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-native-client`.
 * @module @deepseek-ai/dsh-native-client/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-native-client'

/** Cordis companion plugin name. */
export const name = 'native-client-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the client is a transport adapter and does not own
 * independent durable state beyond the native execution service.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
