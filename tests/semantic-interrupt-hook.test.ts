import { expect, test } from "bun:test";
import { installCodexInterruptHook, restoreCodexInterruptHook, verifyCodexInterruptHook,
  MANAGED_INTERRUPT_HOOK_START, MANAGED_INTERRUPT_HOOK_END } from "../src/codex-interrupt-hook";

const original = '# user setting\nmodel = "native"\n';
const fixture = () => installCodexInterruptHook(original, "/tmp/codex/config.toml", { runtimeCommand: ["/opt/runtime"] });
const withoutMarkers = (text: string) => text.replace(MANAGED_INTERRUPT_HOOK_START, "").replace(MANAGED_INTERRUPT_HOOK_END, "");

test.each(["markers", "whitespace", "blank lines", "reordered fields", "interleaved tables", "quoted headers"])("reconciles semantically identical hook: %s", style => {
  const f = fixture();
  let text = withoutMarkers(f.text);
  if (style === "whitespace") text = text.replaceAll(" = ", "  =  ").replace('timeout  =  3', 'timeout  =  3 # user timeout note');
  if (style === "blank lines") text = text.replaceAll("\n\n", "\n");
  if (style === "reordered fields") text = text.replace('type = "command"\n', '').replace('timeout = 3', 'timeout = 3\ntype = "command"');
  if (style === "interleaved tables") text = text.replace('[hooks.state.', '[mcp_servers.user]\ncommand = "keep"\n# user comment\n\n[hooks.state.');
  if (style === "quoted headers") text = text.replaceAll('hooks.Interrupt', '"hooks" . "Interrupt"');
  verifyCodexInterruptHook(text, f.installed);
  const restored = restoreCodexInterruptHook(text, f.installed);
  expect(restored).toContain(style === "whitespace" ? original.replaceAll(" = ", "  =  ") : original);
  expect(Bun.TOML.parse(restored)).toEqual({ model: "native", ...(style === "interleaved tables" ? { mcp_servers: { user: { command: "keep" } } } : {}) });
  if (style === "interleaved tables") expect(restored).toContain('# user comment');
  if (style === "whitespace") expect(restored).toContain('# user timeout note');
  const reinstalled = installCodexInterruptHook(restored, "/tmp/codex/config.toml", { runtimeCommand: ["/opt/runtime"] });
  expect(restoreCodexInterruptHook(reinstalled.text, reinstalled.installed)).toBe(restored);
});

test.each(["command", "hash", "state key", "extra field", "duplicate hook", "group index"])("semantic recovery rejects changed %s", field => {
  const f = fixture();
  let text = withoutMarkers(f.text);
  if (field === "command") text = text.replace('/opt/runtime', '/opt/other');
  if (field === "hash") text = text.replace(f.installed.trustedHash, 'sha256:wrong');
  if (field === "state key") text = text.replace(JSON.stringify(f.installed.stateKey), JSON.stringify(f.installed.stateKey + 'other'));
  if (field === "extra field") text = text.replace('timeout = 3', 'timeout = 3\nextra = true');
  if (field === "duplicate hook") text += '\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = ' + JSON.stringify(f.installed.command) + '\ntimeout = 3\n';
  if (field === "group index") f.installed.groupIndex++;
  expect(() => restoreCodexInterruptHook(text, f.installed)).toThrow();
});

test("table-like text inside a user multiline value never establishes ownership", () => {
  const f = fixture();
  const decoy = "description = '''\n" + withoutMarkers(f.installed.fragment) + "\n'''\n";
  expect(() => restoreCodexInterruptHook(decoy, f.installed)).toThrow();
});
