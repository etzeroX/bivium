import { describe, expect, test } from "bun:test";
import {
  TUNNEL_VERSION,
  parseControlPlanePollHealthReport,
  parseTunnelStatus,
  tunnelClientInstallAction,
  tunnelClientRelease,
  tunnelCommandOutput,
  tunnelConnectLaunchError,
} from "../src/tunnel";

test("pins the fixed tunnel-client and migrates only the previously shipped version", () => {
  expect(TUNNEL_VERSION).toBe("0.0.14");
  expect(tunnelClientInstallAction("0.0.14")).toBe("reuse");
  expect(tunnelClientInstallAction("0.0.12")).toBe("upgrade");
  expect(tunnelClientInstallAction("0.0.10")).toBe("upgrade");
  expect(() => tunnelClientInstallAction("0.0.11")).toThrow("not a trusted upgrade source");
  expect(() => tunnelClientInstallAction("0.0.13")).toThrow("not a trusted upgrade source");
  expect(() => tunnelClientInstallAction("9.9.9")).toThrow("not a trusted upgrade source");
});

test("pins every official 0.0.14 desktop archive checksum", () => {
  expect(tunnelClientRelease("darwin", "x64")).toEqual({
    asset: "tunnel-client-v0.0.14-darwin-amd64.zip",
    sha256: "75e10be774184fb42189e347b16eb6bc9fb0780135d8af714d34e30ce068dc53",
  });
  expect(tunnelClientRelease("darwin", "arm64")).toEqual({
    asset: "tunnel-client-v0.0.14-darwin-arm64.zip",
    sha256: "b540493c5bdbcdbb755700c8e2e16597e28b1569e425007e0f73111047bd6a64",
  });
  expect(tunnelClientRelease("linux", "x64")).toEqual({
    asset: "tunnel-client-v0.0.14-linux-amd64.zip",
    sha256: "15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3",
  });
  expect(tunnelClientRelease("linux", "arm64")).toEqual({
    asset: "tunnel-client-v0.0.14-linux-arm64.zip",
    sha256: "2de3fb879a18edb847e0313592c912f1983685488290a7fdba7ac403e6a4fb0a",
  });
  expect(tunnelClientRelease("win32", "x64")).toEqual({
    asset: "tunnel-client-v0.0.14-windows-amd64.zip",
    sha256: "784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5",
  });
  expect(tunnelClientRelease("win32", "arm64")).toEqual({
    asset: "tunnel-client-v0.0.14-windows-arm64.zip",
    sha256: "fa775db8897df543dd4ba66404f69492a2acfbc6a291f10df27aced064a16568",
  });
  expect(() => tunnelClientRelease("freebsd", "x64")).toThrow("no pinned build");
  expect(() => tunnelClientRelease("linux", "ia32")).toThrow("no pinned build");
});

describe("control-plane poll health", () => {
  test("parses the official 0.0.14 health report", () => {
    expect(parseControlPlanePollHealthReport(JSON.stringify({
      control_plane_poll: { ok: true, value: 1_700_000_000 },
    }))).toEqual({ state: "healthy", timestamp: 1_700_000_000 });
    expect(parseControlPlanePollHealthReport(JSON.stringify({
      control_plane_poll: {
        ok: false,
        error: "no successful control-plane poll observed",
      },
    }), 2)).toEqual({ state: "never-succeeded" });
  });

  test("rejects missing, invalid, and failed health reports", () => {
    expect(parseControlPlanePollHealthReport("not json", 2)).toEqual({
      state: "error",
      detail: "tunnel-client returned an invalid control-plane health report",
    });
    expect(parseControlPlanePollHealthReport(JSON.stringify({}), 2).state).toBe("error");
    expect(parseControlPlanePollHealthReport(JSON.stringify({
      control_plane_poll: { ok: false, error: "metrics endpoint returned HTTP 500" },
    }), 2)).toEqual({ state: "error", detail: "metrics endpoint returned HTTP 500" });
  });
});

describe("tunnel status boundary", () => {
  test("requires the exact alias to have a locally verified ready runtime", () => {
    expect(parseTunnelStatus(JSON.stringify({
      entries: [{ alias: "ours", runtime_state: "ready" }],
    }), "ours")).toEqual({
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true healthy=true ready=true",
    });
    for (const state of ["stopped", "starting", "healthy"]) {
      expect(parseTunnelStatus(JSON.stringify({ entries: [
        { alias: "other", runtime_state: "ready" }, { alias: "ours", runtime_state: state },
      ] }), "ours")).toMatchObject({
        ok: false, processRunning: state !== "stopped", healthy: state === "healthy", ready: false,
      });
    }
  });

  test("redacts tunnel ids and keys from safe diagnostics", () => {
    const result = parseTunnelStatus(
      "failed tunnel_0123456789abcdef0123456789abcdef with sk-secretsecretsecret",
      "ours",
      1,
    );
    expect(result.detail).toBe("tunnel-client inventory exited with status 1 (diagnostic output withheld)");
    expect(result.detail).not.toContain("0123456789abcdef");
  });

  test("surfaces and redacts an immediate managed-runtime launch failure", () => {
    const detail = tunnelConnectLaunchError(JSON.stringify({
      running: false,
      healthy: false,
      ready: false,
      exit_code: 1,
      launch_diagnostics: {
        log_tail: "403 for tunnel_0123456789abcdef0123456789abcdef using sk-secretsecretsecret",
      },
    }));

    expect(detail).toBe(
      "running=false; healthy=false; ready=false; exit_code=1; runtime_log=[withheld]",
    );
  });

  test("accepts a healthy managed launch while setup waits for control-plane readiness", () => {
    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: true,
      ready: true,
    }))).toBeUndefined();

    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: true,
      ready: false,
    }))).toBeUndefined();

    expect(tunnelConnectLaunchError(JSON.stringify({
      running: true,
      healthy: false,
      ready: false,
    }))).toContain("running=true; healthy=false; ready=false");

    expect(tunnelConnectLaunchError("not json")).toBe("tunnel-client returned non-JSON connect output");
  });

  test("missing, ambiguous, or malformed local inventory cannot report ready", () => {
    const ready = { alias: "ours", runtime_state: "ready" };
    for (const output of ["invalid JSON", "{}", JSON.stringify({ entries: [ready, ready] }),
      JSON.stringify({ entries: [{ ...ready, runtime_state: "unknown" }] })]) {
      expect(parseTunnelStatus(output, "ours")).toMatchObject({ ok: false, ready: false });
      expect(parseTunnelStatus(output, "ours").detail).toContain("invalid local inventory");
    }
    expect(parseTunnelStatus(JSON.stringify({ entries: [{ ...ready, alias: "other" }] }), "ours"))
      .toMatchObject({ ok: false, processRunning: false, healthy: false, ready: false, state: "stopped" });
  });

  test("status diagnostics do not discard stderr when a failed command also wrote stdout", () => {
    expect(tunnelCommandOutput({
      status: 1,
      stdout: '{"partial":true}',
      stderr: "runtime process exited with status 1",
    })).toBe('runtime process exited with status 1\n{"partial":true}');
    expect(tunnelCommandOutput({
      status: 0,
      stdout: '{"ready":true}',
      stderr: "non-fatal warning",
    })).toBe('{"ready":true}');
  });
});
