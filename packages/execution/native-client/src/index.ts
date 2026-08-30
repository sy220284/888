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
} from '@deepseek-ai/dsh-native-execution'

export interface Config { binaryPath?: string }
interface ResolvedConfig { binaryPath: string }

interface Deferred<T> { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void }
interface ResponseFrame { id: number; ok: boolean; result?: unknown; error?: string }
type EventFrame =
  | { event: 'stdout'; process_id: string; data_b64: string }
  | { event: 'stderr'; process_id: string; data_b64: string }
  | { event: 'stream_closed'; process_id: string; stream: 'stdout' | 'stderr' }
  | { event: 'exit'; process_id: string; exit_code: number | null; signal: NodeJS.Signals | null }

type ProtocolFrame = ResponseFrame | EventFrame

function asError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)) }
function abortError(signal: AbortSignal): Error {
  return signal.reason === undefined ? new Error('native execution request aborted') : asError(signal.reason)
}

function sidecarEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key) || key.toUpperCase().startsWith('DSH_')) continue
    env[key] = value
  }
  return env
}

class DeferredStdin extends Writable {
  constructor(private readonly handle: SidecarHandle) { super({ decodeStrings: true }) }
  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    void this.handle.writeStdin(bytes).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }
  override _final(callback: (error?: Error | null) => void): void {
    void this.handle.closeStdin().then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }
}

class SidecarHandle implements NativeProcessHandle {
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly stdin: Writable | undefined
  readonly done: Promise<NativeProcessOutcome>
  private readonly started = Promise.withResolvers<number>()
  private readonly settled = Promise.withResolvers<NativeProcessOutcome>()
  private readonly streamsSettled = Promise.withResolvers<void>()
  private remotePid = -1
  private exited = false
  private stdoutClosed: boolean
  private stderrClosed: boolean

  constructor(
    readonly processId: string,
    private readonly client: NativeExecutionClient,
    private readonly spec: NativeProcessSpawnSpec,
  ) {
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

  get pid(): number { return this.remotePid }

  private async start(): Promise<void> {
    try {
      await this.client.ensureReady()
      const result = await this.client.request<{ process_id: string; pid: number }>({
        op: 'spawn', process_id: this.processId,
        argv: [...this.spec.argv], cwd: this.spec.cwd, env: { ...(this.spec.env ?? {}) },
        stdin_mode: this.spec.stdin === 'ignore' ? 'ignore' : this.spec.stdin === 'pipe' ? 'pipe' : 'data',
        ...(typeof this.spec.stdin === 'object'
          ? { stdin_data_b64: Buffer.from(this.spec.stdin.data).toString('base64') }
          : {}),
        stdout_mode: this.spec.stdout, stderr_mode: this.spec.stderr,
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
    await this.client.request({ op: 'write_stdin', process_id: this.processId, data_b64: Buffer.from(data).toString('base64') })
  }
  async closeStdin(): Promise<void> {
    try { await this.started.promise } catch { return }
    await this.client.request({ op: 'close_stdin', process_id: this.processId })
  }
  async signalTree(signal: NativeExecutionSignal): Promise<void> {
    try { await this.started.promise } catch { return }
    await this.client.request({ op: 'signal_tree', process_id: this.processId, signal })
  }
  async treeAlive(): Promise<boolean> {
    try { await this.started.promise } catch { return false }
    const result = await this.client.request<{ alive: boolean }>({ op: 'tree_alive', process_id: this.processId })
    return result.alive
  }

  onOutput(stream: 'stdout' | 'stderr', data: Buffer): void {
    ;(stream === 'stdout' ? this.stdout : this.stderr)?.write(data)
  }
  onStreamClosed(stream: 'stdout' | 'stderr'): void {
    if (stream === 'stdout') this.stdoutClosed = true
    else this.stderrClosed = true
    ;(stream === 'stdout' ? this.stdout : this.stderr)?.end()
    if (this.stdoutClosed && this.stderrClosed) this.streamsSettled.resolve()
  }
  waitForStreams(): Promise<void> { return this.streamsSettled.promise }
  onExit(outcome: NativeProcessOutcome): void {
    if (this.exited) return
    this.exited = true
    this.settled.resolve(outcome)
    this.client.releaseWhenQuiescent(this)
  }
  onTransportFailure(error: Error): void {
    if (this.exited) return
    this.exited = true
    this.started.reject(error)
    this.settled.reject(error)
    this.stdoutClosed = true
    this.stderrClosed = true
    this.streamsSettled.resolve()
    this.stdout?.destroy(error)
    this.stderr?.destroy(error)
  }
}

/** Sidecar-backed provider. The subprocess provider decides grace/escalation. */
export class NativeExecutionClient extends NativeExecutionRuntime {
  static Config: z<Config> = z.object({ binaryPath: z.string().default('dsh-execution-core') })
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Deferred<unknown>>()
  private readonly handles = new Map<string, SidecarHandle>()
  private nextId = 1
  private failed: Error | undefined
  private ready: Promise<NativeExecutionHello> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const { binaryPath } = config as ResolvedConfig
    this.child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: sidecarEnvironment() })
    this.child.stderr.pipe(process.stderr)
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => { this.acceptLine(line) })
    this.child.once('error', (error) => { this.failAll(error) })
    this.child.once('exit', (code, signal) => {
      this.failAll(new Error(`native execution sidecar exited (${String(code ?? signal ?? 'unknown')})`))
    })
    ctx.effect(() => async () => {
      const handles = [...this.handles.values()]
      await Promise.allSettled(handles.map(handle => handle.signalTree('SIGKILL')))
      await Promise.allSettled(handles.map(async (handle) => {
        while (await handle.treeAlive().catch(() => false)) {
          await new Promise(resolve => setTimeout(resolve, 15))
        }
      }))
      this.child.stdin.end()
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
    }, 'native execution sidecar teardown')
  }

