import { resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import NativeExecutionClient from "@deepseek-ai/dsh-native-client";

async function collect(readable: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe.skipIf(process.platform !== "linux")("NativeExecutionClient terminal e2e", () => {
  it("preserves output and exit from a terminal that finishes immediately after spawn", async () => {
    const ctx = new Context();
    const binaryPath = resolve("native/execution-core/target/debug/dsh-execution-core");
    const fiber = await ctx.plugin(NativeExecutionClient, { binaryPath });
    try {
      const handle = await ctx.nativeExecution.spawnTerminal({
        argv: ["/bin/sh", "-c", "printf EARLY; exit 7"],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        rows: 24,
        cols: 80,
      });
      const [outcome, output] = await Promise.all([handle.done, collect(handle.output)]);
      expect(output).toContain("EARLY");
      expect(outcome).toEqual({ exitCode: 7, signal: null });
    } finally {
      await fiber.dispose();
    }
  });
});
