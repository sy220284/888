import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { LocalCredentialProvider } from '../../../credentials/credentials-local/src/index.ts'
import * as Retry from '../src/index.ts'

let context: Context | undefined
let server: MockLlmServer | undefined
let home: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await server?.close()
  server = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

describe('credential rotation through the real DeepSeek request and retry chain', () => {
  it('retries AUTH with the next credential after backoff', async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-deepseek-credential-rotation-'))
    await writeFile(
      join(home, '.credentials.yaml'),
      'version: 1\nrefs:\n  KEY_A: first-key\n  KEY_B: second-key\n',
      { mode: 0o600 },
    )
    server = await startMockLlmServer({
      sequence: ['auth_error', 'success'],
      successText: 'official provider rotated',
    })

    const ctx = new Context()
    context = ctx
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(LlmDeepSeek, {
      apiKeyEnvs: ['KEY_A', 'KEY_B'],
      baseURL: server.baseURL,
      retryPolicy: {
        mode: 'normal',
        maxRetries: 1,
        retryableCodes: ['AUTH'],
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
    })
    await ctx.plugin(Retry)
    await ctx.plugin(AgentLoop, { agents: [] })

    const agent = ctx.agentLoop.create(SessionId('deepseek-credential-rotation'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'rotate the official provider credential' }],
      source: { kind: 'user' },
    }))
    await idle

    expect(server.requests.map(request => request.headers.authorization))
      .toEqual(['Bearer first-key', 'Bearer second-key'])
    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['AUTH'])
    const assistant = agent.session.deriveMessages().at(-1)
    expect(assistant?.role).toBe('assistant')
    if (assistant?.role !== 'assistant') throw new Error('expected assistant response')
    expect(assistant.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toBe('official provider rotated')
  })
})
