import { describe, expect, it } from 'vitest'
import { checksForMode } from './run-checks.ts'

describe('local check groups', () => {
  it.each(['check-all', 'doc-sync', 'hygiene'] as const)('defines a non-empty %s group', (mode) => {
    expect(checksForMode(mode)).not.toHaveLength(0)
  })

  it('keeps documentation and hygiene groups free of recursive aggregate calls', () => {
    for (const mode of ['doc-sync', 'hygiene'] as const) {
      expect(checksForMode(mode).map(check => check.script)).not.toEqual(
        expect.arrayContaining(['check:all', 'doc-sync', 'hygiene']),
      )
    }
  })

  it('does not gate changes on bilingual or English-only documentation maintenance', () => {
    for (const mode of ['check-all', 'doc-sync'] as const) {
      expect(checksForMode(mode).map(check => check.script)).not.toEqual(
        expect.arrayContaining([
          'verify-translation-pairing',
          'verify-translation-prompt',
          'verify-package-readme-model-experience',
        ]),
      )
    }
  })

  it('runs the broad group in dependency order', () => {
    const checks = checksForMode('check-all').map(check => check.script)

    expect(checks.indexOf('build')).toBeLessThan(checks.indexOf('test:snapshot'))
    expect(checks.indexOf('build')).toBeLessThan(checks.indexOf('publint'))
    expect(checks.at(-1)).toBe('verify-module-graph')
  })
})
