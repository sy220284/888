import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import NativeExecutionClient from "../../../execution/native-client/src/index.ts";
import LocalSubprocessRuntime from "../../subprocess-local/src/index.ts";
import NativeSubprocessRuntime from "../src/index.ts";
import type { SubprocessRuntime, SubprocessTerminalHandle } from "@deepseek-ai/dsh-subprocess";


async function processLive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const state = stat.slice(close + 1).trimStart()[0];
    return state !== "Z" && state !== "X" && state !== "x";
  } catch {
    return false;
  }
}

async function collect(handle: SubprocessTerminalHandle): Promise<{ output: string; exitCode: number | null; signal: NodeJS.Signals | null }> {
  const output = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of handle.output) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  })();
  const outcome = await handle.done;
  return { output: await output, ...outcome };
}

async function withLocal<T>(run: (runtime: SubprocessRuntime) => Promise<T>): Promise<T> {
  const ctx = new Context();
  const fiber = await ctx.plugin(LocalSubprocessRuntime);
  try {
    return await run(ctx.subprocess);
  } finally {
    await fiber.dispose();
  }
}

async function withNative<T>(run: (runtime: SubprocessRuntime) => Promise<T>): Promise<T> {
  const ctx = new Context();
  const client = await ctx.plugin(NativeExecutionClient, {
    binaryPath: resolve("native/execution-core/target/debug/dsh-execution-core"),
  });
  const runtime = await ctx.plugin(NativeSubprocessRuntime);
  try {
    return await run(ctx.subprocess);
  } finally {
    await runtime.dispose();
    await client.dispose();
  }
}

const terminalSpec = {
  argv: ["/bin/sh", "-c", "printf DIFF; exit 3"],
  cwd: process.cwd(),
  rows: 24,
  cols: 80,
  graceMs: 100,
};

describe.skipIf(process.platform !== "linux")("native/local terminal differential e2e", () => {
  it("matches the existing local provider for immediate output and exit", async () => {
    const local = await withLocal(async (runtime) => collect(await runtime.spawnTerminal(terminalSpec)));
    const native = await withNative(async (runtime) => collect(await runtime.spawnTerminal(terminalSpec)));
    expect(native).toEqual(local);
    expect(native.output).toContain("DIFF");
    expect(native.exitCode).toBe(3);
  });

  it("kills an observed descendant even after that descendant creates a new session", async () => {
    let childPid = -1;
    await withNative(async (runtime) => {
      const handle = await runtime.spawnTerminal({
        argv: [
          "/bin/sh",
          "-c",
          "setsid /bin/sleep 30 & child=$!; printf 'CHILD:%s\\n' \"$child\"; sleep 0.12; exit 0",
        ],
        cwd: process.cwd(),
        rows: 24,
        cols: 80,
        graceMs: 200,
      });
      const result = await collect(handle);
      const match = /CHILD:(\d+)/.exec(result.output);
      expect(match).not.toBeNull();
      childPid = Number(match![1]);
      await handle.terminate();
    });
    expect(childPid).toBeGreaterThan(1);
    await expect(processLive(childPid)).resolves.toBe(false);
  });
});
