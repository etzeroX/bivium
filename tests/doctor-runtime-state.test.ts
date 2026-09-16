import { describe, expect, test } from "bun:test";
import { runtimeStateChecks } from "../src/doctor";

describe("doctor runtime state", () => {
  test("browser-only reports disabled capabilities as intentional state", () => {
    expect(runtimeStateChecks({
      mode: "browser-only",
      appName: "Codex Native2",
    })).toEqual([
      { id: "runtime-mode", status: "ok", message: "Runtime: browser-only" },
      { id: "connector-identity", status: "ok", message: "Connector identity configured: YES (Codex Native2)" },
      { id: "local-tools", status: "ok", message: "Local tools: DISABLED" },
      { id: "tunnel-config", status: "ok", message: "Tunnel: NOT CONFIGURED" },
    ]);
  });

  test("full mode keeps local tunnel evidence separate from remote discovery", () => {
    expect(runtimeStateChecks({
      mode: "full",
      appName: "Codex Native2",
    }, {
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true healthy=true ready=true",
    })).toEqual([
      { id: "runtime-mode", status: "ok", message: "Runtime: full" },
      { id: "connector-identity", status: "ok", message: "Connector identity configured: YES (Codex Native2)" },
      { id: "local-tools", status: "ok", message: "Local tools: ENABLED" },
      { id: "tunnel-config", status: "ok", message: "Tunnel: CONFIGURED" },
      { id: "tunnel-process", status: "ok", message: "Tunnel process: RUNNING" },
      { id: "tunnel-health", status: "ok", message: "Tunnel local health: HEALTHY" },
      { id: "tunnel-readiness", status: "ok", message: "Tunnel local readiness: READY" },
      {
        id: "control-plane-poll",
        status: "warning",
        message: "Control-plane poll: NOT OBSERVABLE with tunnel-client 0.0.12 local inventory",
      },
    ]);
  });

  test("full mode exposes each failed local tunnel signal independently", () => {
    const checks = runtimeStateChecks({ mode: "full", appName: "Codex Native2" }, {
      ok: false,
      processRunning: true,
      healthy: false,
      ready: false,
      state: "starting",
      detail: "process_running=true healthy=false ready=false state=starting",
    });

    expect(checks.find(check => check.id === "tunnel-process")?.status).toBe("ok");
    expect(checks.find(check => check.id === "tunnel-health")?.status).toBe("error");
    expect(checks.find(check => check.id === "tunnel-readiness")?.status).toBe("error");
  });
});
