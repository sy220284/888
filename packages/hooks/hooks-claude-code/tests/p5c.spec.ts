import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SubagentRuntime, { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-p5c-'))
  dirs.push(dir)
  return dir
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

function config(dir: string, hooks: unknown): string {
  const path = join(dir, 'hooks.json')
  writeFileSync(path, JSON.stringify({ hooks }))
  return path
}

function subagentCarrier(ctx: Context) {
  return scopeTarget(ctx as unknown as SubagentRuntime, undefined)
}

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function harness(configPath: string): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  return ctx
}

describe('hooks-claude-code P5C subagent type matcher', () => {
  it('uses a local child persisted agentPreset for SubagentStart and SubagentStop', async () => {
    const dir = project()
    const startPayload = join(dir, 'start.json')
    const stopPayload = join(dir, 'stop.json')
    const wrongMarker = join(dir, 'wrong-generic')
    const capture = script(dir, 'capture.sh', `#!/usr/bin/env bash\nset -euo pipefail\npayload="$(cat)"\nevent="$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).hook_event_name))')"\nif [ "$event" = "SubagentStart" ]; then printf '%s' "$payload" > "${startPayload}"; else printf '%s' "$payload" > "${stopPayload}"; fi\n`)
    const wrong = script(dir, 'wrong.sh', `#!/usr/bin/env bash\ntouch "${wrongMarker}"\n`)
    const path = config(dir, {
      SubagentStart: [
        { matcher: 'code-reviewer', hooks: [{ type: 'command', command: capture }] },
        { matcher: 'general-purpose', hooks: [{ type: 'command', command: wrong }] },
      ],
      SubagentStop: [
        { matcher: 'code-reviewer', hooks: [{ type: 'command', command: capture }] },
        { matcher: 'general-purpose', hooks: [{ type: 'command', command: wrong }] },
      ],
    })
    const ctx = await harness(path)
    const child = await ctx.agents.create({
      sessionId: SessionId('p5c-preset-child'),
      meta: { cwd: dir, origin: 'subagent', agentPreset: 'code-reviewer' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const runId = SubagentRunId('p5c-preset-run')
    const identity = { runId, provider: 'inproc', id: child.agent.id, local: true }

    ctx.emit(subagentCarrier(ctx), 'subagent/start', identity)
    await waitFor(() => existsSync(startPayload))
    await child.dispose()
    ctx.emit(subagentCarrier(ctx), 'subagent/end', { ...identity, stopReason: 'completed' })
    await waitFor(() => existsSync(stopPayload))

    expect(JSON.parse(readFileSync(startPayload, 'utf8'))).toMatchObject({
      hook_event_name: 'SubagentStart',
      agent_type: 'code-reviewer',
    })
    expect(JSON.parse(readFileSync(stopPayload, 'utf8'))).toMatchObject({
      hook_event_name: 'SubagentStop',
      agent_type: 'code-reviewer',
    })
    expect(existsSync(wrongMarker)).toBe(false)
  })

  it('falls back to general-purpose when the child has no persisted agentPreset', async () => {
    const dir = project()
    const marker = join(dir, 'fallback.json')
    const capture = script(dir, 'fallback.sh', `#!/usr/bin/env bash\ncat > "${marker}"\n`)
    const path = config(dir, {
      SubagentStart: [{ matcher: 'general-purpose', hooks: [{ type: 'command', command: capture }] }],
    })
    const ctx = await harness(path)
    const child = await ctx.agents.create({
      sessionId: SessionId('p5c-default-child'),
      meta: { cwd: dir, origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    ctx.emit(subagentCarrier(ctx), 'subagent/start', {
      runId: SubagentRunId('p5c-default-run'),
      provider: 'inproc',
      id: child.agent.id,
      local: true,
    })
    await waitFor(() => existsSync(marker))

    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({
      hook_event_name: 'SubagentStart',
      agent_type: 'general-purpose',
    })
    await child.dispose()
  })
})
