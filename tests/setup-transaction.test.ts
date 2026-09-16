import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SetupTransaction } from "../src/setup-transaction";

const roots: string[] = [];

afterEach(() => {
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
