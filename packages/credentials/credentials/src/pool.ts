import type { CredentialProvider, ResolvedCredential } from "./index.ts";
import type { CredentialRef } from "./types.ts";

/** One credential selected for a single provider operation. */
export interface CredentialLease extends ResolvedCredential {
  readonly ref: CredentialRef;
}

/** Runtime-only health policy for deterministic credential rotation. */
export interface CredentialPoolOptions {
  readonly maxFailures?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

interface CredentialHealth {
  failures: number;
  cooldownUntil: number;
}

const DEFAULT_MAX_FAILURES = 1;
const DEFAULT_COOLDOWN_MS = 30_000;

/**
 * Per-operation credential resolver with deterministic rotation and bounded
 * cooldown. Secrets are never persisted or cached: every acquisition resolves
 * the selected reference through the authoritative CredentialProvider.
 */
export class CredentialPool {
  private cursor = 0;
  private readonly health = new Map<CredentialRef, CredentialHealth>();
  private readonly maxFailures: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    private readonly provider: CredentialProvider,
    private readonly refs: readonly CredentialRef[],
    options: CredentialPoolOptions = {},
  ) {
    if (refs.length === 0)
      throw new TypeError("credential pool requires at least one reference");
    if (new Set(refs).size !== refs.length)
      throw new TypeError("credential pool references must be unique");
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxFailures) || this.maxFailures < 1)
      throw new TypeError(
        "credential pool maxFailures must be a positive safe integer",
      );
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 0)
      throw new TypeError(
        "credential pool cooldownMs must be a non-negative safe integer",
      );
  }

  /** Resolve the next healthy configured reference; returns undefined when none are currently usable. */
  async acquire(): Promise<CredentialLease | undefined> {
    const now = this.now();
    for (let offset = 0; offset < this.refs.length; offset++) {
      const index = (this.cursor + offset) % this.refs.length;
      const ref = this.refs[index]!;
      const state = this.health.get(ref);
      if (state !== undefined && state.cooldownUntil > now) continue;
      const resolved = await this.provider.resolve(ref);
      if (resolved === undefined) continue;
      this.cursor = (index + 1) % this.refs.length;
      return { ref, ...resolved };
    }
    return undefined;
  }

  /** Mark a successful operation so the reference immediately regains full health. */
  reportSuccess(ref: CredentialRef): void {
    this.requireMember(ref);
    this.health.delete(ref);
  }

  /** Mark a credential-scoped failure; repeated failures put the reference into cooldown. */
  reportFailure(ref: CredentialRef): void {
    this.requireMember(ref);
    const current = this.health.get(ref) ?? { failures: 0, cooldownUntil: 0 };
    const failures = current.failures + 1;
    this.health.set(
      ref,
      failures >= this.maxFailures
        ? { failures: 0, cooldownUntil: this.now() + this.cooldownMs }
        : { failures, cooldownUntil: 0 },
    );
  }

  /** Safe health snapshot containing references and timers only, never secret values. */
  status(): readonly {
    ref: CredentialRef;
    coolingDown: boolean;
    cooldownUntil: number;
  }[] {
    const now = this.now();
    return this.refs.map((ref) => {
      const state = this.health.get(ref);
      return {
        ref,
        coolingDown: (state?.cooldownUntil ?? 0) > now,
        cooldownUntil: state?.cooldownUntil ?? 0,
      };
    });
  }

  private requireMember(ref: CredentialRef): void {
    if (!this.refs.includes(ref))
      throw new Error(
        `credential reference ${JSON.stringify(ref)} does not belong to this pool`,
      );
  }
}
