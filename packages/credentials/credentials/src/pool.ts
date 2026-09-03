import type { ResolvedCredential } from "./index.ts";
import type { CredentialRef } from "./types.ts";

/** Minimal resolver contract required by CredentialPool. */
export interface CredentialResolver {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
}

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
 * Per-operation credential resolver with deterministic rotation, concurrent
 * lease balancing, and bounded cooldown. Secrets are never persisted or
 * cached: every acquisition resolves the selected reference through the
 * authoritative resolver.
 */
export class CredentialPool {
  private cursor = 0;
  private readonly health = new Map<CredentialRef, CredentialHealth>();
  private readonly inFlight = new Map<CredentialRef, number>();
  private readonly maxFailures: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    private readonly provider: CredentialResolver,
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

  /**
   * Resolve the least-busy healthy reference, using the cursor only as the
   * deterministic tie-breaker. The reference is reserved before the async
   * resolve so concurrent callers cannot all observe the same cursor.
   */
  async acquire(): Promise<CredentialLease | undefined> {
    const attempted = new Set<CredentialRef>();
    while (attempted.size < this.refs.length) {
      const now = this.now();
      let selectedIndex = -1;
      let selectedLoad = Number.POSITIVE_INFINITY;
      for (let offset = 0; offset < this.refs.length; offset++) {
        const index = (this.cursor + offset) % this.refs.length;
        const ref = this.refs[index]!;
        if (attempted.has(ref)) continue;
        const state = this.health.get(ref);
        if (state !== undefined && state.cooldownUntil > now) continue;
        const load = this.inFlight.get(ref) ?? 0;
        if (load < selectedLoad) {
          selectedIndex = index;
          selectedLoad = load;
        }
      }
      if (selectedIndex < 0) return undefined;

      const ref = this.refs[selectedIndex]!;
      attempted.add(ref);
      this.cursor = (selectedIndex + 1) % this.refs.length;
      this.inFlight.set(ref, (this.inFlight.get(ref) ?? 0) + 1);
      try {
        const resolved = await this.provider.resolve(ref);
        if (resolved !== undefined) return { ref, ...resolved };
      } catch (error) {
        this.release(ref);
        throw error;
      }
      this.release(ref);
    }
    return undefined;
  }

  /** Release one completed lease without changing credential health. */
  release(ref: CredentialRef): void {
    this.requireMember(ref);
    const current = this.inFlight.get(ref) ?? 0;
    if (current <= 1) this.inFlight.delete(ref);
    else this.inFlight.set(ref, current - 1);
  }

  /** Mark a successful operation so the reference immediately regains full health. */
  reportSuccess(ref: CredentialRef): void {
    this.requireMember(ref);
    this.release(ref);
    this.health.delete(ref);
  }

  /** Mark a credential-scoped failure; repeated failures put the reference into cooldown. */
  reportFailure(ref: CredentialRef): void {
    this.requireMember(ref);
    this.release(ref);
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
    inFlight: number;
  }[] {
    const now = this.now();
    return this.refs.map((ref) => {
      const state = this.health.get(ref);
      return {
        ref,
        coolingDown: (state?.cooldownUntil ?? 0) > now,
        cooldownUntil: state?.cooldownUntil ?? 0,
        inFlight: this.inFlight.get(ref) ?? 0,
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
