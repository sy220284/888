import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-p5b-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.claude'), { recursive: true })
  return dir
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

function settings(dir: string, hooks: unknown, local = false): void {
  writeFileSync(
    join(dir, '.claude', local ? 'settings.local.json' : 'settings.json'),
    JSON.stringify({ hooks }),
  )
}

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { discoverProjectHooks: true })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function prompt(text = 'go') {
  return createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' as const } })
}

describe('hooks-claude-code P5B per-session project discovery', () => {
  it('isolates project settings by session cwd', async () => {
    const a = project()
    const b = project()
    const aHook = script(a, 'a.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"project-A"}}\'\n')
    const bHook = script(b, 'b.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"project-B"}}\'\n')
    settings(a, { SessionStart: [{ hooks: [{ type: 'command', command: aHook }] }] })
    settings(b, { SessionStart: [{ hooks: [{ type: 'command', command: bHook }] }] })

    const adapter = new MockAdapter([textResponse('a'), textResponse('b')])
    const ctx = await harness(adapter)

    const agentA = ctx.agentLoop.create(SessionId('p5b-a'), { provider: 'mock', model: 'mock' }, { cwd: a })
    agentA.followup(prompt())
    await agentA.whenIdle()

    const agentB = ctx.agentLoop.create(SessionId('p5b-b'), { provider: 'mock', model: 'mock' }, { cwd: b })
    agentB.followup(prompt())
    await agentB.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('project-A')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('project-B')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('project-B')
    expect(JSON.stringify(adapter.requests[1]!.messages)).not.toContain('project-A')
  })

  it('re-reads project settings between hook points without restarting the process', async () => {
    const dir = project()
    const first = script(dir, 'first.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"config-v1"}}\'\n')
    const second = script(dir, 'second.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"config-v2"}}\'\n')
    settings(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: first }] }] })

    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('p5b-reload'), { provider: 'mock', model: 'mock' }, { cwd: dir })

    agent.followup(prompt('first'))
    await agent.whenIdle()
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('config-v1')

    settings(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: second }] }] })
    agent.followup(prompt('second'))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('config-v2')
  })

  it('merges shared and local project settings in deterministic order', async () => {
    const dir = project()
    const shared = script(dir, 'shared.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"shared-hook"}}\'\n')
    const local = script(dir, 'local.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"local-hook"}}\'\n')
    settings(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: shared }] }] })
    settings(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: local }] }] }, true)

    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('p5b-layered'), { provider: 'mock', model: 'mock' }, { cwd: dir })

    agent.followup(prompt())
    await agent.whenIdle()

    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request.indexOf('shared-hook')).toBeGreaterThanOrEqual(0)
    expect(request.indexOf('local-hook')).toBeGreaterThan(request.indexOf('shared-hook'))
  })
})
