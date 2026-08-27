import type { Readable, Writable } from 'node:stream'

export type NativeExecutionSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'
export type NativeInputMode = 'ignore' | 'pipe' | { readonly data: string | Uint8Array }
export type NativeOutputMode = 'pipe' | 'ignore'

export interface NativeProcessSpawnSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdin: NativeInputMode
  readonly stdout: NativeOutputMode
  readonly stderr: NativeOutputMode
}

export interface NativeProcessOutcome {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

export interface NativeProcessHandle {
  readonly pid: number
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly done: Promise<NativeProcessOutcome>
  signalTree(signal: NativeExecutionSignal): Promise<void>
  treeAlive(): Promise<boolean>
}

export interface NativeExecutionCapabilities {
  readonly processTree: boolean
  readonly terminal: boolean
  readonly filesystem: boolean
  readonly networkPolicy: boolean
}

export interface NativeExecutionHello {
  readonly protocol: number
  readonly platform: string
  readonly capabilities: NativeExecutionCapabilities
}
