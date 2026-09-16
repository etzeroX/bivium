import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

test("Full Harness verifies Native2 on the first turn and every retained follow-up", async () => {
  const events: string[] = [];
  let selected = false;
  const composer = { fill: async () => { selected = false; }, focus: async () => {}, press: async () => {} };
  const worker = {
    activeComposer: async () => composer,
    selectConnector: async () => { events.push("verify-binding"); selected = true; return composer; },
    insertPromptText: async () => { expect(selected).toBe(true); events.push("attach"); },
    assertPromptAttached: async () => {},
    clearChatGptComposerState: async () => { selected = false; },
  };
  const attach = ChatGptBrowserWorker.prototype["attachPrompt"];
  for (const retained of [false, true, true, true]) {
    // The UI removes the submitted mention; a retained lease is not a composer binding.
    selected = false;
    await attach.call(worker as never, {} as never, "use a local tool", true,
      undefined, undefined, false, undefined, retained);
    expect(selected).toBe(true);
  }
  expect(events).toEqual(Array(4).fill(["verify-binding", "attach"]).flat());
});

test("retained connector verification failure prevents attaching a tool prompt", async () => {
  let inserts = 0;
  const missing = new Error("Native2 unavailable");
  await expect(ChatGptBrowserWorker.prototype["attachPrompt"].call({
    selectConnector: async () => { throw missing; },
    activeComposer: async () => ({ fill: async () => {}, focus: async () => {} }),
    insertPromptText: async () => { inserts++; }, assertPromptAttached: async () => {},
  } as never, {} as never, "task", true, undefined, undefined, false, undefined, true)).rejects.toBe(missing);
  expect(inserts).toBe(0);
});
