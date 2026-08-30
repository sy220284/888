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
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package defines the native execution seam while concrete
 * providers own their runtime state guarantees.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
