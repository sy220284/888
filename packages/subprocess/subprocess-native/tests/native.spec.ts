import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { NativeExecutionRuntime } from "@deepseek-ai/dsh-native-execution";
import type {
  NativeExecutionHello,
  NativeExecutionSignal,
  NativeProcessHandle,
  NativeProcessOutcome,
  NativeProcessSpawnSpec,
  NativeTerminalHandle,
  NativeTerminalSpawnSpec,
} from "@deepseek-ai/dsh-native-execution";
import NativeSubprocessRuntime from "@deepseek-ai/dsh-subprocess-native";
import type { SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";

class FakeHandle implements NativeProcessHandle {
  pid = 4242;
  stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly doneState = Promise.withResolvers<NativeProcessOutcome>();
  done = this.doneState.promise;
  signals: NativeExecutionSignal[] = [];
  alive = true;
  async signalTree(signal: NativeExecutionSignal): Promise<void> {
    this.signals.push(signal);
    if (signal === "SIGKILL") this.alive = false;
  }
  async treeAlive(): Promise<boolean> {
    return this.alive;
  }
}

class FakeTerminalHandle implements NativeTerminalHandle {
  pid = 5252;
  output = new PassThrough();
  readonly doneState = Promise.withResolvers<NativeProcessOutcome>();
  done = this.doneState.promise;
  alive = true;
  writes: string[] = [];
  writeGate: Promise<void> | undefined;
  foregroundSignals: NativeExecutionSignal[] = [];
  treeSignals: NativeExecutionSignal[] = [];
  killStopsTree = true;
  foreground = { processGroupId: 5253, inputWaiting: true };
  async write(data: string): Promise<void> {
    this.writes.push(data);
    await this.writeGate;
  }
  async inspectForeground(): Promise<{
    processGroupId: number;
    inputWaiting: boolean;
  }> {
    return this.foreground;
  }
  async signalForeground(signal: NativeExecutionSignal): Promise<number> {
    this.foregroundSignals.push(signal);
    return this.foreground.processGroupId;
  }
  async signalTree(signal: NativeExecutionSignal): Promise<void> {
    this.treeSignals.push(signal);
    if (signal === "SIGKILL" && this.killStopsTree) this.alive = false;
  }
  async treeAlive(): Promise<boolean> {
    return this.alive;
  }
}

class FakeNativeExecution extends NativeExecutionRuntime {
  handle = new FakeHandle();
  terminalHandle = new FakeTerminalHandle();
  terminalSupported = false;
  lastSpec: NativeProcessSpawnSpec | undefined;
  lastTerminalSpec: NativeTerminalSpawnSpec | undefined;
  async hello(): Promise<NativeExecutionHello> {
    return {
      protocol: 1,
      platform: "test",
      capabilities: {
        processTree: true,
        terminal: this.terminalSupported,
        filesystem: false,
        networkPolicy: false,
      },
    };
  }
  async resolveExecutable(command: string): Promise<string> {
    return `/resolved/${command}`;
  }
  spawn(spec: NativeProcessSpawnSpec): NativeProcessHandle {
    this.lastSpec = spec;
    return this.handle;
  }
  async spawnTerminal(
    spec: NativeTerminalSpawnSpec,
  ): Promise<NativeTerminalHandle> {
    this.lastTerminalSpec = spec;
    return this.terminalHandle;
  }
}

function spec(
  overrides: Partial<SubprocessSpawnSpec> = {},
): SubprocessSpawnSpec {
  return {
    argv: ["/bin/tool", "--flag"],
    cwd: "/workspace",
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 4, spill: { maxBytes: 128 } },
      stderr: { maxBytes: 8 },
    },
    graceMs: 5,
    ...overrides,
  };
}

async function fixture(): Promise<{
  ctx: Context;
  native: FakeNativeExecution;
  dispose(): Promise<void>;
}> {
  const ctx = new Context();
  const nativeFiber = await ctx.plugin(FakeNativeExecution);
  const subprocessFiber = await ctx.plugin(NativeSubprocessRuntime);
  return {
    ctx,
    native: ctx.nativeExecution as FakeNativeExecution,
    dispose: async () => {
      await subprocessFiber.dispose();
      await nativeFiber.dispose();
    },
  };
}

