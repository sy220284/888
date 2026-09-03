/** JSONL sidecar provider for the native execution seam. */
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { PassThrough, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { NativeExecutionRuntime } from '@deepseek-ai/dsh-native-execution'
import type {
  NativeExecutionHello,
  NativeExecutionSignal,
  NativeProcessHandle,
  NativeProcessOutcome,
  NativeProcessSpawnSpec,
  NativeTerminalForeground,
  NativeTerminalHandle,
  NativeTerminalSpawnSpec,
} from '@deepseek-ai/dsh-native-execution'

/** Native execution sidecar launch configuration. */
export interface Config {
  binaryPath?: string
}
interface ResolvedConfig {
  binaryPath: string
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}
interface ResponseFrame {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}
type EventFrame =
  | { event: 'stdout'; process_id: string; data_b64: string }
  | { event: 'stderr'; process_id: string; data_b64: string }
  | { event: 'stream_closed'; process_id: string; stream: 'stdout' | 'stderr' }
  | { event: 'terminal_output'; process_id: string; data_b64: string }
  | { event: 'terminal_closed'; process_id: string }
  | {
    event: 'exit'
    process_id: string
    exit_code: number | null
    signal: NodeJS.Signals | null
  }

type ProtocolFrame = ResponseFrame | EventFrame

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
function abortError(signal: AbortSignal): Error {
  return signal.reason === undefined
    ? new Error('native execution request aborted')
    : asError(signal.reason)
}

async function signalStartedTree(
  started: Promise<number>,
  client: NativeExecutionClient,
  processId: string,
  signal: NativeExecutionSignal,
): Promise<void> {
  try {
    await started
  } catch {
    return
  }
  await client.request({ op: 'signal_tree', process_id: processId, signal })
}

async function startedTreeAlive(
  started: Promise<number>,
  client: NativeExecutionClient,
  processId: string,
): Promise<boolean> {
  try {
    await started
  } catch {
    return false
  }
  const result = await client.request<{ alive: boolean }>({
    op: 'tree_alive',
    process_id: processId,
  })
  return result.alive
}

/** Shared process-tree controls for pipe and PTY handles. */
abstract class SidecarTreeHandle {
  protected abstract readonly started: Deferred<number>

  constructor(
    readonly processId: string,
    protected readonly client: NativeExecutionClient,
  ) {}

  async signalTree(signal: NativeExecutionSignal): Promise<void> {
    await signalStartedTree(this.started.promise, this.client, this.processId, signal)
  }

  async treeAlive(): Promise<boolean> {
    return await startedTreeAlive(this.started.promise, this.client, this.processId)
  }
}

function sidecarEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (
      /KEY|PASSWORD|SECRET|TOKEN/i.test(key) ||
      key.toUpperCase().startsWith('DSH_')
    )
      continue
    env[key] = value
  }
  return env
}

class DeferredStdin extends Writable {
  constructor(private readonly handle: SidecarHandle) {
    super({ decodeStrings: true })
  }
  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    void this.handle.writeStdin(bytes).then(
      () => {
        callback()
      },
      (error: unknown) => {
        callback(asError(error))
      },
    )
  }
  override _final(callback: (error?: Error | null) => void): void {
    void this.handle.closeStdin().then(
      () => {
        callback()
      },
      (error: unknown) => {
        callback(asError(error))
      },
    )
  }
}

class SidecarHandle extends SidecarTreeHandle implements NativeProcessHandle {
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly stdin: Writable | undefined
  readonly done: Promise<NativeProcessOutcome>
  protected readonly started = Promise.withResolvers<number>()
  private readonly settled = Promise.withResolvers<NativeProcessOutcome>()
  private readonly streamsSettled = Promise.withResolvers<void>()
  private remotePid = -1
  private exited = false
  private stdoutClosed: boolean
  private stderrClosed: boolean

