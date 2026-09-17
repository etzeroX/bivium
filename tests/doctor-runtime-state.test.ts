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

  test("full healthy mode reports a real successful control-plane poll", () => {
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
    }, { state: "healthy", timestamp: 1_700_000_000 })).toEqual([
      { id: "runtime-mode", status: "ok", message: "Runtime: full" },
      { id: "connector-identity", status: "ok", message: "Connector identity configured: YES (Codex Native2)" },
      { id: "local-tools", status: "ok", message: "Local tools: ENABLED" },
      { id: "tunnel-config", status: "ok", message: "Tunnel: CONFIGURED" },
      { id: "tunnel-process", status: "ok", message: "Tunnel process: RUNNING" },
      { id: "tunnel-health", status: "ok", message: "Tunnel local health: HEALTHY" },
      { id: "tunnel-readiness", status: "ok", message: "Tunnel local readiness: READY" },
      {
        id: "control-plane-poll",
        status: "ok",
        message: "Control Plane polling: HEALTHY",
        detail: "last successful poll unix timestamp: 1700000000",
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

  test("does not collapse health and readiness into one signal", () => {
    const healthFailed = runtimeStateChecks({ mode: "full", appName: "Codex Native2" }, {
      ok: false,
      processRunning: true,
      healthy: false,
      ready: true,
      detail: "health=false ready=true",
    }, { state: "healthy", timestamp: 1 });
    expect(healthFailed.find(check => check.id === "tunnel-health")?.status).toBe("error");
    expect(healthFailed.find(check => check.id === "tunnel-readiness")?.status).toBe("ok");

    const readinessFailed = runtimeStateChecks({ mode: "full", appName: "Codex Native2" }, {
      ok: false,
      processRunning: true,
      healthy: true,
      ready: false,
      detail: "health=true ready=false",
    }, { state: "healthy", timestamp: 1 });
    expect(readinessFailed.find(check => check.id === "tunnel-health")?.status).toBe("ok");
    expect(readinessFailed.find(check => check.id === "tunnel-readiness")?.status).toBe("error");
  });

  test("full mode reports a control-plane poll that has never succeeded", () => {
    const checks = runtimeStateChecks({ mode: "full", appName: "Codex Native2" }, {
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true healthy=true ready=true",
    }, { state: "never-succeeded" });

    expect(checks.find(check => check.id === "control-plane-poll")).toEqual({
      id: "control-plane-poll",
      status: "error",
      message: "Control Plane polling: NEVER SUCCEEDED",
    });
  });

  test("full mode reports a control-plane probe error without changing local readiness", () => {
    const checks = runtimeStateChecks({ mode: "full", appName: "Codex Native2" }, {
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "process_running=true healthy=true ready=true",
    }, { state: "error", detail: "metrics endpoint returned HTTP 500" });

    expect(checks.find(check => check.id === "tunnel-readiness")?.status).toBe("ok");
    expect(checks.find(check => check.id === "control-plane-poll")).toEqual({
      id: "control-plane-poll",
      status: "error",
      message: "Control Plane polling: ERROR",
      detail: "metrics endpoint returned HTTP 500",
    });
  });

  test("stopped process is reported independently from the poll error", () => {
    const checks = runtimeStateChecks({ mode: "full", appName: "Codex Native2" }, {
      ok: false,
      processRunning: false,
      healthy: false,
      ready: false,
      state: "stopped",
      detail: "local_inventory=absent",
    }, { state: "error", detail: "tunnel process is not running" });

    expect(checks.find(check => check.id === "tunnel-process")?.status).toBe("error");
    expect(checks.find(check => check.id === "tunnel-health")?.status).toBe("error");
    expect(checks.find(check => check.id === "tunnel-readiness")?.status).toBe("error");
    expect(checks.find(check => check.id === "control-plane-poll")?.status).toBe("error");
  });

  test("older pinned client reports the metric as unsupported rather than inferred", () => {
    const checks = runtimeStateChecks({ mode: "full", appName: "Codex Native2" }, {
      ok: true,
      processRunning: true,
      healthy: true,
      ready: true,
      state: "ready",
      detail: "ready",
    }, { state: "unsupported", version: "0.0.12" });

    expect(checks.find(check => check.id === "control-plane-poll")).toEqual({
      id: "control-plane-poll",
      status: "warning",
      message: "Control Plane polling: NOT OBSERVABLE with tunnel-client 0.0.12",
    });
  });
});
