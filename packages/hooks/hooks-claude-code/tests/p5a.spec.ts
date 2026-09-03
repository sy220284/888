import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeConfig(hooks: unknown, scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-p5a-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }).replaceAll('__DIR__', dir))
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, name)
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }
  return dir
}

async function harness(
  configDir: string,
  adapter: MockAdapter,
  options: Omit<HooksClaude.Config, 'configPath'> = {},
): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath: join(configDir, 'hooks.json'), ...options })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function prompt(text = 'go') {
  return createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' as const } })
}

describe('hooks-claude-code P5A lifecycle correctness', () => {
  it('gates the first model request until SessionStart context is ready', async () => {
    const dir = writeConfig(
      { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '__DIR__/start.sh' }] }] },
      { 'start.sh': '#!/usr/bin/env bash\nsleep 0.08\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"startup-ready"}}\'\n' },
    )
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('p5a-start'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('startup-ready')
  })

  it('routes failed tools only through PostToolUseFailure and exposes the canonical error', async () => {
    const dir = writeConfig(
      {
        PostToolUse: [{ matcher: 'boom', hooks: [{ type: 'command', command: '__DIR__/success.sh' }] }],
        PostToolUseFailure: [{ matcher: 'boom', hooks: [{ type: 'command', command: '__DIR__/failure.sh' }] }],
      },
      {
        'success.sh': '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"WRONG-success-hook"}}\'\n',
        'failure.sh': '#!/usr/bin/env bash\ninput=$(cat)\n[[ "$input" == *\'"hook_event_name":"PostToolUseFailure"\'* ]] || exit 9\n[[ "$input" == *\'"error":"boom-body"\'* ]] || exit 10\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"failure-advice"}}\'\n',
      },
    )
    const adapter = new MockAdapter([toolCallResponse('c1', 'boom', {}), textResponse('recovered')])
    const ctx = await harness(dir, adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'boom',
      description: 'fails',
      parameters: {},
      async execute() { throw new Error('boom-body') },
    }))
    const agent = ctx.agentLoop.create(SessionId('p5a-failure'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const second = JSON.stringify(adapter.requests[1]!.messages)
    expect(second).toContain('failure-advice')
    expect(second).not.toContain('WRONG-success-hook')
  })

  it('honors continue:false before the first model request', async () => {
    const dir = writeConfig(
      { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '__DIR__/stop.sh' }] }] },
      { 'stop.sh': '#!/usr/bin/env bash\necho \'{"continue":false,"stopReason":"policy-stop"}\'\n' },
    )
    const adapter = new MockAdapter([textResponse('must-not-run')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('p5a-stop'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(0)
  })

  it('defers PostToolUse continue:false until after the canonical tool result is committed', async () => {
    const dir = writeConfig(
      { PostToolUse: [{ matcher: 'echo', hooks: [{ type: 'command', command: '__DIR__/stop.sh' }] }] },
      { 'stop.sh': '#!/usr/bin/env bash\necho \'{"continue":false,"stopReason":"done-after-tool"}\'\n' },
    )
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('must-not-run')])
    const ctx = await harness(dir, adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'tool-ok' }] },
    }))
    const agent = ctx.agentLoop.create(SessionId('p5a-post-stop'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const toolResult = agent.session.events.find(event => event.type === 'tool/result')
    expect(toolResult?.type === 'tool/result' && toolResult.data.message.content[0].isError).toBe(false)
  })

  it('caps consecutive Stop-hook forced continuations per turn', async () => {
    const dir = writeConfig(
      { Stop: [{ hooks: [{ type: 'command', command: '__DIR__/block.sh' }] }] },
      { 'block.sh': '#!/usr/bin/env bash\necho "keep going" >&2\nexit 2\n' },
    )
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three'), textResponse('four')])
    const ctx = await harness(dir, adapter, { maxStopContinuations: 2 })
    const agent = ctx.agentLoop.create(SessionId('p5a-loop-guard'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(3)
  })
})
