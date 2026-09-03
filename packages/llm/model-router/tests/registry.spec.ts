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
  it("restores shadowed registrations across disposal order", () => {
    const models = router();
    const disposeA = models.registerModel({
      id: "stable", provider: "base", model: "base-model",
    });
    const disposeB = models.registerModel({
      id: "stable", provider: "plugin-b", model: "b-model",
    });
    const disposeC = models.registerModel({
      id: "stable", provider: "plugin-c", model: "c-model",
    });
    expect(models.getModel("stable")).toMatchObject({ provider: "plugin-c" });

    disposeB();
    expect(models.getModel("stable")).toMatchObject({ provider: "plugin-c" });
    disposeC();
    expect(models.getModel("stable")).toEqual({
      id: "stable", provider: "base", model: "base-model",
    });

    disposeB();
    disposeC();
    expect(models.getModel("stable")).toMatchObject({ provider: "base" });
    disposeA();
    expect(models.getModel("stable")).toBeUndefined();
  });

});
