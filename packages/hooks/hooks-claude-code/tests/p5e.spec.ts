import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function project(scriptBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-p5e-'))
  dirs.push(dir)
  const script = join(dir, 'rewrite.sh')
  writeFileSync(script, scriptBody)
  chmodSync(script, 0o755)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
    hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: script }] }] },
  }))
  return dir
}

async function harness(dir: string, toolName = 'echo'): Promise<{ ctx: Context; adapter: MockAdapter }> {
  const adapter = new MockAdapter([toolCallResponse('c1', toolName, {}), textResponse('done')])
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath: join(dir, 'hooks.json') })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: toolName,
    description: 'returns a secret',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'secret' }] },
  }))
  return { ctx, adapter }
}

function prompt() {
  return createUserMessage({ content: [{ type: 'text' as const, text: 'go' }], source: { kind: 'user' as const } })
}

describe('hooks-claude-code P5E PostToolUse output rewrite', () => {
  it('passes the structured original response and persists the validated replacement', async () => {
    const dir = project(`#!/usr/bin/env bash
set -euo pipefail
payload="$(cat)"
[[ "$payload" == *'"tool_response":[{"type":"text","text":"secret"}]'* ]] || exit 9
echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":[{"type":"text","text":"redacted"}]}}'
`)
    const { ctx, adapter } = await harness(dir)
    const agent = ctx.agentLoop.create(SessionId('p5e-rewrite'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    const result = agent.session.events.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' ? result.data.message.content[0]?.content : undefined)
      .toEqual([{ type: 'text', text: 'redacted' }])
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('redacted')
    expect(JSON.stringify(adapter.requests[1]?.messages)).not.toContain('secret')
  })

  it('ignores a replacement that violates the tool output schema', async () => {
    const dir = project(`#!/usr/bin/env bash
cat >/dev/null
echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{"not":"content blocks"}}}'
`)
    const { ctx } = await harness(dir)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const agent = ctx.agentLoop.create(SessionId('p5e-invalid'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    const result = agent.session.events.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' ? result.data.message.content[0]?.content : undefined)
      .toEqual([{ type: 'text', text: 'secret' }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not match its output schema (ignored)'))
  })

  it('applies updatedMCPToolOutput only to an MCP-qualified tool', async () => {
    const dir = project(`#!/usr/bin/env bash
cat >/dev/null
echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedMCPToolOutput":[{"type":"text","text":"mcp-redacted"}]}}'
`)
    const { ctx } = await harness(dir, 'mcp__fixture__echo')
    const agent = ctx.agentLoop.create(SessionId('p5e-mcp'), { provider: 'mock', model: 'mock' })

    agent.followup(prompt())
    await agent.whenIdle()

    const result = agent.session.events.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' ? result.data.message.content[0]?.content : undefined)
      .toEqual([{ type: 'text', text: 'mcp-redacted' }])
  })
})
