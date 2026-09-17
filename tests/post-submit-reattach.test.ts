import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserObservationTimeoutError, ChatGptBrowserWorker, isChatGptObservationDisconnect } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

function fixture() {
  const locator = { count: async () => 1 };
  const page = { url: () => "https://chatgpt.com/c/owned", locator: () => locator };
  const baseline = { initialTurnIdentities: ["old"], domCache: {} };
  const binding = { identity: "answer", locator, acceptedTurnIdentities: ["old", "user", "answer"] };
  const state = { turnIdentities: ["old", "user", "answer"], userIdentities: ["user"], responseIdentities: ["answer"] };
  let reconnects = 0;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    submissionDomState: async () => state,
  });
  const recover = async () => { reconnects++; return { page, baseline }; };
  return { worker, page, baseline, binding, state, recover, reconnects: () => reconnects };
}

test.each([false, true])("post-submit recovery preserves the exact active/completed assistant (%s)", async completed => {
  const f = fixture();
  const result = await f.worker.recoverBoundAssistantObservation(f.page.url(), f.baseline, f.binding, 1,
    new ChatGptBrowserObservationTimeoutError(5), f.recover);
  expect(result.binding.identity).toBe("answer");
  expect(result.baseline).toBe(f.baseline);
  expect(f.reconnects()).toBe(1);
  // Recovery only rebuilds observation locators; completion is still decided by the next DOM read.
  f.worker.responseDomSnapshot = async () => ({ responsePresent: true, completionActionVisible: completed });
  expect((await f.worker.responseDomSnapshot(result.binding.locator)).completionActionVisible).toBe(completed);
});

test.each(["navigation", "replacement", "new user", "duplicate", "missing accepted user"])("reattach rejects %s", async scenario => {
  const f = fixture();
  if (scenario === "navigation") f.page.url = () => "https://chatgpt.com/c/other";
  if (scenario === "replacement") f.state.responseIdentities = ["replacement"];
  if (scenario === "new user") f.state.turnIdentities.push("new-user");
  if (scenario === "duplicate") f.binding.locator.count = async () => 2;
  if (scenario === "missing accepted user") f.state.turnIdentities = ["old", "answer"];
  await expect(f.worker.recoverBoundAssistantObservation("https://chatgpt.com/c/owned", f.baseline, f.binding, 1,
    new ChatGptBrowserObservationTimeoutError(5), f.recover)).rejects.toThrow();
});

test.each(["explicit cancellation", "compaction replacement"])("%s cannot reconnect", async reason => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort(new Error(reason));
  await expect(f.worker.recoverBoundAssistantObservation(f.page.url(), f.baseline, f.binding, 1,
    new ChatGptBrowserObservationTimeoutError(5), f.recover, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.reconnects()).toBe(0);
});

test("reattach is bounded and never retries a failed ownership check", async () => {
  const f = fixture();
  await expect(f.worker.recoverBoundAssistantObservation(f.page.url(), f.baseline, f.binding, 3,
    new ChatGptBrowserObservationTimeoutError(5), f.recover)).rejects.toThrow();
  expect(f.reconnects()).toBe(0);
});

