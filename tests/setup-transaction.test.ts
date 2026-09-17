import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupTransaction } from "../src/setup-transaction";
import {
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
  installCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig } from "../src/config";

const roots: string[] = [];

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("setup transaction restores every managed file in reverse after a late failure", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-setup-transaction-"));
  roots.push(root);
  const existing = join(root, "config.json");
  const created = join(root, "integration-journal.json");
  writeFileSync(existing, "before\n");

  const transaction = new SetupTransaction();
  transaction.track(existing);
  transaction.track(created);
  transaction.prepared();
  writeFileSync(existing, "after\n");
  writeFileSync(created, "partial\n");
  transaction.applied();

  expect(() => transaction.rollback(new Error("verification failed"))).toThrow("verification failed");
  expect(transaction.phase).toBe("rolled-back");
  expect(readFileSync(existing, "utf8")).toBe("before\n");
  expect(() => readFileSync(created, "utf8")).toThrow();
});

test("setup transaction enforces prepare, apply, verify and commit order", () => {
  const transaction = new SetupTransaction();
  transaction.prepared();
  expect(() => transaction.verified()).toThrow("prepared -> verified");
  transaction.applied();
  transaction.verified();
  transaction.commit();
  expect(transaction.phase).toBe("committed");
  expect(() => transaction.rollback(new Error("late"))).toThrow("Committed setup transaction");
});

test.each(["inspect", "prepared", "applied"] as const)(
  "setup transaction restores the exact baseline after a failure in %s",
  phase => {
    const root = mkdtempSync(join(tmpdir(), "cgw-setup-phase-"));
    roots.push(root);
    const existing = join(root, "existing.json");
    const created = join(root, "created.json");
    writeFileSync(existing, "exact baseline\n");

    const transaction = new SetupTransaction();
    transaction.track(existing);
    transaction.track(created);
    // Repeated tracking must retain the first snapshot, not adopt an intermediate mutation.
    transaction.track(existing);
    if (phase !== "inspect") transaction.prepared();
    writeFileSync(existing, `mutated during ${phase}\n`);
    writeFileSync(created, `created during ${phase}\n`);
    if (phase === "applied") transaction.applied();

    expect(() => transaction.rollback(new Error(`failure in ${phase}`))).toThrow(`failure in ${phase}`);
    expect(readFileSync(existing, "utf8")).toBe("exact baseline\n");
    expect(() => readFileSync(created, "utf8")).toThrow();
    expect(transaction.phase).toBe("rolled-back");
  },
);

test("a failed final verification restores Codex config, cache and newly created journals", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-setup-integration-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  mkdirSync(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  const originalConfig = 'model = "gpt-5.6-sol"\napproval_policy = "never"\n';
  writeFileSync(configPath, originalConfig);
  const cachePath = getCodexModelsCachePath();
  writeFileSync(cachePath, "original model cache\n");

  const transaction = new SetupTransaction();
  transaction.track(configPath, { followSymlink: true });
  transaction.track(cachePath);
  transaction.track(getCodexJournalPath());
  transaction.track(getCodexJournalRecoveryPath());
  transaction.prepared();
  installCodexIntegration(defaultConfig("full"));
  transaction.applied();

  expect(() => transaction.rollback(new Error("final verification failed")))
    .toThrow("final verification failed");
  expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
  expect(readFileSync(cachePath, "utf8")).toBe("original model cache\n");
  expect(existsSync(getCodexJournalPath())).toBeFalse();
  expect(existsSync(getCodexJournalRecoveryPath())).toBeFalse();
});
