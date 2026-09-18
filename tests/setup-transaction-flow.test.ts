import { expect, test } from "bun:test";
import { join } from "node:path";

test("actual launcher setup is idempotent and rolls back fresh and active installations", async () => {
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "fixtures/setup-transaction-flow.ts")], {
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("setup transaction flow: passed");
}, 30_000);
