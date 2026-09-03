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

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-p5d-'))
  dirs.push(dir)
  return dir
}

function executable(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

async function harness(dir: string, adapter: MockAdapter, hooks: unknown): Promise<Context> {
  const configPath = join(dir, 'hooks.json')
  writeFileSync(configPath, JSON.stringify({ hooks }))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function prompt() {
  return createUserMessage({ content: [{ type: 'text' as const, text: 'go' }], source: { kind: 'user' as const } })
}

describe('hooks-claude-code P5D safe updatedInput rewrite', () => {
  it('chains rewrites, persists the final input, and runs each PreToolUse handler once', async () => {
    const dir = project()
    const first = executable(dir, 'first.sh', '#!/usr/bin/env bash\nset -euo pipefail\ninput="$(cat)"\n[[ "$input" == *\'"value":"original"\'* ]] || exit 9\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"value":"middle"}}}\'\n')
    const second = executable(dir, 'second.sh', '#!/usr/bin/env bash\nset -euo pipefail\ninput="$(cat)"\n[[ "$input" == *\'"value":"middle"\'* ]] || exit 10\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"value":"rewritten"}}}\'\n')
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { value: 'original' }), textResponse('done')])
    const ctx = await harness(dir, adapter, {
      PreToolUse: [{ matcher: 'echo', hooks: [
        { type: 'command', command: first },
        { type: 'command', command: second },
      ] }],
    })
    let seen: unknown
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: { value: { type: 'string', required: true } },
      async execute(args) {
        seen = args
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('p5d-rewrite'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    expect(seen).toEqual({ value: 'rewritten' })
    const assistant = agent.session.events.find(event => event.type === 'assistant/message')
    if (assistant?.type !== 'assistant/message') throw new Error('missing assistant/message')
    const call = assistant.data.message.content.find(block => block.type === 'tool-call')
    expect(call?.type === 'tool-call' ? JSON.parse(call.arguments) : undefined).toEqual({ value: 'rewritten' })
    const toolCall = agent.session.events.find(event => event.type === 'tool/call')
    expect(toolCall?.type === 'tool/call' ? JSON.parse(toolCall.data.arguments) : undefined).toEqual({ value: 'rewritten' })
    const invoked = agent.session.events.filter(event => event.type === 'hook/invoked' && event.data.point === 'PreToolUse')
    expect(invoked).toHaveLength(2)
  })

  it('revalidates rewritten input before the tool body', async () => {
    const dir = project()
    const rewrite = executable(dir, 'invalid.sh', '#!/usr/bin/env bash\nset -euo pipefail\ncat >/dev/null\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"value":42}}}\'\n')
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { value: 'original' }), textResponse('done')])
    const ctx = await harness(dir, adapter, {
      PreToolUse: [{ matcher: 'echo', hooks: [{ type: 'command', command: rewrite }] }],
    })
    let ran = false
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: { value: { type: 'string', required: true } },
      async execute() {
        ran = true
        return [{ type: 'text', text: 'must-not-run' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('p5d-revalidate'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    expect(ran).toBe(false)
    const call = agent.session.events.find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' ? JSON.parse(call.data.arguments) : undefined).toEqual({ value: 42 })
    const result = agent.session.events.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0]?.isError).toBe(true)
  })

  it('rejects identity changes before assistant/message and tool/call persistence', async () => {
    const dir = project()
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { value: 'original' })])
    const ctx = await harness(dir, adapter, {})
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: { value: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'must-not-run' }] },
    }))
    ctx.on('agent/tool-call-input', async (_payload, next) => ({ ...await next(), name: 'other' }))
    const agent = ctx.agentLoop.create(SessionId('p5d-identity'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(false)
    expect(agent.session.events.some(event => event.type === 'tool/call')).toBe(false)
    const end = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('error')
  })
})
