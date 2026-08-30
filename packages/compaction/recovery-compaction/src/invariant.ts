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
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/**
 * No additional runtime invariant: this adapter delegates state ownership to
 * the compaction and recovery services and keeps no independent cache/event state.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