  override hello(): Promise<NativeExecutionHello> { return this.ensureReady() }
  async ensureReady(): Promise<NativeExecutionHello> {
    this.ready ??= this.request<NativeExecutionHello>({ op: 'hello' }).then((hello) => {
      if (hello.protocol !== 1) throw new Error(`native execution protocol mismatch: expected 1, got ${hello.protocol}`)
      return hello
    })
    return this.ready
  }
  override async resolveExecutable(command: string, env: Readonly<Record<string, string>> = {}, signal?: AbortSignal): Promise<string> {
    await this.ensureReady()
    const result = await this.request<{ path: string }>({ op: 'resolve_executable', command, env: { ...env } }, signal)
    return result.path
  }
  override spawn(spec: NativeProcessSpawnSpec): NativeProcessHandle {
    if (this.failed !== undefined) throw this.failed
    const id = randomUUID()
    const handle = new SidecarHandle(id, this, spec)
    this.handles.set(id, handle)
    return handle
  }

  async request<T = Record<string, never>>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (this.failed !== undefined) throw this.failed
    signal?.throwIfAborted()
    const id = this.nextId++
    const state = Promise.withResolvers<unknown>()
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
      state.reject(error)
      throw error
    }
    if (signal === undefined) return state.promise as Promise<T>
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => { cleanup(); reject(abortError(signal)) }
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
      signal.addEventListener('abort', onAbort, { once: true })
      void state.promise.then(
        (value) => { cleanup(); resolve(value as T) },
        (error: unknown) => { cleanup(); reject(asError(error)) },
      )
      if (signal.aborted) onAbort()
    })
  }

  private acceptLine(line: string): void {
    let frame: ProtocolFrame
    try { frame = JSON.parse(line) as ProtocolFrame } catch { this.failAll(new Error('native execution sidecar emitted invalid JSON')); return }
    if ('id' in frame) {
      const state = this.pending.get(frame.id)
      if (state === undefined) return
      this.pending.delete(frame.id)
      if (frame.ok) state.resolve(frame.result)
      else state.reject(new Error(frame.error ?? 'native execution request failed'))
      return
    }
    const handle = this.handles.get(frame.process_id)
    if (handle === undefined) return
    if (frame.event === 'stdout' || frame.event === 'stderr') handle.onOutput(frame.event, Buffer.from(frame.data_b64, 'base64'))
    else if (frame.event === 'stream_closed') handle.onStreamClosed(frame.stream)
    else handle.onExit({ exitCode: frame.exit_code, signal: frame.signal })
  }

  release(processId: string): void { this.handles.delete(processId) }
  releaseWhenQuiescent(handle: SidecarHandle): void {
    void (async () => {
      try {
        while (await handle.treeAlive()) await new Promise(resolve => setTimeout(resolve, 15))
        await handle.waitForStreams()
      } catch { /* sidecar failure owns the remaining cleanup */ }
      this.handles.delete(handle.processId)
    })()
  }

  private failAll(error: unknown): void {
    if (this.failed !== undefined) return
    this.failed = asError(error)
    for (const state of this.pending.values()) state.reject(this.failed)
    this.pending.clear()
    for (const handle of this.handles.values()) handle.onTransportFailure(this.failed)
    this.handles.clear()
  }
}

export default NativeExecutionClient
