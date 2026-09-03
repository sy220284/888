import { describe, expect, it } from "vitest";
import { CredentialPool, credentialRef } from "../src/index.ts";
import type {
  CredentialProvider,
  CredentialRef,
  ResolvedCredential,
} from "../src/index.ts";

function fakeCredentials(): CredentialProvider & {
  values: Map<CredentialRef, ResolvedCredential>;
} {
  const values = new Map<CredentialRef, ResolvedCredential>();
  return {
    values,
    resolve: (ref: CredentialRef) => Promise.resolve(values.get(ref)),
  } as unknown as CredentialProvider & {
    values: Map<CredentialRef, ResolvedCredential>;
  };
}

describe("CredentialPool", () => {
  it("resolves secrets per operation and rotates configured references", async () => {
    const provider = fakeCredentials();
    const a = credentialRef("KEY_A");
    const b = credentialRef("KEY_B");
    provider.values.set(a, { value: "a1", source: "test" });
    provider.values.set(b, { value: "b1", source: "test" });
    const pool = new CredentialPool(provider, [a, b]);
    await expect(pool.acquire()).resolves.toEqual({
      ref: a,
      value: "a1",
      source: "test",
    });
    provider.values.set(a, { value: "a2", source: "test" });
    await expect(pool.acquire()).resolves.toEqual({
      ref: b,
      value: "b1",
      source: "test",
    });
    await expect(pool.acquire()).resolves.toEqual({
      ref: a,
      value: "a2",
      source: "test",
    });
  });

  it("cools failed references without persisting secret values", async () => {
    let now = 100;
    const provider = fakeCredentials();
    const a = credentialRef("KEY_A");
    const b = credentialRef("KEY_B");
    provider.values.set(a, { value: "a", source: "test" });
    provider.values.set(b, { value: "b", source: "test" });
    const pool = new CredentialPool(provider, [a, b], {
      cooldownMs: 50,
      now: () => now,
    });
    pool.reportFailure(a);
    await expect(pool.acquire()).resolves.toMatchObject({ ref: b });
    expect(JSON.stringify(pool.status())).not.toContain('"value"');
    now = 151;
    pool.reportSuccess(a);
    await expect(pool.acquire()).resolves.toMatchObject({ ref: a });
  });
});
