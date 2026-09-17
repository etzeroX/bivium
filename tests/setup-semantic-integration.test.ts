import { expect, test } from "bun:test";
import { join } from "node:path";

test("semantic hook reconciliation participates in full setup and exact rollback (#3 + #10)", async () => {
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "fixtures/setup-transaction-flow.ts"), "--semantic-hooks"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("setup transaction flow: passed");
}, 30_000);
