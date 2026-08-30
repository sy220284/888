/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-recovery-compaction`.
 * @module @deepseek-ai/dsh-recovery-compaction/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-recovery-compaction'

/** Cordis companion plugin name. */
export const name = 'recovery-compaction-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package delegates compaction and recovery state guarantees
 * to the owning compaction and recovery seams.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