  constructor(
    processId: string,
    client: NativeExecutionClient,
    private readonly spec: NativeProcessSpawnSpec,
  ) {
    super(processId, client)
    this.stdout = spec.stdout === 'pipe' ? new PassThrough() : undefined
    this.stderr = spec.stderr === 'pipe' ? new PassThrough() : undefined
    this.stdoutClosed = spec.stdout !== 'pipe'
    this.stderrClosed = spec.stderr !== 'pipe'
    if (this.stdoutClosed && this.stderrClosed) this.streamsSettled.resolve()
    this.stdin = spec.stdin === 'pipe' ? new DeferredStdin(this) : undefined
    this.done = this.settled.promise
    void this.done.catch(() => {})
    void this.started.promise.catch(() => {})
    void this.start()
  }

  get pid(): number {
    return this.remotePid
  }

  private async start(): Promise<void> {
    try {
      await this.client.ensureReady()
      const result = await this.client.request<{
        process_id: string
        pid: number
      }>({
        op: 'spawn',
        process_id: this.processId,
        argv: [...this.spec.argv],
        cwd: this.spec.cwd,
        env: { ...(this.spec.env ?? {}) },
        stdin_mode:
          this.spec.stdin === 'ignore'
            ? 'ignore'
            : this.spec.stdin === 'pipe'
              ? 'pipe'
              : 'data',
        ...(typeof this.spec.stdin === 'object'
          ? {
            stdin_data_b64: Buffer.from(this.spec.stdin.data).toString(
              'base64',
            ),
          }
          : {}),
        stdout_mode: this.spec.stdout,
        stderr_mode: this.spec.stderr,
      })
      this.remotePid = result.pid
      this.started.resolve(result.pid)
    } catch (error: unknown) {
      this.started.reject(error)
      this.settled.reject(error)
      this.stdout?.destroy(asError(error))
      this.stderr?.destroy(asError(error))
      this.client.release(this.processId)
    }
  }

  async writeStdin(data: Uint8Array): Promise<void> {
    await this.started.promise
    await this.client.request({
      op: 'write_stdin',
      process_id: this.processId,
      data_b64: Buffer.from(data).toString('base64'),
    })
  }
  async closeStdin(): Promise<void> {
    try {
      await this.started.promise
    } catch {
      return
    }
    await this.client.request({
      op: 'close_stdin',
      process_id: this.processId,
    })
  }
  onOutput(stream: 'stdout' | 'stderr', data: Buffer): void {
    (stream === 'stdout' ? this.stdout : this.stderr)?.write(data)
  }
  onStreamClosed(stream: 'stdout' | 'stderr'): void {
    if (stream === 'stdout') this.stdoutClosed = true
    else this.stderrClosed = true;
    (stream === 'stdout' ? this.stdout : this.stderr)?.end()
    if (this.stdoutClosed && this.stderrClosed) this.streamsSettled.resolve()
  }
  waitForStreams(): Promise<void> {
    return this.streamsSettled.promise
  }
  onExit(outcome: NativeProcessOutcome): void {
    if (this.exited) return
    this.exited = true
    this.settled.resolve(outcome)
    this.client.releaseWhenQuiescent(this)
  }
  onTransportFailure(error: Error): void {
    const outcomeSettled = this.exited
    this.exited = true
    this.started.reject(error)
    if (!outcomeSettled) this.settled.reject(error)
    this.stdoutClosed = true
    this.stderrClosed = true
    this.streamsSettled.resolve()
    this.stdout?.destroy(error)
    this.stderr?.destroy(error)
  }
}

class SidecarTerminalHandle extends SidecarTreeHandle implements NativeTerminalHandle {
  readonly output = new PassThrough()
  readonly done: Promise<NativeProcessOutcome>
  protected readonly started = Promise.withResolvers<number>()
  private readonly settled = Promise.withResolvers<NativeProcessOutcome>()
  private readonly outputSettled = Promise.withResolvers<void>()
  private remotePid = -1
  private outputClosed = false
  private exited = false

