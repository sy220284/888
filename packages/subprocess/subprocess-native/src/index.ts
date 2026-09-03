/** Native-execution provider for the stable `ctx.subprocess` seam. */
import { Context } from '@deepseek-ai/cordis'
import { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'
import {
  scrubbedParentEnv,
  SubprocessRuntime,
} from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type {
  NativeProcessHandle,
  NativeTerminalHandle,
} from '@deepseek-ai/dsh-native-execution'
import type {} from '@deepseek-ai/dsh-native-execution'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { NativeOutputCollector } from './output.ts'

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

function waitMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function mergedChildEnv(
  explicit: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
  const env: Record<string, string> = { ...scrubbedParentEnv() }
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (value === undefined) Reflect.deleteProperty(env, key)
    else env[key] = value
  }
  return env
}

async function waitForStream(
  stream: Readable | undefined,
  graceMs: number,
): Promise<boolean> {
  if (stream === undefined || stream.readableEnded || stream.destroyed)
    return true
  const result = await Promise.race([
    new Promise<void>((resolve) => {
      const done = (): void => {
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        stream.off('end', done)
        stream.off('close', done)
        stream.off('error', done)
      }
      stream.once('end', done)
      stream.once('close', done)
      stream.once('error', done)
    }),
    waitMs(graceMs).then(() => false),
  ])
  if (result === false) stream.destroy()
  return result !== false
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return Buffer.from(String(chunk))
}

class NativeSubprocessHandle implements SubprocessHandle {
  readonly stdin: SubprocessHandle['stdin']
  readonly stdout: SubprocessHandle['stdout']
  readonly stderr: SubprocessHandle['stderr']
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>
  private readonly stdoutCollector: NativeOutputCollector | undefined
  private readonly stderrCollector: NativeOutputCollector | undefined
  private terminating = false
  private quiescent = false

  constructor(
    private readonly native: NativeProcessHandle,
    private readonly spec: SubprocessSpawnSpec,
  ) {
    this.stdin = spec.stdio.stdin === 'pipe' ? native.stdin : undefined
    this.stdout = spec.stdio.stdout === 'pipe' ? native.stdout : undefined
    this.stderr = spec.stdio.stderr === 'pipe' ? native.stderr : undefined
    if (spec.stdio.stdout === 'inherit')
      native.stdout?.pipe(process.stdout, { end: false })
    if (spec.stdio.stderr === 'inherit')
      native.stderr?.pipe(process.stderr, { end: false })
    this.stdoutCollector = isCollect(spec.stdio.stdout)
      ? new NativeOutputCollector(spec.stdio.stdout, 'stdout')
      : undefined
    this.stderrCollector = isCollect(spec.stdio.stderr)
      ? new NativeOutputCollector(spec.stdio.stderr, 'stderr')
      : undefined
    if (this.stdoutCollector !== undefined)
      native.stdout?.on('data', (chunk: unknown) => {
        this.stdoutCollector?.push(asBuffer(chunk))
      })
    if (this.stderrCollector !== undefined)
      native.stderr?.on('data', (chunk: unknown) => {
        this.stderrCollector?.push(asBuffer(chunk))
      })
    this.collected = {
      ...(this.stdoutCollector !== undefined
        ? { stdout: this.stdoutCollector }
        : {}),
      ...(this.stderrCollector !== undefined
        ? { stderr: this.stderrCollector }
        : {}),
    }
    this.done = this.settleDone()
    void this.done.catch(() => {})
    spec.signal?.addEventListener(
      'abort',
      () => {
        this.terminate()
      },
      { once: true },
    )
    if (spec.signal?.aborted === true) this.terminate()
  }

  get pid(): number {
    return this.native.pid
  }

