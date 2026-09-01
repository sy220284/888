import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { SessionFormatMigrationRegistry } from "../src/index.ts";

function snapshot(version: number): {
  meta: SessionHeader;
  events: SessionEvent[];
} {
  return {
    meta: {
      id: "migration-fixture" as SessionHeader["id"],
      version,
      createdAt: 1,
      delegationDepth: 0,
    },
    events: [],
  };
}

describe("SessionFormatMigrationRegistry", () => {
  it("runs an exact ordered migration chain without mutating the source", () => {
    const registry = new SessionFormatMigrationRegistry();
    registry.register({
      fromVersion: 0,
      migrate: (value) => ({ ...value, meta: { ...value.meta, version: 1 } }),
    });
    registry.register({
      fromVersion: 1,
      migrate: (value) => ({ ...value, meta: { ...value.meta, version: 2 } }),
    });
    const source = snapshot(0);
    const result = registry.upgrade(source, 2);
    expect(result.meta.version).toBe(2);
    expect(source.meta.version).toBe(0);
    expect(registry.canUpgrade(0, 2)).toBe(true);
  });

  it("fails closed on gaps, backward requests, duplicate steps, identity changes, and wrong target versions", () => {
    const registry = new SessionFormatMigrationRegistry();
    registry.register({
      fromVersion: 0,
      migrate: (value) => ({ ...value, meta: { ...value.meta, version: 1 } }),
    });
    expect(() =>
      registry.register({ fromVersion: 0, migrate: (value) => value }),
    ).toThrow(/already registered/);
    expect(registry.canUpgrade(0, 2)).toBe(false);
    expect(() => registry.upgrade(snapshot(0), 2)).toThrow(
      /no registered migration/,
    );
    expect(() => registry.upgrade(snapshot(2), 1)).toThrow(/backward/);

    const identity = new SessionFormatMigrationRegistry();
    identity.register({
      fromVersion: 0,
      migrate: (value) => ({
        ...value,
        meta: { ...value.meta, id: "other" as SessionHeader["id"], version: 1 },
      }),
    });
    expect(() => identity.upgrade(snapshot(0), 1)).toThrow(
      /changed session identity/,
    );

    const version = new SessionFormatMigrationRegistry();
    version.register({
      fromVersion: 0,
      migrate: (value) => ({ ...value, meta: { ...value.meta, version: 2 } }),
    });
    expect(() => version.upgrade(snapshot(0), 1)).toThrow(/returned v2/);
  });
});
