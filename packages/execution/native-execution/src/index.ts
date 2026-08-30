/** Stable Harness seam for the native execution plane. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { NativeExecutionHello, NativeProcessHandle, NativeProcessSpawnSpec } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { nativeExecution: NativeExecutionRuntime }
}

/**
 * Low-level native execution capability. It deliberately knows nothing about
 * Session, Agent, tools, permissions, budgets, or shell semantics.
 */
export abstract class NativeExecutionRuntime extends Service {
  constructor(ctx: Context) { super(ctx, 'nativeExecution') }

  /**
   * Read native execution host metadata.
   * @returns Native execution handshake metadata.
   */
  abstract hello(): Promise<NativeExecutionHello>
  /**
   * Resolve one executable against an optional environment.
   * @param command Executable name or path.
   * @param env Environment used for path resolution.
   * @param signal Optional cancellation signal.
   * @returns Resolved executable path.
   */
  abstract resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>
  /**
   * Spawn one native process.
   * @param spec Process spawn specification.
   * @returns Live native process handle.
   */
  abstract spawn(spec: NativeProcessSpawnSpec): NativeProcessHandle
}

export default NativeExecutionRuntime
