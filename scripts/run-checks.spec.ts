import { describe, expect, it } from 'vitest'
import { checksForMode } from './run-checks.ts'

describe('local check groups', () => {
  it.each(['check-all', 'hygiene'] as const)('defines a non-empty %s group', (mode) => {
    expect(checksForMode(mode)).not.toHaveLength(0)
  })

  it('keeps the hygiene group free of recursive aggregate calls', () => {
    expect(checksForMode('hygiene').map(check => check.script)).not.toEqual(
      expect.arrayContaining(['check:all', 'hygiene']),
    )
  })

  it('runs source checks before build-dependent hygiene checks', () => {
    const checks = checksForMode('check-all').map(check => check.script)
    expect(checks.indexOf('lint')).toBeLessThan(checks.indexOf('typecheck'))
    expect(checks.indexOf('typecheck')).toBeLessThan(checks.indexOf('test'))
    expect(checks.indexOf('test')).toBeLessThan(checks.indexOf('build'))
    expect(checks.indexOf('build')).toBeLessThan(checks.indexOf('publint'))
    expect(checks.at(-1)).toBe('verify-runtime-closure')
  })
})
