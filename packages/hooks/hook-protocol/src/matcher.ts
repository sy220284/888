/**
 * Canonical hook matcher engine. Ecosystem adapters choose a matcher strategy
 * after parsing their native configuration; this module contains no requirement
 * to enumerate providers. Missing, empty, and `*` match all. Runtime matching
 * contains invalid regexes as non-matches; config parsers use
 * {@link matcherDiagnostic} to reject them with a diagnostic.
 * @module @deepseek-ai/dsh-hook-protocol/matcher
 */

import type { LegacyMatcherMode, MatcherStrategy } from './types.ts'

/** Compatibility input accepted while existing adapters migrate to strategies. */
type MatcherModeInput = MatcherStrategy | LegacyMatcherMode

/** True for an absent / empty / `'*'` pattern — the match-all sentinels. */
function isMatchAll(matcher: string | undefined): boolean {
  return matcher === undefined || matcher === '' || matcher === '*'
}

/** Literal-alternation strategies use this as their regex-vs-literal discriminator. */
const LITERAL_ALTERNATION = /^[A-Za-z0-9_|]+$/

/** Compile an unanchored matcher regex; invalid patterns return `undefined`. */
function compileRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern)
  } catch (_syntaxError) {
    // RegExp construction is the try's only operation, so malformed pattern
    // syntax is the only expected failure.
    return undefined
  }
}

/**
 * Convert legacy provider selectors into canonical matcher behavior. The legacy
 * branch is deliberately closed: new ecosystem adapters select a strategy and
 * never add their provider name here.
 */
function matcherStrategy(mode: MatcherModeInput): MatcherStrategy {
  if (mode === 'claude-code') return 'literal-alternation-or-regex'
  if (mode === 'codex') return 'regex'
  return mode
}

/** Preserve legacy diagnostic labels; give canonical strategies readable labels. */
function matcherDiagnosticLabel(mode: MatcherModeInput): string {
  if (mode === 'claude-code' || mode === 'codex') return mode
  return `${mode}-strategy`
}

/**
 * Validate one matcher before an adapter accepts its config group.
 * @param matcher - configured pattern; match-all sentinels are valid.
 * @param mode - canonical strategy, or a legacy bridge selector during migration.
 * @returns `undefined` for a valid matcher, otherwise a stable diagnostic.
 */
export function matcherDiagnostic(matcher: string | undefined, mode: MatcherModeInput): string | undefined {
  if (isMatchAll(matcher)) return undefined
  const pattern = matcher as string
  const strategy = matcherStrategy(mode)
  if (strategy === 'literal-alternation-or-regex' && LITERAL_ALTERNATION.test(pattern)) return undefined
  return compileRegex(pattern) === undefined
    ? `invalid ${matcherDiagnosticLabel(mode)} regex matcher ${JSON.stringify(pattern)}`
    : undefined
}

/**
 * Whether `matcher` selects `query` under a canonical matcher strategy.
 * Literal-alternation patterns exact-match pipe-separated alternatives; all
 * other patterns are unanchored regexes. Invalid regexes return `false` rather
 * than throwing; config parsers surface them through {@link matcherDiagnostic}.
 * @param matcher - configured pattern; absent/empty/`'*'` are match-all sentinels.
 * @param query - candidate value such as a tool name or session source.
 * @param mode - canonical strategy, or a legacy bridge selector during migration.
 */
export function matchesMatcher(matcher: string | undefined, query: string, mode: MatcherModeInput): boolean {
  if (isMatchAll(matcher)) return true
  const pattern = matcher as string
  const strategy = matcherStrategy(mode)
  if (strategy === 'literal-alternation-or-regex' && LITERAL_ALTERNATION.test(pattern)) {
    return pattern.split('|').includes(query)
  }
  return compileRegex(pattern)?.test(query) ?? false
}