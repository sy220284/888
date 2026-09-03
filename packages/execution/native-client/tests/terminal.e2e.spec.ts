import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import NativeExecutionClient from '@deepseek-ai/dsh-native-client'

async function collect(readable: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of readable) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const binaryPath = resolve('native/execution-core/target/debug/dsh-execution-core')

it.skipIf(process.platform === 'win32')('closes terminal output when transport fails after exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-native-sidecar-'))
  const fakeSidecar = join(dir, 'fake-sidecar.mjs')
  await writeFile(fakeSidecar, `#!/usr/bin/env node
import { createInterface } from 'node:readline'
const lines = createInterface({ input: process.stdin })
const send = (frame, callback) => process.stdout.write(JSON.stringify(frame) + '\\n', callback)
lines.on('line', line => {
  const frame = JSON.parse(line)
  if (frame.op === 'hello') {
    send({ id: frame.id, ok: true, result: {
      protocol: 1,
      platform: process.platform,
      capabilities: { processTree: true, terminal: true, filesystem: false, networkPolicy: false },
    } })
    return
  }
  if (frame.op === 'spawn_terminal') {
    send({ id: frame.id, ok: true, result: { process_id: frame.process_id, pid: 42 } })
    send({ event: 'terminal_output', process_id: frame.process_id, data_b64: Buffer.from('partial').toString('base64') })
    send({ event: 'exit', process_id: frame.process_id, exit_code: 0, signal: null }, () => process.exit(23))
  }
})
`, { mode: 0o700 })

  const ctx = new Context()
  const fiber = await ctx.plugin(NativeExecutionClient, { binaryPath: fakeSidecar })
  try {
    const handle = await ctx.nativeExecution.spawnTerminal({
      argv: ['/bin/sh'],
      cwd: process.cwd(),
      env: {},
      rows: 24,
      cols: 80,
    })
    const output = collect(handle.output)
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    await expect(output).rejects.toThrow('native execution sidecar exited (23)')
  } finally {
    await fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform !== 'linux' || !existsSync(binaryPath))('NativeExecutionClient terminal e2e', () => {
  it('preserves output and exit from a terminal that finishes immediately after spawn', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(NativeExecutionClient, { binaryPath })
    try {
      const handle = await ctx.nativeExecution.spawnTerminal({
        argv: ['/bin/sh', '-c', 'printf EARLY; exit 7'],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        rows: 24,
        cols: 80,
      })
      const [outcome, output] = await Promise.all([handle.done, collect(handle.output)])
      expect(output).toContain('EARLY')
      expect(outcome).toEqual({ exitCode: 7, signal: null })
    } finally {
      await fiber.dispose()
    }
  })
})
