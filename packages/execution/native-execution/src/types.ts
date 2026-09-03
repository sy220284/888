import type { Readable, Writable } from "node:stream";

/** Process-tree signals supported by the native execution protocol. */
export type NativeExecutionSignal =
  "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGTSTP" | "SIGHUP";
/** Native process standard-input source. */
export type NativeInputMode =
  "ignore" | "pipe" | { readonly data: string | Uint8Array };
/** Native process output routing mode. */
export type NativeOutputMode = "pipe" | "ignore";

/** Complete native process spawn request. */
export interface NativeProcessSpawnSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin: NativeInputMode;
  readonly stdout: NativeOutputMode;
  readonly stderr: NativeOutputMode;
}

/** Native process completion status. */
export interface NativeProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Live native process control and output surface. */
export interface NativeProcessHandle {
  readonly pid: number;
  readonly stdin: Writable | undefined;
  readonly stdout: Readable | undefined;
  readonly stderr: Readable | undefined;
  readonly done: Promise<NativeProcessOutcome>;
  signalTree(signal: NativeExecutionSignal): Promise<void>;
  treeAlive(): Promise<boolean>;
}

/** Native terminal spawn request owned by the execution sidecar. */
export interface NativeTerminalSpawnSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly rows: number;
  readonly cols: number;
  readonly signal?: AbortSignal;
}

/** Current native terminal foreground process-group facts. */
export interface NativeTerminalForeground {
  readonly processGroupId: number;
  readonly inputWaiting: boolean;
}

/** Live native terminal handle. */
export interface NativeTerminalHandle {
  readonly pid: number;
  readonly output: Readable;
  readonly done: Promise<NativeProcessOutcome>;
  write(data: string): Promise<void>;
  inspectForeground(): Promise<NativeTerminalForeground | undefined>;
  signalForeground(signal: NativeExecutionSignal): Promise<number>;
  signalTree(signal: NativeExecutionSignal): Promise<void>;
  treeAlive(): Promise<boolean>;
}

/** Native sidecar capabilities negotiated at startup. */
export interface NativeExecutionCapabilities {
  readonly processTree: boolean;
  readonly terminal: boolean;
  readonly filesystem: boolean;
  readonly networkPolicy: boolean;
}

/** Validated native sidecar handshake. */
export interface NativeExecutionHello {
  readonly protocol: number;
  readonly platform: string;
  readonly capabilities: NativeExecutionCapabilities;
}
