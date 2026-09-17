import type { FileSnapshot } from "./codex-integration-shared";
import { restoreFileSnapshot, snapshotFile } from "./codex-integration-shared";

export type SetupTransactionPhase =
  | "inspect"
  | "prepared"
  | "applied"
  | "verified"
  | "committed"
  | "rolled-back";

export class SetupTransaction {
  private readonly snapshots = new Map<string, FileSnapshot>();
  private currentPhase: SetupTransactionPhase = "inspect";

  get phase(): SetupTransactionPhase {
    return this.currentPhase;
  }

  track(path: string, options?: { followSymlink?: boolean }): void {
    if (this.currentPhase !== "inspect") {
      throw new Error(`Setup transaction cannot track files during ${this.currentPhase}`);
    }
    if (!this.snapshots.has(path)) this.snapshots.set(path, snapshotFile(path, options));
  }

  prepared(): void {
    this.transition("inspect", "prepared");
  }

  applied(): void {
    this.transition("prepared", "applied");
  }

  verified(): void {
    this.transition("applied", "verified");
  }

  commit(): void {
    this.transition("verified", "committed");
  }

  rollback(error: unknown): never {
    if (this.currentPhase === "committed") {
      throw new Error("Committed setup transaction cannot be rolled back");
    }
    const rollbackFailures: string[] = [];
    for (const snapshot of [...this.snapshots.values()].reverse()) {
      try {
        restoreFileSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(
          `${snapshot.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    this.currentPhase = "rolled-back";
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(
      rollbackFailures.length > 0
        ? `${primary}; setup rollback also failed: ${rollbackFailures.join("; ")}`
        : primary,
      { cause: error },
    );
  }

  private transition(expected: SetupTransactionPhase, next: SetupTransactionPhase): void {
    if (this.currentPhase !== expected) {
      throw new Error(`Invalid setup transaction transition: ${this.currentPhase} -> ${next}`);
    }
    this.currentPhase = next;
  }
}