test.each([
  [false, new ChatGptBrowserObservationTimeoutError(5), false, false, false],
  [true, new ChatGptBrowserObservationTimeoutError(5), false, false, false],
  [false, new Error("locator.evaluate: Connection closed"), false, false, false],
  [true, new Error("locator.evaluate: Execution context was destroyed, most likely because of a navigation"), false, false, false],
  [false, new ChatGptBrowserObservationTimeoutError(5), true, true, false],
  [false, new ChatGptBrowserObservationTimeoutError(5), true, true, true],
])("primary response disconnect resumes without resending (already completed=%s, %s)", async (completed, fault, retained, localTools, compaction) => {
  const diagnostics = mkdtempSync(join(tmpdir(), "reattach-"));
  const f = fixture();
  const hidden = {
    filter() { return this; }, last() { return this; }, getByTestId() { return this; },
    getByText() { return this; }, isVisible: async () => false, count: async () => 1,
  };
  const page = { url: f.page.url, evaluate: async () => ({}), isClosed: () => false, locator: () => hidden };
  const capabilities = { localToolsEnabled: localTools, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  let sends = 0;
  let reads = 0;
  let recoveries = 0;
  let releases = 0;
  let bindings = 0;
  let attachments = 0;
  let freshPrepares = 0;
  let resumedPrepares = 0;
  const composer = { fill: async () => {}, focus: async () => {}, press: async () => {} };
  const deltas: string[] = [];
  const worker = Object.assign(f.worker, {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnostics, browserHostDescriptorPath: "fixture" },
    runStage: async (_trace: string, _stage: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => action(new AbortController().signal),
    prepareTemporaryChatSurface: async () => {},
    selectModelAndEffort: async () => resolveChatGptWebModelMode("gpt-5.6-sol", "high", capabilities),
    captureSubmissionBaseline: async () => f.baseline,
    activeComposer: async () => composer,
    selectConnector: async () => { bindings++; return composer; },
    insertPromptText: async () => { attachments++; if (localTools) expect(bindings).toBe(1); },
    assertPromptAttached: async () => {},
    attachPromptWithCompactionRetry: async (page: never, text: string, tools: boolean) => {
      await ChatGptBrowserWorker.prototype["attachPrompt"].call(worker, page, text, tools,
        undefined, undefined, false, undefined, retained);
    },
    attachFiles: async () => {},
    sendAttachedPrompt: async () => { sends++; return "user_turn"; },
    waitForNewAssistantTurn: async () => ({ ...f.binding, locator: hidden }),
    responseDomSnapshot: async () => {
      reads++;
      if (reads === 5) throw fault;
      return { responsePresent: true, visibleText: "done", fullHtml: "<p>done</p>",
        markdownSegments: [{ key: "p", tag: "p", html: "<p>done</p>", text: "done", streamable: true }],
        completionActionVisible: completed || reads > 5, stoppedThinkingVisible: false, traceBlocks: [] };
    },
    recoverBoundAssistantObservation: async (...args: unknown[]) => {
      recoveries++;
      // Exercise the real identity verifier; only the external CDP connection is substituted.
      return ChatGptBrowserWorker.prototype["recoverBoundAssistantObservation"].call(worker,
        args[0] as never, args[1] as never, args[2] as never, args[3] as never, args[4] as never,
        async () => ({ page, baseline: f.baseline }) as never);
    },
  });
  try {
    const answer = await worker.runBrowserTurn({ traceId: "reattach_fixture", modelId: "gpt-5.6-sol", reasoning: "high", capabilities,
      compaction,
      nativeConnector: localTools,
      prepare: async () => { freshPrepares++; return { text: "task", images: [], release: () => { releases++; } }; },
      prepareResume: async () => { resumedPrepares++; return { text: compaction ? "checkpoint" : "continue task", images: [], release: () => { releases++; } }; },
      onTextDelta: (delta: string) => deltas.push(delta),
    }, "owned-surface", page, retained);
    expect(answer).toBe("done");
    expect(deltas.join("")).toBe("done");
    expect(sends).toBe(1);
    expect(recoveries).toBe(1);
    expect(releases).toBe(1);
    expect(attachments).toBe(1);
    expect(bindings).toBe(localTools ? 1 : 0);
    expect(freshPrepares).toBe(retained ? 0 : 1);
    expect(resumedPrepares).toBe(retained ? 1 : 0);
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
});

test("cancellation during rebind wins over a valid recovered surface", async () => {
  const f = fixture();
  const controller = new AbortController();
  await expect(f.worker.recoverBoundAssistantObservation(f.page.url(), f.baseline, f.binding, 1,
    new ChatGptBrowserObservationTimeoutError(5), async () => {
      controller.abort();
      return { page: f.page, baseline: f.baseline };
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("terminal and arbitrary consumer errors are not observation disconnects", () => {
  for (const error of [new Error("Target page has been closed"), new DOMException("aborted", "AbortError"),
    new Error("ChatGPT web turn timed out"), new TypeError("consumer callback failed")]) {
    expect(isChatGptObservationDisconnect(error)).toBe(false);
  }
});