  constructor(
    processId: string,
    client: NativeExecutionClient,
  ) {
    super(processId, client)
    this.done = this.settled.promise
    void this.done.catch(() => {})
    void this.started.promise.catch(() => {})
  }

  get pid(): number {
    return this.remotePid
  }

  onStarted(pid: number): void {
    if (this.remotePid !== -1) return
    this.remotePid = pid
    this.started.resolve(pid)
  }

  onStartFailure(error: Error): void {
    this.started.reject(error)
    if (!this.exited) {
      this.exited = true
      this.settled.reject(error)
    }
    if (!this.outputClosed) {
      this.outputClosed = true
      this.output.destroy(error)
    }
  }

  async write(data: string): Promise<void> {
    await this.started.promise
    await this.client.request({
      op: 'write_terminal',
      process_id: this.processId,
      data_b64: Buffer.from(data, 'utf8').toString('base64'),
    })
  }

  async inspectForeground(): Promise<NativeTerminalForeground | undefined> {
    await this.started.promise
    const result = await this.client.request<{
      foreground?: { process_group_id: number; input_waiting: boolean } | null
    }>({ op: 'inspect_terminal', process_id: this.processId })
    const foreground = result.foreground
    return foreground == null
      ? undefined
      : {
        processGroupId: foreground.process_group_id,
        inputWaiting: foreground.input_waiting,
      }
  }

  async signalForeground(signal: NativeExecutionSignal): Promise<number> {
    await this.started.promise
    const result = await this.client.request<{ process_group_id: number }>({
      op: 'signal_foreground',
      process_id: this.processId,
      signal,
    })
    return result.process_group_id
  }

  onOutput(data: Buffer): void {
    if (!this.outputClosed) this.output.write(data)
  }

  onOutputClosed(): void {
    if (this.outputClosed) return
    this.outputClosed = true
    this.output.end()
    this.outputSettled.resolve()
  }

  waitForOutput(): Promise<void> {
    return this.outputSettled.promise
  }

  onExit(outcome: NativeProcessOutcome): void {
    if (this.exited) return
    this.exited = true
    this.settled.resolve(outcome)
    this.client.releaseTerminalWhenQuiescent(this)
  }

  onTransportFailure(error: Error): void {
    const outcomeSettled = this.exited
    this.exited = true
    this.started.reject(error)
    if (!this.outputClosed) {
      this.outputClosed = true
      this.outputSettled.resolve()
      this.output.destroy(error)
    }
    if (!outcomeSettled) this.settled.reject(error)
  }
}

