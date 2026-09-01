import { SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";

/** Detached durable session payload accepted and returned by one format migration. */
export interface SessionFormatSnapshot {
  readonly meta: SessionHeader;
  readonly events: readonly SessionEvent[];
}

/** One deterministic format upgrade from `fromVersion` to exactly `fromVersion + 1`. */
export interface SessionFormatMigration {
  readonly fromVersion: number;
  migrate(snapshot: SessionFormatSnapshot): SessionFormatSnapshot;
}

function validateVersion(version: number, label: string): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function detached(snapshot: SessionFormatSnapshot): SessionFormatSnapshot {
  return {
    meta: structuredClone(snapshot.meta),
    events: structuredClone(snapshot.events),
  };
}

/**
 * Ordered, fail-closed session-log format migration registry.
 *
 * The registry deliberately owns only structurally decodable log upgrades. A
 * storage backend must still decode enough of an old artifact to produce a
 * header/event snapshot before this layer can run. Every step advances exactly
 * one version and must preserve the session identity. Missing steps refuse the
 * log instead of guessing.
 */
export class SessionFormatMigrationRegistry {
  private readonly steps = new Map<number, SessionFormatMigration>();

  /** Register one `N -> N+1` migration. Returns an unregister function. */
  register(migration: SessionFormatMigration): () => void {
    validateVersion(migration.fromVersion, "session migration fromVersion");
    if (this.steps.has(migration.fromVersion)) {
      throw new Error(
        `session migration from v${migration.fromVersion} is already registered`,
      );
    }
    this.steps.set(migration.fromVersion, migration);
    return () => {
      if (this.steps.get(migration.fromVersion) === migration)
        this.steps.delete(migration.fromVersion);
    };
  }

  /** Whether every migration step from `fromVersion` to `targetVersion` exists. */
  canUpgrade(
    fromVersion: number,
    targetVersion = SESSION_FORMAT_VERSION,
  ): boolean {
    validateVersion(fromVersion, "session migration source version");
    validateVersion(targetVersion, "session migration target version");
    if (fromVersion > targetVersion) return false;
    for (let version = fromVersion; version < targetVersion; version++) {
      if (!this.steps.has(version)) return false;
    }
    return true;
  }

  /**
   * Upgrade a detached snapshot to `targetVersion` without mutating caller data.
   * Newer snapshots and incomplete migration chains fail closed.
   */
  upgrade(
    snapshot: SessionFormatSnapshot,
    targetVersion = SESSION_FORMAT_VERSION,
  ): SessionFormatSnapshot {
    validateVersion(snapshot.meta.version, "stored session format version");
    validateVersion(targetVersion, "session migration target version");
    if (snapshot.meta.version > targetVersion) {
      throw new Error(
        `cannot migrate session "${snapshot.meta.id}" backward from v${snapshot.meta.version} to v${targetVersion}`,
      );
    }

    const id = snapshot.meta.id;
    let current = detached(snapshot);
    for (
      let version = current.meta.version;
      version < targetVersion;
      version++
    ) {
      const step = this.steps.get(version);
      if (step === undefined) {
        throw new Error(
          `session "${id}" has no registered migration from v${version} to v${version + 1}`,
        );
      }
      const next = detached(step.migrate(current));
      if (next.meta.id !== id)
        throw new Error(
          `session migration v${version}->v${version + 1} changed session identity`,
        );
      if (next.meta.version !== version + 1) {
        throw new Error(
          `session migration v${version}->v${version + 1} returned v${next.meta.version}`,
        );
      }
      current = next;
    }
    return current;
  }
}
