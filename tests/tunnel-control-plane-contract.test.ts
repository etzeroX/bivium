import { expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig } from "../src/config";
import { runtimeStateChecks } from "../src/doctor";
import { createTunnelConfig, inspectControlPlanePoll, parseControlPlanePollHealthReport,
  parseTunnelStatus, tunnelConnectLaunchError } from "../src/tunnel";

const config = defaultConfig("full");
config.tunnel = createTunnelConfig({ binaryPath: join(tmpdir(), "tunnel-client"),
  tunnelId: "tunnel_11111111111111111111111111111111", runtimeKeyFile: join(tmpdir(), "key") });
const healthFile = join(tmpdir(), "owned-health-url");
const inventory = JSON.stringify({ aliases: [
  { alias: "unrelated", health_url_file: join(tmpdir(), "other") },
  { alias: config.tunnel.alias, health_url_file: healthFile },
] });

for (const [poll, state] of [
  [{ ok: true, value: 1700000000 }, "healthy"],
  [{ ok: false, value: 0, error: "no successful control-plane poll observed" }, "never-succeeded"],
  [{ ok: false, error: "500 Internal Server Error" }, "error"],
] as const) test(`official 0.0.14 command sequence reports ${state} independently of local probes`, () => {
  const calls: string[][] = [];
  const result = inspectControlPlanePoll(config, "0.0.14", (binary, args, options) => {
    expect(binary).toBe(config.tunnel!.binaryPath);
    expect(options?.timeout).toBe(5000);
    calls.push(args);
    return { status: calls.length === 1 || state === "healthy" ? 0 : 2, stderr: "",
      stdout: calls.length === 1 ? inventory : JSON.stringify({
        healthz: { ok: true }, readyz: { ok: true }, control_plane_poll: poll,
      }) };
  });
  expect(calls).toEqual([["runtimes", "list", "--json"],
    ["health", "--url-file", healthFile, "--require-control-plane-poll", "--json"]]);
  expect(result.state).toBe(state);
});

test.each(["null", "[]", "1", "{}", '{"healthz":{"ok":true},"readyz":{"ok":true}}'])(
  "missing polling evidence never inherits healthy local probes: %s", output => {
    expect(parseControlPlanePollHealthReport(output).state).toBe("error");
  },
);

test.each(["null", "{}", '{"aliases":[]}', JSON.stringify({ aliases: [
  { alias: config.tunnel.alias, health_url_file: healthFile },
  { alias: config.tunnel.alias, health_url_file: healthFile },
] }), JSON.stringify({ aliases: [{ alias: config.tunnel.alias, health_url_file: "relative" }] })])(
  "invalid or ambiguous inventory cannot select a health endpoint: %s", stdout => {
    let calls = 0;
    expect(inspectControlPlanePoll(config, "0.0.14", () => {
      calls++;
      return { status: 0, stdout, stderr: "" };
    }).state).toBe("error");
    expect(calls).toBe(1);
  },
);

test("untrusted command output and arbitrary credential formats cannot reach Doctor or launch errors", () => {
  const secret = "arbitraryCredentialWithoutAKnownPrefix";
  const failedPoll = parseControlPlanePollHealthReport(JSON.stringify({ control_plane_poll: {
    ok: false, error: `Authorization: Bearer ${secret}; api_key=${secret}`,
  } }), 2);
  const runtime = parseTunnelStatus(`failure using ${secret}`, config.tunnel!.alias, 1);
  const report = runtimeStateChecks(config, runtime, failedPoll);
  const launch = tunnelConnectLaunchError(JSON.stringify({ running: false, healthy: false,
    remote_error: secret, launch_diagnostics: { log_tail: secret, exit_code: 1 } }));
  const failedInventory = inspectControlPlanePoll(config, "0.0.14", () => ({
    status: 1, stdout: secret, stderr: secret,
  }));
  const failedSpawn = inspectControlPlanePoll(config, "0.0.14", () => { throw new Error(secret); });
  expect(JSON.stringify({ report, launch, failedInventory, failedSpawn })).not.toContain(secret);
  expect(failedPoll.state).toBe("error");
  expect(failedInventory.state).toBe("error");
  expect(failedSpawn.state).toBe("error");
  expect(launch).toContain("exit_code=1");
});
