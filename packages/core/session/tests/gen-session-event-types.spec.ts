import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectSessionEventTypes, renderKnownEventTypes } from '../../../../scripts/gen-session-event-types.ts'

const roots: string[] = []

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'session-event-types-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

const ownerManifest = '{ "name": "@deepseek-ai/dsh-session" }\n'
const owner = `export interface SessionEventMap {
  'turn/start': { id: string }
}
`
const merge = `declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'tool/result': { id: string }
  }
}
`

describe('gen-session-event-types', () => {
  it('collects the owning interface and declaration merges in sorted order', () => {
    expect(collectSessionEventTypes(fixture({
      'packages/core/session/package.json': ownerManifest,
      'packages/core/session/src/types.ts': owner,
      'packages/tool/sample/src/types.ts': merge,
    }))).toEqual(['tool/result', 'turn/start'])
  })

  it('rejects duplicate event names', () => {
    expect(() => collectSessionEventTypes(fixture({
      'packages/core/session/package.json': ownerManifest,
      'packages/core/session/src/types.ts': owner,
      'packages/tool/sample/src/a.ts': merge,
      'packages/tool/sample/src/b.ts': merge,
    }))).toThrow(/duplicate event 'tool\/result'/)
  })

  it('rejects members that cannot become stable string event keys', () => {
    expect(() => collectSessionEventTypes(fixture({
      'packages/core/session/package.json': ownerManifest,
      'packages/core/session/src/types.ts': `export interface SessionEventMap {\n  event: { id: string }\n}\n`,
    }))).toThrow(/non-literal property member/)
  })

  it('renders a deterministic runtime set', () => {
    const rendered = renderKnownEventTypes(['turn/start', 'tool/result', 'turn/start'])
    expect(rendered).toContain("  'tool/result',\n  'turn/start',")
    expect(rendered.match(/'turn\/start'/g)).toHaveLength(1)
    expect(rendered).toContain('scripts/gen-session-event-types.ts')
  })
})
