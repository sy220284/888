import { describe, expect, it } from 'vitest'
import { defaultToolRequirements } from '@deepseek-ai/dsh-runtime-policy'

describe('runtime-policy tool requirements', () => {
  it('keeps first-party file operations precise enough for permission and scheduling', () => {
    expect(defaultToolRequirements({ name: 'read', arguments: { file_path: 'src/a.ts' } })).toEqual([
      { capability: 'file.read', resource: { kind: 'file', value: 'src/a.ts' }, access: 'read' },
    ])
    expect(defaultToolRequirements({ name: 'write', arguments: { file_path: 'src/a.ts' } })).toEqual([
      { capability: 'file.write', resource: { kind: 'file', value: 'src/a.ts' }, access: 'write', risk: 1, effect: true },
    ])
  })

  it('fails closed for an unclassified tool instead of treating it as requirement-free', () => {
    expect(defaultToolRequirements({ name: 'third_party_mutator', arguments: { value: 1 } })).toEqual([
      {
        capability: 'tool.execute',
        resource: { kind: 'tool', value: 'third_party_mutator' },
        access: 'control',
        risk: 2,
        effect: true,
      },
    ])
  })
})