/** Sidecar-backed provider. The subprocess provider decides grace/escalation. */
export class NativeExecutionClient extends NativeExecutionRuntime {
  static Config: z<Config> = z.object({
    binaryPath: z.string().default('dsh-execution-core'),
  })
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Deferred<unknown>>()
  private readonly handles = new Map<string, SidecarHandle>()
  private readonly terminalHandles = new Map<string, SidecarTerminalHandle>()
  private nextId = 1
  private failed: Error | undefined
  private ready: Promise<NativeExecutionHello> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const { binaryPath } = config as ResolvedConfig
    this.child = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: sidecarEnvironment(),
    })
    this.child.stderr.pipe(process.stderr)
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    })
    lines.on('line', (line) => {
      this.acceptLine(line)
    })
    this.child.once('error', (error) => {
      this.failAll(error)
    })
    // A sidecar may close its read end between the failed-state check and a
    // request write. Writable streams emit that EPIPE independently of the
    // write callback, so route it through the same transport-failure boundary.
    this.child.stdin.on('error', (error) => {
      this.failAll(error)
    })
    this.child.once('exit', (code, signal) => {
      this.failAll(
        new Error(
          `native execution sidecar exited (${String(code ?? signal ?? 'unknown')})`,
        ),
      )
    })
    ctx.effect(
      () => async () => {
        const handles = [...this.handles.values()]
        const terminals = [...this.terminalHandles.values()]
        await Promise.allSettled([
          ...handles.map(handle => handle.signalTree('SIGKILL')),
          ...terminals.map(handle => handle.signalTree('SIGKILL')),
        ])
        await Promise.allSettled(
          [...handles, ...terminals].map(async (handle) => {
            while (await handle.treeAlive().catch(() => false)) {
              await new Promise(resolve => setTimeout(resolve, 15))
            }
          }),
        )
        this.child.stdin.end()
        if (this.child.exitCode === null && this.child.signalCode === null)
          this.child.kill('SIGKILL')
      },
      'native execution sidecar teardown',
    )
  }

  override hello(): Promise<NativeExecutionHello> {
    return this.ensureReady()
  }
  /**
   * Return the validated sidecar handshake, starting it once when necessary.
   * @returns the cached or pending sidecar handshake.
   */
  async ensureReady(): Promise<NativeExecutionHello> {
    this.ready ??= this.request<NativeExecutionHello>({ op: 'hello' }).then(
      (hello) => {
        if (hello.protocol !== 1)
          throw new Error(
            `native execution protocol mismatch: expected 1, got ${hello.protocol}`,
          )
        return hello
      },
    )
    return this.ready
  }
  override async resolveExecutable(
    command: string,
    env: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
  ): Promise<string> {
    await this.ensureReady()
    const result = await this.request<{ path: string }>(
      { op: 'resolve_executable', command, env: { ...env } },
      signal,
    )
    return result.path
  }
  override spawn(spec: NativeProcessSpawnSpec): NativeProcessHandle {
    if (this.failed !== undefined) throw this.failed
    const id = randomUUID()
    const handle = new SidecarHandle(id, this, spec)
    this.handles.set(id, handle)
    return handle
  }

  override async spawnTerminal(
    spec: NativeTerminalSpawnSpec,
  ): Promise<NativeTerminalHandle> {
    if (this.failed !== undefined) throw this.failed
    await this.ensureReady()
    const signal = spec.signal
    signal?.throwIfAborted()
    const processId = randomUUID()
    const handle = new SidecarTerminalHandle(processId, this)
    // Publish local ownership before the remote spawn can emit output/exit.
    // PassThrough buffers pre-return output until the caller attaches, and an
    // early exit settles the already-owned handle instead of disappearing.
    this.terminalHandles.set(processId, handle)
    let aborted = false
    const onAbort = (): void => {
      aborted = true
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) aborted = true
    try {
      const result = await this.request<{ process_id: string; pid: number }>({
        op: 'spawn_terminal',
        process_id: processId,
        argv: [...spec.argv],
        cwd: spec.cwd,
        env: { ...(spec.env ?? {}) },
        rows: spec.rows,
        cols: spec.cols,
      })
      handle.onStarted(result.pid)
      if (aborted) {
        await handle.signalTree('SIGKILL').catch(() => undefined)
        throw signal === undefined
          ? new Error('native terminal allocation aborted')
          : abortError(signal)
      }
      return handle
    } catch (error: unknown) {
      const failure = asError(error)
      if (handle.pid === -1) {
        handle.onStartFailure(failure)
        this.terminalHandles.delete(processId)
      }
      throw failure
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Send one request frame and await its matching response.
   * @param payload - protocol operation fields excluding the generated request id.
   * @param signal - optional request-local cancellation signal.
   * @returns the decoded response result.
   */
  async request<T = Record<string, never>>(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.failed !== undefined) throw this.failed
    signal?.throwIfAborted()
    const id = this.nextId++
    const state = Promise.withResolvers<unknown>()
    // failAll() may reject synchronously from stdin's error event before this
    // request reaches the return below. Keep that internal timing from becoming
    // an unhandled rejection; callers still receive the request rejection.
    void state.promise.catch(() => {})
    this.pending.set(id, state)
    const frame = JSON.stringify({ id, ...payload }) + '\n'
    try {
      await new Promise<void>((resolve, reject) => {
        this.child.stdin.write(frame, (error) => {
          if (error === null || error === undefined) resolve()
          else reject(asError(error))
        })
      })
    } catch (error: unknown) {
      this.pending.delete(id)
      throw error
    }
    if (signal === undefined) return state.promise as Promise<T>
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup()
        reject(abortError(signal))
      }
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void state.promise.then(
        (value) => {
          cleanup()
          resolve(value as T)
        },
        (error: unknown) => {
          cleanup()
          reject(asError(error))
        },
      )
      if (signal.aborted) onAbort()
    })
  }

  private acceptLine(line: string): void {
    let frame: ProtocolFrame
    try {
      frame = JSON.parse(line) as ProtocolFrame
    } catch {
      this.failAll(new Error('native execution sidecar emitted invalid JSON'))
      return
    }
    if ('id' in frame) {
      const state = this.pending.get(frame.id)
      if (state === undefined) return
      this.pending.delete(frame.id)
      if (frame.ok) state.resolve(frame.result)
      else
        state.reject(
          new Error(frame.error ?? 'native execution request failed'),
        )
      return
    }
    if (frame.event === 'terminal_output') {
      this.terminalHandles
        .get(frame.process_id)
        ?.onOutput(Buffer.from(frame.data_b64, 'base64'))
      return
    }
    if (frame.event === 'terminal_closed') {
      this.terminalHandles.get(frame.process_id)?.onOutputClosed()
      return
    }
    if (frame.event === 'exit') {
      const terminal = this.terminalHandles.get(frame.process_id)
      if (terminal !== undefined) {
        terminal.onExit({ exitCode: frame.exit_code, signal: frame.signal })
        return
      }
    }
    const handle = this.handles.get(frame.process_id)
    if (handle === undefined) return
    if (frame.event === 'stdout' || frame.event === 'stderr')
      handle.onOutput(frame.event, Buffer.from(frame.data_b64, 'base64'))
    else if (frame.event === 'stream_closed')
      handle.onStreamClosed(frame.stream)
    else
      handle.onExit({ exitCode: frame.exit_code, signal: frame.signal })
  }

  /**
   * Remove a handle that failed before a process became live.
   * @param processId - client-generated process identifier.
   */
  release(processId: string): void {
    this.handles.delete(processId)
  }
  /**
   * Remove an exited handle after its process tree and output streams quiesce.
   * @param handle - exited sidecar process handle.
   */
  releaseWhenQuiescent(handle: SidecarHandle): void {
    void (async () => {
      try {
        while (await handle.treeAlive())
          await new Promise(resolve => setTimeout(resolve, 15))
        await handle.waitForStreams()
      } catch {
        /* sidecar failure owns the remaining cleanup */
      }
      this.handles.delete(handle.processId)
    })()
  }

  /** Release one terminal only after the sidecar proves its complete owned tree quiescent. */
  releaseTerminalWhenQuiescent(handle: SidecarTerminalHandle): void {
    void (async () => {
      while (this.failed === undefined) {
        const alive = await handle.treeAlive().catch(() => undefined)
        if (alive === false) {
          await handle.waitForOutput()
          this.terminalHandles.delete(handle.processId)
          return
        }
        // An inspection failure is unknown, not dead. Keep ownership and retry;
        // failAll() is the only path that may abandon the registry on transport loss.
        await new Promise(resolve => setTimeout(resolve, 15))
      }
    })()
  }

  private failAll(error: unknown): void {
    if (this.failed !== undefined) return
    this.failed = asError(error)
    for (const state of this.pending.values()) state.reject(this.failed)
    this.pending.clear()
    for (const handle of this.handles.values())
      handle.onTransportFailure(this.failed)
    this.handles.clear()
    for (const handle of this.terminalHandles.values())
      handle.onTransportFailure(this.failed)
    this.terminalHandles.clear()
  }
}

export default NativeExecutionClient
