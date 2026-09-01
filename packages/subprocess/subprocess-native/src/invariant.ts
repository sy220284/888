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
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: subprocess lifecycle guarantees remain owned by the subprocess
 * and native execution seams this provider composes.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