  terminate(): void {
    if (this.terminating || this.quiescent) return
    this.terminating = true
    void (async () => {
      await this.native.signalTree('SIGTERM').catch(() => undefined)
      await waitMs(this.spec.graceMs)
      if (await this.native.treeAlive().catch(() => false)) {
        await this.native.signalTree('SIGKILL').catch(() => undefined)
      }
    })()
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    while (!this.quiescent) {
      if (signal?.aborted === true) return false
      if (!(await this.native.treeAlive())) {
        this.quiescent = true
        return true
      }
      if (signal === undefined) await waitMs(15)
      else {
        const tick = AbortSignal.timeout(15)
        try {
          await new Promise<void>((resolve) => {
            tick.addEventListener(
              'abort',
              () => {
                resolve()
              },
              { once: true },
            )
          })
        } catch {
          /* timer only */
        }
      }
    }
    return true
  }

  private async settleDone(): Promise<SubprocessOutcome> {
    const outcome = await this.native.done
    await Promise.all([
      waitForStream(this.native.stdout, this.spec.graceMs),
      waitForStream(this.native.stderr, this.spec.graceMs),
    ])
    this.stdoutCollector?.seal()
    this.stderrCollector?.seal()
    return outcome
  }
}

class NativeSubprocessTerminalHandle implements SubprocessTerminalHandle {
  readonly pid: number
  readonly output: NativeTerminalHandle['output']
  readonly done: NativeTerminalHandle['done']
  private cleanup: Promise<void> | undefined
  private closing = false
  private readonly operations = new Set<Promise<unknown>>()

  constructor(
    private readonly native: NativeTerminalHandle,
    private readonly graceMs: number,
  ) {
    this.pid = native.pid
    this.output = native.output
    this.done = native.done
    void this.done.catch(() => {})
  }

  write(data: string): Promise<void> {
    return this.trackOperation(() => this.native.write(data))
  }

  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return this.trackOperation(() => this.native.inspectForeground())
  }

  signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    return this.trackOperation(() => this.native.signalForeground(signal))
  }

  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.closing = true
    const cleanup = this.closeAfterOperations()
    this.cleanup = cleanup
    // A failed cleanup must remain retryable. Keep the handle closed to new
    // operations, but let a later terminate() run the cleanup transaction again.
    void cleanup.catch(() => {
      this.cleanup = undefined
    })
    return cleanup
  }

  private trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error('subprocess-native: terminal is closing'))
    }
    const pending = operation()
    this.operations.add(pending)
    void pending.finally(() => this.operations.delete(pending)).catch(() => undefined)
    return pending
  }

  private async closeAfterOperations(): Promise<void> {
    await Promise.allSettled([...this.operations])
    await this.closeOnce()
  }

  private async closeOnce(): Promise<void> {
    await this.native.signalTree('SIGTERM').catch(() => undefined)
    const until = Date.now() + this.graceMs
    while (
      Date.now() < until &&
      (await this.native.treeAlive().catch(() => true))
    ) {
      await waitMs(Math.min(15, Math.max(1, until - Date.now())))
    }
    if (await this.native.treeAlive().catch(() => true)) {
      await this.native.signalTree('SIGKILL').catch(() => undefined)
    }
    const killUntil = Date.now() + this.graceMs
    while (
      Date.now() < killUntil &&
      (await this.native.treeAlive().catch(() => true))
    ) {
      await waitMs(Math.min(15, Math.max(1, killUntil - Date.now())))
    }
    if (await this.native.treeAlive().catch(() => true)) {
      throw new Error(
        `subprocess-native: terminal cleanup failed; surviving session ${this.pid}`,
      )
    }
    await this.done.then(() => undefined)
  }
}