describe("NativeSubprocessRuntime", () => {
  it.skipIf(process.platform === "win32")(
    "projects collected output with the same bounded-tail/spill semantics",
    async () => {
      const f = await fixture();
      try {
        const handle = f.ctx.subprocess.spawn(spec());
        f.native.handle.stdout.write(Buffer.from("0123"));
        f.native.handle.stdout.write(Buffer.from("4567"));
        f.native.handle.stdout.end();
        f.native.handle.stderr.end();
        f.native.handle.alive = false;
        f.native.handle.doneState.resolve({ exitCode: 0, signal: null });
        await expect(handle.done).resolves.toEqual({
          exitCode: 0,
          signal: null,
        });
        const output = handle.collected.stdout!.readFrom(0);
        expect(output.text).toBe("4567");
        expect(output.lossy).toBe(true);
        expect(output.spillPath).toBeDefined();
        expect(readFileSync(output.spillPath!, "utf8")).toBe("01234567");
      } finally {
        await f.dispose();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "scrubs ambient credentials while preserving deliberate explicit values and tombstones",
    async () => {
      process.env.NATIVE_AMBIENT_TOKEN = "ambient-secret";
      process.env.NATIVE_VISIBLE = "visible";
      const f = await fixture();
      try {
        f.ctx.subprocess.spawn(
          spec({
            env: {
              NATIVE_AMBIENT_TOKEN: "explicit",
              NATIVE_VISIBLE: undefined,
              DSH_EXPLICIT: "yes",
            },
          }),
        );
        expect(f.native.lastSpec!.env!.NATIVE_AMBIENT_TOKEN).toBe("explicit");
        expect(f.native.lastSpec!.env!.NATIVE_VISIBLE).toBeUndefined();
        expect(f.native.lastSpec!.env!.DSH_EXPLICIT).toBe("yes");
      } finally {
        delete process.env.NATIVE_AMBIENT_TOKEN;
        delete process.env.NATIVE_VISIBLE;
        f.native.handle.alive = false;
        f.native.handle.doneState.resolve({ exitCode: 0, signal: null });
        f.native.handle.stdout.end();
        f.native.handle.stderr.end();
        await f.dispose();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "escalates TERM to KILL against the whole native process tree",
    async () => {
      const f = await fixture();
      try {
        const handle = f.ctx.subprocess.spawn(spec({ graceMs: 1 }));
        handle.terminate();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(f.native.handle.signals).toEqual(["SIGTERM", "SIGKILL"]);
        f.native.handle.doneState.resolve({
          exitCode: null,
          signal: "SIGKILL",
        });
        f.native.handle.stdout.end();
        f.native.handle.stderr.end();
        await expect(handle.waitForExit()).resolves.toBe(true);
      } finally {
        await f.dispose();
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "projects the native terminal primitive through the stable subprocess contract",
    async () => {
      const f = await fixture();
      f.native.terminalSupported = true;
      try {
        const handle = await f.ctx.subprocess.spawnTerminal({
          argv: ["/bin/bash"],
          cwd: "/workspace",
          rows: 24,
          cols: 80,
          graceMs: 5,
        });
        expect(handle.pid).toBe(5252);
        expect(f.native.lastTerminalSpec).toMatchObject({
          argv: ["/bin/bash"],
          cwd: "/workspace",
          rows: 24,
          cols: 80,
        });
        await handle.write("echo ok\n");
        expect(f.native.terminalHandle.writes).toEqual(["echo ok\n"]);
        await expect(handle.inspectForeground()).resolves.toEqual({
          processGroupId: 5253,
          inputWaiting: true,
        });
        await expect(handle.signalForeground("SIGINT")).resolves.toBe(5253);
        expect(f.native.terminalHandle.foregroundSignals).toEqual(["SIGINT"]);
        f.native.terminalHandle.alive = false;
        f.native.terminalHandle.doneState.resolve({
          exitCode: 0,
          signal: null,
        });
        f.native.terminalHandle.output.end();
        await handle.terminate();
      } finally {
        f.native.terminalHandle.alive = false;
        await f.dispose();
      }
    },
  );



  it.skipIf(process.platform !== "linux")(
    "waits for in-flight terminal operations before cleanup and rejects new ones",
    async () => {
      const f = await fixture();
      f.native.terminalSupported = true;
      try {
        const handle = await f.ctx.subprocess.spawnTerminal({
          argv: ["/bin/bash"],
          cwd: "/workspace",
          rows: 24,
          cols: 80,
          graceMs: 5,
        });
        const gate = Promise.withResolvers<void>();
        f.native.terminalHandle.writeGate = gate.promise;
        const writing = handle.write("pending\n");
        const terminating = handle.terminate();
        await new Promise((resolve) => setTimeout(resolve, 2));
        expect(f.native.terminalHandle.treeSignals).toEqual([]);
        await expect(handle.write("late\n")).rejects.toThrow("terminal is closing");
        gate.resolve();
        await writing;
        f.native.terminalHandle.alive = false;
        f.native.terminalHandle.doneState.resolve({ exitCode: 0, signal: null });
        await terminating;
        expect(f.native.terminalHandle.treeSignals).toContain("SIGTERM");
      } finally {
        f.native.terminalHandle.alive = false;
        await f.dispose();
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "allows terminal cleanup to be retried after a failed termination",
    async () => {
      const f = await fixture();
      f.native.terminalSupported = true;
      try {
        const handle = await f.ctx.subprocess.spawnTerminal({
          argv: ["/bin/bash"],
          cwd: "/workspace",
          rows: 24,
          cols: 80,
          graceMs: 1,
        });
        f.native.terminalHandle.killStopsTree = false;
        await expect(handle.terminate()).rejects.toThrow("terminal cleanup failed");
        const attempts = f.native.terminalHandle.treeSignals.length;
        f.native.terminalHandle.alive = false;
        f.native.terminalHandle.doneState.resolve({ exitCode: 0, signal: null });
        await expect(handle.terminate()).resolves.toBeUndefined();
        expect(f.native.terminalHandle.treeSignals.length).toBeGreaterThan(attempts);
      } finally {
        f.native.terminalHandle.alive = false;
        await f.dispose();
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps terminal ownership after the top-level shell exits until cleanup proves quiescence",
    async () => {
      const f = await fixture();
      f.native.terminalSupported = true;
      try {
        await f.ctx.subprocess.spawnTerminal({
          argv: ["/bin/bash"],
          cwd: "/workspace",
          rows: 24,
          cols: 80,
          graceMs: 5,
        });
        f.native.terminalHandle.doneState.resolve({ exitCode: 0, signal: null });
        await new Promise((resolve) => setTimeout(resolve, 2));
        expect(f.native.terminalHandle.treeSignals).toContain("SIGTERM");
        f.native.terminalHandle.alive = false;
        await new Promise((resolve) => setTimeout(resolve, 8));
      } finally {
        f.native.terminalHandle.alive = false;
        await f.dispose();
      }
    },
  );

  it("does not claim PTY support before the native primitive exists", async () => {
    const f = await fixture();
    try {
      await expect(
        f.ctx.subprocess.spawnTerminal({
          argv: ["/bin/bash"],
          cwd: "/workspace",
          rows: 24,
          cols: 80,
          graceMs: 10,
        }),
      ).rejects.toThrow("terminal primitive is unavailable");
    } finally {
      await f.dispose();
    }
  });

  it.skipIf(process.platform === "win32")(
    "keeps the native handle managed after direct process exit until the tree is actually gone",
    async () => {
      const f = await fixture();
      try {
        const handle = f.ctx.subprocess.spawn(spec());
        f.native.handle.stdout.end();
        f.native.handle.stderr.end();
        f.native.handle.doneState.resolve({ exitCode: 0, signal: null });
        await handle.done;
        expect(f.native.handle.alive).toBe(true);
        const disposing = f.dispose();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(f.native.handle.signals).toContain("SIGTERM");
        f.native.handle.alive = false;
        await disposing;
      } finally {
        f.native.handle.alive = false;
      }
    },
  );
});
