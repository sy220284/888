/**
 * Adapter-neutral hook vocabulary and log-only events shared by ecosystem
 * bridges. Payload construction, matching policy, environment handling, and
 * extension-point-specific decision mapping remain owned by each adapter.
 * @module @deepseek-ai/dsh-hook-protocol/types
 */

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A hook command was invoked at a hook point — a log-only record (like
     * `compaction/*`; NOT a {@link SurfaceEventType}, carries no `surfaceOp`).
     * `dialect` is the adapter id that ran it, `point` the hook point,
     * `matcher` the matcher-group pattern that selected it (absent for
     * match-all), and `handlerId` a stable id for correlating the paired
     * `hook/result`. `turn` is the open turn the invocation lives inside.
     *
     * The persisted field remains named `dialect` for wire compatibility. New
     * adapters MUST NOT require a core enum entry: any stable adapter id is
     * valid.
     */
    'hook/invoked': {
      turn: number
      point: string
      dialect: HookAdapterId
      matcher?: string
      handlerId: string
    }
    /**
     * Log-only outcome paired to `hook/invoked` by `handlerId`. Decision is the
     * parsed permission result, `stop` for `continue:false`, or `pass`; exit code
     * may be absent, stderr is bounded, and duration is wall-clock runtime.
     */
    'hook/result': {
      turn: number
      point: string
      handlerId: string
      decision: string
      exitCode?: number
      stderrSummary?: string
      durationMs: number
    }
  }
}

/** Stable identifier stamped by the ecosystem adapter that ran a hook. */
export type HookAdapterId = string

/**
 * @deprecated Persisted events still use the field name `dialect`; use
 * {@link HookAdapterId} for new code. This alias intentionally stays open so
 * adding an ecosystem adapter never requires changing the canonical protocol.
 */
export type HookDialect = HookAdapterId

/**
 * One canonical command-hook request after an adapter has parsed its native
 * configuration. Provider-only hook kinds are handled by that adapter and do
 * not expand this shared shape.
 */
export interface CommandHook {
  /** The shell command line to run. */
  command: string
  /** Per-hook timeout in SECONDS (the wire unit); the runner converts to ms. */
  timeoutSec?: number
}

/**
 * One canonical matcher group: a pattern (absent / `''` / `'*'` = match-all)
 * plus the normalized command hooks that run when it matches.
 */
export interface MatcherGroup {
  matcher?: string
  hooks: CommandHook[]
}

/**
 * Canonical matcher behavior. Adapters select a strategy after parsing their
 * native configuration; the core does not need to know which provider chose it.
 */
export type MatcherStrategy =
  | 'literal-alternation-or-regex'
  | 'regex'

/**
 * Legacy provider selectors accepted for source compatibility while adapters
 * migrate to {@link MatcherStrategy}. Do not add new providers here.
 */
export type LegacyMatcherMode = 'claude-code' | 'codex'

/**
 * @deprecated Adapter code should pass a {@link MatcherStrategy}. Legacy values
 * remain accepted so existing bridges can migrate without a wire or API break.
 */
export type MatcherMode = MatcherStrategy | LegacyMatcherMode

/**
 * The adapter-neutral OUTCOME a hook produced, parsed from its exit code +
 * stdout JSON + stderr by {@link parseHookOutput}. An adapter maps this onto an
 * extension-point-specific typed Decision (PreToolDecision, PreStepDecision, …).
 * Every field is OPTIONAL because a hook may exercise any subset; the adapter
 * decides which fields are meaningful for its hook point and which it ignores.
 */
export interface HookOutput {
  /** The raw process exit code (`undefined` if the hook could not be run). */
  exitCode: number | undefined
  /** Trimmed stderr — the block-reason source on a blocking (exit 2) hook. */
  stderr: string
  /**
   * Trimmed stdout, verbatim. A clean hook may emit plain stdout, so adapters
   * need the raw text in addition to parsed structured fields.
   */
  stdout: string
  /** `false` means the hook asked to halt; `true`/absent means proceed. */
  continue?: boolean
  /** Human-readable reason shown when {@link continue} is `false`. */
  stopReason?: string
  /**
   * Canonical permission outcome folded from supported provider channels.
   * Absent means no explicit decision and exit-code/default policy governs.
   */
  decision?: 'approve' | 'allow' | 'block' | 'deny' | 'ask'
  /** The reason/explanation accompanying {@link decision}. */
  reason?: string
  /**
   * Event discriminator claimed by provider-specific structured output. On a
   * mismatch, the codec preserves the value but discards event-scoped fields.
   */
  hookEventName?: string
  /** Extra context an adapter may inject for the next model request. */
  additionalContext?: string
  /** A user-facing warning requested by an adapter, when its host can surface one. */
  systemMessage?: string
  /**
   * A tool-input rewrite a hook requested. The protocol preserves this neutral
   * value; an adapter may honor it only at a host seam that commits the rewrite
   * before execution and then re-enters ordinary validation and permission
   * policy.
   */
  updatedInput?: Record<string, unknown>
}
