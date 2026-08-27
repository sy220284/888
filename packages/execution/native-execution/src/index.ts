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

  abstract hello(): Promise<NativeExecutionHello>
  abstract resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>
  abstract spawn(spec: NativeProcessSpawnSpec): NativeProcessHandle
}

export default NativeExecutionRuntime
