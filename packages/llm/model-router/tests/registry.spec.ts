import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import ModelRouter from "../src/index.ts";

// Registry behavior is independent of recovery wiring; exercise the methods on
// a service-shaped instance without mounting unrelated LLM dependencies.
function router(): ModelRouter {
  const value = Object.create(ModelRouter.prototype) as ModelRouter & {
    catalog: Map<string, unknown>;
  };
  Reflect.set(value, "ctx", new Context());
  Reflect.set(value, "catalog", new Map());
  return value;
}

describe("ModelRouter model registry", () => {
  it("normalizes, lists, replaces, and disposes model descriptors", () => {
    const models = router();
    const dispose = models.registerModel({
      id: " reasoning ",
      provider: " provider ",
      model: " model ",
      contextWindow: 128_000,
      outputLimit: 8_192,
      capabilities: ["tools", "vision", "tools", ""],
    });
    expect(models.getModel("reasoning")).toEqual({
      id: "reasoning",
      provider: "provider",
      model: "model",
      contextWindow: 128_000,
      outputLimit: 8_192,
      capabilities: ["tools", "vision"],
    });
    const detached = models.getModel("reasoning")!;
    (detached as { id: string }).id = "changed";
    expect(models.getModel("reasoning")?.id).toBe("reasoning");
    dispose();
    expect(models.listModels()).toEqual([]);
  });

  it("rejects malformed model metadata", () => {
    const models = router();
    expect(() =>
      models.registerModel({ id: "", provider: "p", model: "m" }),
    ).toThrow(/id/);
    expect(() =>
      models.registerModel({ id: "m", provider: "", model: "m" }),
    ).toThrow(/provider/);
    expect(() =>
      models.registerModel({
        id: "m",
        provider: "p",
        model: "m",
        contextWindow: 0,
      }),
    ).toThrow(/contextWindow/);
  });
});
