import { describe, expect, it } from 'vitest'
import { matcherDiagnostic, matchesMatcher } from '@deepseek-ai/dsh-hook-protocol'

describe('matchesMatcher — canonical match-all sentinels', () => {
  for (const strategy of ['literal-alternation-or-regex', 'regex'] as const) {
    it(`${strategy}: absent / empty / '*' match everything`, () => {
      expect(matchesMatcher(undefined, 'Bash', strategy)).toBe(true)
      expect(matchesMatcher('', 'anything', strategy)).toBe(true)
      expect(matchesMatcher('*', 'whatever', strategy)).toBe(true)
    })
  }
})

describe('matchesMatcher — literal-alternation-or-regex strategy', () => {
  it('a pure word-char pattern is a literal exact match', () => {
    expect(matchesMatcher('Bash', 'Bash', 'literal-alternation-or-regex')).toBe(true)
    expect(matchesMatcher('Bash', 'BashOutput', 'literal-alternation-or-regex')).toBe(false)
  })

  it('a pipe pattern is literal alternation', () => {
    expect(matchesMatcher('Edit|Write', 'Edit', 'literal-alternation-or-regex')).toBe(true)
    expect(matchesMatcher('Edit|Write', 'Write', 'literal-alternation-or-regex')).toBe(true)
    expect(matchesMatcher('Edit|Write', 'Read', 'literal-alternation-or-regex')).toBe(false)
    expect(matchesMatcher('Edit|Write', 'EditFile', 'literal-alternation-or-regex')).toBe(false)
  })

  it('a non-word pattern falls through to unanchored regex', () => {
    expect(matchesMatcher('^Bash$', 'Bash', 'literal-alternation-or-regex')).toBe(true)
    expect(matchesMatcher('Bash.*', 'BashOutput', 'literal-alternation-or-regex')).toBe(true)
    expect(matchesMatcher('.*\\.ts$', 'foo.ts', 'literal-alternation-or-regex')).toBe(true)
    expect(matchesMatcher('.*\\.ts$', 'foo.js', 'literal-alternation-or-regex')).toBe(false)
  })
})

describe('matchesMatcher — regex strategy', () => {
  it('a word pattern is an unanchored regex', () => {
    expect(matchesMatcher('Bash', 'Bash', 'regex')).toBe(true)
    expect(matchesMatcher('Bash', 'BashOutput', 'regex')).toBe(true)
  })

  it('regex alternation and anchors work', () => {
    expect(matchesMatcher('Edit|Write', 'Edit', 'regex')).toBe(true)
    expect(matchesMatcher('^Bash$', 'Bash', 'regex')).toBe(true)
    expect(matchesMatcher('^Bash$', 'BashOutput', 'regex')).toBe(false)
  })
})

describe('matchesMatcher — legacy provider aliases', () => {
  it('keeps existing bridge behavior without making provider ids the canonical API', () => {
    expect(matchesMatcher('Bash', 'BashOutput', 'claude-code')).toBe(false)
    expect(matchesMatcher('Bash', 'BashOutput', 'codex')).toBe(true)
  })
})

describe('matchesMatcher — invalid regex is a non-match', () => {
  it('never throws for malformed patterns', () => {
    expect(() => matchesMatcher('(', 'x', 'literal-alternation-or-regex')).not.toThrow()
    expect(matchesMatcher('(', 'x', 'literal-alternation-or-regex')).toBe(false)
    expect(matchesMatcher('[', 'x', 'regex')).toBe(false)
  })
})

describe('matcherDiagnostic — parse-time diagnostics', () => {
  it('accepts match-all sentinels, literals, and valid regexes through canonical strategies', () => {
    expect(matcherDiagnostic(undefined, 'literal-alternation-or-regex')).toBeUndefined()
    expect(matcherDiagnostic('', 'regex')).toBeUndefined()
    expect(matcherDiagnostic('*', 'regex')).toBeUndefined()
    expect(matcherDiagnostic('Edit|Write', 'literal-alternation-or-regex')).toBeUndefined()
    expect(matcherDiagnostic('^Bash$', 'literal-alternation-or-regex')).toBeUndefined()
    expect(matcherDiagnostic('Edit|Write', 'regex')).toBeUndefined()
  })

  it('keeps legacy diagnostic strings stable while adapters migrate', () => {
    expect(matcherDiagnostic('(', 'claude-code')).toBe('invalid claude-code regex matcher "("')
    expect(matcherDiagnostic('[', 'codex')).toBe('invalid codex regex matcher "["')
  })

  it('reports canonical strategy ids for new adapters', () => {
    expect(matcherDiagnostic('(', 'literal-alternation-or-regex'))
      .toBe('invalid literal-alternation-or-regex regex matcher "("')
    expect(matcherDiagnostic('[', 'regex')).toBe('invalid regex regex matcher "["')
  })
})
