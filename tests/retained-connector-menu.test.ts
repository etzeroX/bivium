import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

// Exercise production attachment -> selection -> exact pill proof on one retained page.
// Only browser transport and time are modeled; hydration is delivered as a DOM mutation.
function retainedMenuFixture(kind: "late" | "absent" | "wrong" | "bad-pill" | "abort" = "late", labeled = true) {
  let now = 1_000;
  let mentionAt = now;
  let turn = 0;
  let selected: string[] = [];
  let typed = "";
  let hydrated = false;
  let cleanup = 0;
  let observers = 0;
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let mutation: (() => void) | undefined;
  const controller = new AbortController();
  const events: string[] = [];
  const timeout = () => Object.assign(new Error("menu not hydrated"), { name: "TimeoutError" });
  const exact = () => hydrated && kind !== "absent" && kind !== "wrong";
  const tick = (ms: number) => {
    now += ms;
    if (now - mentionAt >= (turn === 0 ? 0 : 3_100)) {
      hydrated = true;
      mutation?.();
    }
  };
  const context = createContext({
    document: { documentElement: {} },
    MutationObserver: class {
      constructor(callback: () => void) { mutation = callback; }
      observe() { observers++; }
      disconnect() { observers--; mutation = undefined; }
    },
    setTimeout: (callback: () => void, ms: number) => {
      const id = ++timerId;
      timers.set(id, callback);
      queueMicrotask(() => {
        if (!timers.has(id)) return;
        if (kind === "abort") controller.abort();
        tick(ms);
        if (timers.has(id)) callback();
      });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const result = {
    isVisible: async () => exact(),
    waitFor: async ({ timeout: ms, signal }: { timeout: number; signal?: AbortSignal }) => {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (exact()) return;
      tick(ms);
      if (!exact()) throw timeout();
    },
    count: async () => exact() ? 1 : 0,
    getAttribute: async () => "",
  };
  const rows = {
    filter: ({ visible }: { visible?: boolean }) => visible ? {
      allInnerTexts: async () => hydrated ? [kind === "wrong" ? "Codex Native2 DEV" : "Other"] : [],
      count: async () => 1,
    } : result,
  };
  const pill = {
    waitFor: async () => {},
    evaluateAll: async (fn: (elements: unknown[]) => unknown) => fn(selected.map(keyword => ({ getAttribute: () => keyword }))),
  };
  const composer = {
    locator: (selector: string) => selector === "xpath=ancestor::form[1]" ? {
      getByTestId: () => ({
        waitFor: async () => {}, isEnabled: async () => true,
        press: async () => { expect(selected).toEqual(["Codex Native2"]); events.push("send"); },
      }),
    } : { filter: () => pill },
    fill: async (value: string) => { typed = value; selected = []; },
    focus: async () => {},
    pressSequentially: async (value: string) => {
      expect(value).toBe("@codex");
      mentionAt = now;
      hydrated = turn === 0;
      typed = value;
      events.push("mention");
    },
    press: async (key: string) => {
      if (key === "Enter") {
        expect(exact()).toBeTrue();
        selected = [kind === "bad-pill" ? "Codex Native2 DEV" : "Codex Native2"];
        events.push("activate");
      }
    },
    evaluate: async () => ({ text: typed, focused: true }),
  };
  const invisible: any = { filter: () => invisible, last: () => invisible, isVisible: async () => false };
  const page = {
    isClosed: () => false,
    getByRole: (_role: string, { name }: { name: RegExp }) => {
      const locator = { filter: () => locator, count: async () => labeled && name.test("Personalized") ? 1 : 0 };
      return locator;
    },
    getByText: (name: string, options: unknown) => {
      expect(name).toBe("Codex Native2"); expect(options).toEqual({ exact: true }); return {};
    },
    locator: (selector: string) => {
      if (selector.includes("role=")) return invisible;
      if (!selector.includes("__menu-item")) throw new Error("must not change personalization for a slow catalog");
      return rows;
    },
    evaluate: async (fn: Function, arg: unknown) => runInContext(`(${fn.toString()})`, context)(arg),
  };
  const prototype = ChatGptBrowserWorker.prototype as any;
  const worker = Object.assign(Object.create(prototype), {
    config: { appName: "Codex Native2" },
    waitForSubmissionAcceptedWithRecovery: async () => "user_turn",
    activeComposer: async () => composer,
    clearChatGptComposerState: async () => { cleanup++; selected = []; typed = ""; },
    insertPromptText: async () => {
      expect(await worker.connectorIsSelected(composer)).toBeTrue();
      events.push("attach");
    },
    assertPromptAttached: async () => events.push("integrity"),
  });
  return {
    now: () => now,
    events,
    async run() {
      await worker.attachPrompt(page, "synthetic instruction", true, async (checkpoint: string) => {
        if (checkpoint === "connector-selected") events.push("pill-proven");
      }, controller.signal, false, undefined, true);
      await worker.sendAttachedPrompt(page, {}, undefined, controller.signal);
    },
    followup() { turn++; selected = []; hydrated = false; events.length = 0; },
    state: () => ({ cleanup, observers, timers: timers.size, typed }),
  };
}

for (const labeled of [true, false]) test(`retained follow-up waits beyond 2.5s for mutation before attaching (${labeled})`, async () => {
  const f = retainedMenuFixture("late", labeled);
  const realNow = Date.now;
  Date.now = f.now;
  try {
    await f.run();
    f.followup();
    await f.run();
    expect(f.events.filter(event => event === "send")).toHaveLength(1);
    expect(f.events.indexOf("pill-proven")).toBeLessThan(f.events.indexOf("attach"));
    expect(f.events.indexOf("attach")).toBeLessThan(f.events.indexOf("send"));
    expect(f.state().observers).toBe(0);
    expect(f.state().timers).toBe(0);
    const finalEvents = [...f.events];
    await Promise.resolve();
    expect(f.events).toEqual(finalEvents);
  } finally { Date.now = realNow; }
});

for (const labeled of [true, false]) for (const kind of ["absent", "wrong", "bad-pill", "abort"] as const) test(`retained connector ${kind} fails before attachment or send (labeled=${labeled})`, async () => {
  const f = retainedMenuFixture(kind, labeled);
  f.followup();
  const realNow = Date.now;
  Date.now = f.now;
  try {
    if (kind === "abort") await expect(f.run()).rejects.toMatchObject({ name: "AbortError" });
    else if (kind === "absent" || kind === "wrong") {
      await expect(f.run()).rejects.toMatchObject({ status: 424, code: "connector_not_found", retryable: false });
    } else await expect(f.run()).rejects.toThrow("did not select");
    expect(f.events).not.toContain("attach");
    expect(f.events).not.toContain("send");
    expect(f.state().cleanup).toBeGreaterThan(0);
    expect(f.state().typed).toBe("");
    expect(f.state().observers).toBe(0);
    expect(f.state().timers).toBe(0);
    const finalEvents = [...f.events];
    await Promise.resolve();
    expect(f.events).toEqual(finalEvents);
  } finally { Date.now = realNow; }
});

test("a pre-submit connector failure replays through five reconnects without another browser attempt", async () => {
  const { ChatGptWebAdapterError } = await import("../src/adapters/chatgpt-web/adapter-error");
  const { createChatGptWebAdapter } = await import("../src/adapters/chatgpt-web/index");
  const { CHATGPT_WEB_MODEL_ID } = await import("../src/adapters/chatgpt-web/model");
  const { bridgeToResponsesSSE } = await import("../src/bridge");
  const provider = {
    adapter: "chatgpt-web" as const,
    baseUrl: `browser://connector-readiness-replay-${Date.now()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let starts = 0;
  worker.run = async () => {
    starts++;
    throw new ChatGptWebAdapterError("ChatGPT connector catalog readiness deadline expired", {
      status: 424, errorType: "connector_error", code: "connector_not_found", retryable: false,
    });
  };
  const request: import("../src/types").CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID, stream: true,
    context: { tools: [], messages: [{ role: "user", content: "Inspect the project", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: "connector-readiness-thread",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "connector-readiness-thread", turn_id: "connector-readiness-turn" }),
      },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: "connector-readiness-turn" } }],
    },
  };
  try {
    const adapter = createChatGptWebAdapter(provider);
    for (let attempt = 0; attempt <= 5; attempt++) {
      const events: import("../src/types").AdapterEvent[] = [];
      await adapter.runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(events.filter(event => event.type === "error")).toEqual([expect.objectContaining({
        status: 424, code: "connector_not_found", retryable: false,
      })]);
      async function* replay() { yield* events; }
      const body = await new Response(bridgeToResponsesSSE(replay(), CHATGPT_WEB_MODEL_ID,
        undefined, undefined, undefined, undefined, 2_000, { streamPlatform: "win32" })).text();
      expect(body).toContain("event: response.failed");
      expect(body).toContain('"code":"connector_not_found"');
      expect(body).toContain('"retryable":false');
      expect(body).toEndWith("data: [DONE]\n\n");
    }
    expect(starts).toBe(1);
  } finally { worker.run = originalRun; }
});
