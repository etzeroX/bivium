// Run in a separate Bun process: module substitutions must never leak into other tests.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as configModule from "../../src/config";
import * as integrationModule from "../../src/codex-integration";
import * as serviceModule from "../../src/service";
import * as tunnelModule from "../../src/tunnel";
import * as tunnelServiceModule from "../../src/tunnel-service";
import * as browserModule from "../../src/launcher-browser-host";
import * as netModule from "node:net";

const originalInspect = integrationModule.inspectCodexIntegration;
let failVerification = false;
let bootstraps = 0;
let serviceMutations = 0;
const absent = { installed: false, loaded: false };
mock.module("../../src/codex-integration", () => ({ ...integrationModule,
  inspectCodexIntegration: () => {
    const state = originalInspect();
    assert.equal(state.active, true);
    assert.deepEqual(state.errors, []);
    if (failVerification) throw new Error("injected late verification failure");
    return state;
  },
}));
mock.module("../../src/service", () => ({ ...serviceModule,
  getServiceStatus: () => absent,
  installService: () => { serviceMutations++; },
  restartService: () => { serviceMutations++; },
  uninstallService: () => { serviceMutations++; },
}));
mock.module("../../src/tunnel-service", () => ({ ...tunnelServiceModule,
  getTunnelServiceStatus: () => absent,
}));
mock.module("../../src/launcher-browser-host", () => ({ ...browserModule,
  inspectLauncherBrowserHost: async () => ({ solAvailable: true, extraHighAvailable: true, proAvailable: true }),
}));
mock.module("node:net", () => ({ ...netModule,
  createServer: () => ({ unref() {}, once() {}, listen(_port: number, _host: string, ready: () => void) { ready(); },
    close(done: () => void) { done(); } }),
}));
mock.module("../../src/tunnel", () => ({ ...tunnelModule,
  installTunnelClient: async () => {
    const path = join(configModule.getConfigDir(), "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "fixture installed binary");
      writeFileSync(join(dirname(path), "tunnel-client-manifest.json"), "fixture manifest");
    }
    return path;
  },
  connectTunnel: (config: configModule.AppConfig) => {
    bootstraps++;
    const path = join(config.tunnel!.profileDir, `${config.tunnel!.profileName}.yaml`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture tunnel profile");
  },
  waitForTunnelReady: async () => ({ ok: true }),
  stopTunnel: () => {},
}));
const { setup } = await import("../../src/setup");
const semanticHooks = process.argv.includes("--semantic-hooks");
const root = mkdtempSync(join(tmpdir(), "setup-flow-"));
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(path));
    else files[path] = readFileSync(path).toString("base64");
  }
  return files;
}
try {
  for (const mode of ["browser-only", "full"] as const) {
    const home = join(root, mode);
    process.env.CODEX_HOME = join(home, "codex");
    process.env.CODEX_CHATGPT_WEB_HOME = join(home, "app");
    mkdirSync(process.env.CODEX_HOME, { recursive: true });
    const configPath = integrationModule.getCodexConfigPath();
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const options = { mode, acknowledgedUnofficial: true, subagentProtocol: "native" as const,
      browserHostDescriptorPath: join(home, "launcher.json"),
      ...(mode === "full" ? { tunnelId: "tunnel_11111111111111111111111111111111", runtimeKeyValue: "fixture-runtime-key" } : {}),
    };
    const legacyWrapper = join(configModule.getConfigDir(), "bin", "serve-with-playwright.sh");
    const legacyVendor = join(configModule.getConfigDir(), "vendor", "retained-runtime.js");
    mkdirSync(dirname(legacyWrapper), { recursive: true });
    mkdirSync(dirname(legacyVendor), { recursive: true });
    writeFileSync(legacyWrapper, "legacy wrapper");
    writeFileSync(legacyVendor, "legacy runtime");
    const pristine = snapshot(home);
    failVerification = true;
    await assert.rejects(setup(options), /injected late verification failure/);
    assert.deepEqual(snapshot(home), pristine, "fresh setup removes every newly created managed file on failure");
    failVerification = false;
    await setup(options);
    assert.equal(existsSync(legacyWrapper), false, "legacy cleanup follows successful verification");
    assert.equal(existsSync(legacyVendor), false);
    const installed = snapshot(home);
    const stableOptions = { mode, browserHostDescriptorPath: options.browserHostDescriptorPath };
    const beforeBootstraps = bootstraps;
    // Browser-only -> Browser-only and Full -> Full, including repeated Full reinstall.
    await setup(stableOptions);
    await setup(stableOptions);
    assert.deepEqual(snapshot(home), installed);
    assert.equal(bootstraps, beforeBootstraps, "an existing tunnel profile must not be recreated");
    assert.equal(serviceMutations, 0, "launcher reinstall must not mutate system services");
    if (mode === "full") {
      assert.equal(readFileSync(tunnelModule.managedRuntimeKeyPath("automatic"), "utf8").trim(), "fixture-runtime-key");
    }
    // A formatter-equivalent hook remains owned inside the actual setup transaction (#3 + #10).
    const currentConfig = readFileSync(configPath, "utf8");
    const formatted = semanticHooks ? currentConfig.replace("timeout = 3", "timeout  =  3 # user note") : currentConfig;
    writeFileSync(configPath, formatted);
    const activeBaseline = snapshot(home);
    failVerification = true;
    await assert.rejects(setup(stableOptions), /injected late verification failure/);
    assert.deepEqual(snapshot(home), activeBaseline, "active journals, key, profile, and formatted config restore exactly");
    failVerification = false;
    await setup(stableOptions);
    if (semanticHooks) assert.ok(readFileSync(configPath, "utf8").includes("# user note"));
    const formattedInstalled = snapshot(home);
    await setup(stableOptions);
    assert.deepEqual(snapshot(home), formattedInstalled);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("setup transaction flow: passed");
