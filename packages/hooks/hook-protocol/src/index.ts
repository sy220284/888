/**
 * Shared, non-plugin hook protocol library: canonical matching, command
 * execution and decoding, restrictive outcome merging, durable event helpers,
 * and detached run quiescence. Ecosystem adapters own their native payloads,
 * environment rules, matcher-strategy selection, and typed extension-point
 * mappings.
 * @module @deepseek-ai/dsh-hook-protocol
 */

export type {
  CommandHook,
  HookAdapterId,
  HookOutput,
  LegacyMatcherMode,
  MatcherGroup,
  MatcherStrategy,
} from './types.ts'
// Public compatibility aliases intentionally remain exported while callers migrate.
// oxlint-disable-next-line typescript/no-deprecated
export type { HookDialect, MatcherMode } from './types.ts'
export { matcherDiagnostic, matchesMatcher } from './matcher.ts'
export { parseHookOutput } from './codec.ts'
export { DEFAULT_HOOK_TIMEOUT_MS, runHook } from './runner.ts'
export type { RunHookOptions, RunHookResult } from './runner.ts'
export { mergeHookOutputs } from './merge.ts'
export type { MergedDecision, MergedHookOutcome } from './merge.ts'
export { appendHookInvoked, appendHookResult, DEFAULT_STDERR_SUMMARY_MAX_CHARS, summarizeStderr } from './events.ts'
export type { HookInvocation, HookResultRecord } from './events.ts'
export { createDetachedRuns } from './detached.ts'
export type { DetachedRuns } from './detached.ts'
