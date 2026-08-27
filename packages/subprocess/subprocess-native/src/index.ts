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
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { NativeProcessHandle } from '@deepseek-ai/dsh-native-execution'
import type {} from '@deepseek-ai/dsh-native-execution'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { NativeOutputCollector } from './output.ts'

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

function waitMs(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }

function mergedChildEnv(explicit: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const env: Record<string, string> = { ...scrubbedParentEnv() }
  for (const [key, value] of Object.entries(explicit ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

async function waitForStream(stream: Readable | undefined, graceMs: number): Promise<boolean> {
  if (stream === undefined || stream.readableEnded || stream.destroyed) return true
  const result = await Promise.race([
    new Promise<void>(resolve => {
      const done = (): void => { cleanup(); resolve() }
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
  if (result === false && !stream.destroyed) stream.destroy()
  return result !== false
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

  constructor(private readonly native: NativeProcessHandle, private readonly spec: SubprocessSpawnSpec) {
    this.stdin = spec.stdio.stdin === 'pipe' ? native.stdin : undefined
    this.stdout = spec.stdio.stdout === 'pipe' ? native.stdout : undefined
    this.stderr = spec.stdio.stderr === 'pipe' ? native.stderr : undefined
    if (spec.stdio.stdout === 'inherit') native.stdout?.pipe(process.stdout, { end: false })
    if (spec.stdio.stderr === 'inherit') native.stderr?.pipe(process.stderr, { end: false })
    this.stdoutCollector = isCollect(spec.stdio.stdout) ? new NativeOutputCollector(spec.stdio.stdout, 'stdout') : undefined
    this.stderrCollector = isCollect(spec.stdio.stderr) ? new NativeOutputCollector(spec.stdio.stderr, 'stderr') : undefined
    if (this.stdoutCollector !== undefined) native.stdout?.on('data', chunk => { this.stdoutCollector?.push(Buffer.from(chunk)) })
    if (this.stderrCollector !== undefined) native.stderr?.on('data', chunk => { this.stderrCollector?.push(Buffer.from(chunk)) })
    this.collected = {
      ...(this.stdoutCollector !== undefined ? { stdout: this.stdoutCollector } : {}),
      ...(this.stderrCollector !== undefined ? { stderr: this.stderrCollector } : {}),
    }
    this.done = this.settleDone()
    void this.done.catch(() => {})
    spec.signal?.addEventListener('abort', () => { this.terminate() }, { once: true })
    if (spec.signal?.aborted === true) this.terminate()
  }

  get pid(): number { return this.native.pid }

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
      if (!await this.native.treeAlive()) {
        this.quiescent = true
        return true
      }
      if (signal === undefined) await waitMs(15)
      else {
        const tick = AbortSignal.timeout(15)
        try { await new Promise<void>((resolve) => tick.addEventListener('abort', () => resolve(), { once: true })) } catch { /* timer only */ }
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

/**
 * Optional native subprocess provider. P2a intentionally refuses PTY
 * allocation until the native sidecar advertises and implements that primitive.
 */
export class NativeSubprocessRuntime extends SubprocessRuntime {
  static inject = ['nativeExecution']
  private readonly live = new Set<NativeSubprocessHandle>()
  private disposing = false

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposing = true
      const handles = [...this.live]
      for (const handle of handles) handle.terminate()
      await Promise.allSettled(handles.map(handle => handle.waitForExit()))
      this.live.clear()
    }, 'native subprocess teardown')
  }

  override resolveExecutable(command: string, env: Readonly<Record<string, string>> = {}, signal?: AbortSignal): Promise<string> {
    return this.ctx.nativeExecution.resolveExecutable(command, { ...scrubbedParentEnv(), ...env }, signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('subprocess-native: service is disposing')
    if (process.platform === 'win32') throw new Error('subprocess-native: P2a native process trees are currently Unix-only')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`subprocess-native: graceMs must be positive, finite, and no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    if (spec.signal?.aborted === true) throw spec.signal.reason ?? new Error('subprocess-native: aborted before spawn')
    const native = this.ctx.nativeExecution.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      env: mergedChildEnv(spec.env),
      stdin: spec.stdio.stdin === 'ignore' || spec.stdio.stdin === 'pipe'
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
    void handle.done.then(release, release).catch(() => { /* disposal retains failed cleanup */ })
    return handle
  }

  override async spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const hello = await this.ctx.nativeExecution.hello()
    throw new Error(`subprocess-native: terminal primitive is unavailable (native capability terminal=${String(hello.capabilities.terminal)})`)
  }
}

export default NativeSubprocessRuntime