/** Native subprocess provider over the P2 execution sidecar. */
export class NativeSubprocessRuntime extends SubprocessRuntime {
  static inject = ['nativeExecution']
  private readonly live = new Set<NativeSubprocessHandle>()
  private readonly terminals = new Set<NativeSubprocessTerminalHandle>()
  private disposing = false

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(
      () => async () => {
        this.disposing = true
        const handles = [...this.live]
        const terminals = [...this.terminals]
        for (const handle of handles) handle.terminate()
        await Promise.allSettled([
          ...handles.map(handle => handle.waitForExit()),
          ...terminals.map(handle => handle.terminate()),
        ])
        this.live.clear()
        this.terminals.clear()
      },
      'native subprocess teardown',
    )
  }

  override resolveExecutable(
    command: string,
    env: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
  ): Promise<string> {
    return this.ctx.nativeExecution.resolveExecutable(
      command,
      { ...scrubbedParentEnv(), ...env },
      signal,
    )
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing)
      throw new Error('subprocess-native: service is disposing')
    if (process.platform === 'win32')
      throw new Error(
        'subprocess-native: P2a native process trees are currently Unix-only',
      )
    const program = spec.argv[0]
    if (program === undefined || program.length === 0)
      throw new Error(
        'invalid argv: expected a non-empty program name at argv[0]',
      )
    if (
      !Number.isFinite(spec.graceMs) ||
      spec.graceMs <= 0 ||
      spec.graceMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error(
        `subprocess-native: graceMs must be positive, finite, and no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    if (spec.signal?.aborted === true)
      throw (
        spec.signal.reason ??
        new Error('subprocess-native: aborted before spawn')
      )
    const native = this.ctx.nativeExecution.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      env: mergedChildEnv(spec.env),
      stdin:
        spec.stdio.stdin === 'ignore' || spec.stdio.stdin === 'pipe'
          ? spec.stdio.stdin
          : { data: spec.stdio.stdin.data },
      // The sidecar stdout is the JSON control channel, so even inherited
      // process output is piped over the protocol and forwarded here.
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const handle = new NativeSubprocessHandle(native, spec)
    this.live.add(handle)
    const release = async (): Promise<void> => {
      await handle.waitForExit().catch(() => false)
      this.live.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {
      /* disposal retains failed cleanup */
    })
    return handle
  }

  override async spawnTerminal(
    spec: SubprocessTerminalSpawnSpec,
  ): Promise<SubprocessTerminalHandle> {
    if (this.disposing)
      throw new Error('subprocess-native: service is disposing')
    if (process.platform !== 'linux')
      throw new Error('subprocess-native: native PTY is currently Linux-only')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0)
      throw new Error(
        'subprocess-native: terminal argv must contain a program',
      )
    if (
      !Number.isSafeInteger(spec.rows) ||
      spec.rows < 1 ||
      spec.rows > 65_535
    ) {
      throw new Error(
        'subprocess-native: terminal rows must be an integer from 1 through 65535',
      )
    }
    if (
      !Number.isSafeInteger(spec.cols) ||
      spec.cols < 1 ||
      spec.cols > 65_535
    ) {
      throw new Error(
        'subprocess-native: terminal cols must be an integer from 1 through 65535',
      )
    }
    if (
      !Number.isFinite(spec.graceMs) ||
      spec.graceMs <= 0 ||
      spec.graceMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error(
        `subprocess-native: graceMs must be positive, finite, and no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    spec.signal?.throwIfAborted()
    const hello = await this.ctx.nativeExecution.hello()
    if (!hello.capabilities.terminal) {
      throw new Error(
        `subprocess-native: terminal primitive is unavailable (native capability terminal=${String(hello.capabilities.terminal)})`,
      )
    }
    const native = await this.ctx.nativeExecution.spawnTerminal({
      argv: spec.argv,
      cwd: spec.cwd,
      env: mergedChildEnv(spec.env),
      rows: spec.rows,
      cols: spec.cols,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    })
    const handle = new NativeSubprocessTerminalHandle(native, spec.graceMs)
    this.terminals.add(handle)
    const release = async (): Promise<void> => {
      await handle.done.catch(() => undefined)
      // Direct shell exit is not ownership release: terminate() proves the
      // complete terminal tree/session quiescent and drains in-flight calls.
      await handle.terminate()
      this.terminals.delete(handle)
    }
    void release().catch(() => {
      // Retain failed cleanup so service disposal can retry it.
    })
    return handle
  }
}

export default NativeSubprocessRuntime
