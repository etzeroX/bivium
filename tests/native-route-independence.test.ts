import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import type { NativeFetch } from "../src/native-passthrough";

function nativeRequest(model = "gpt-5.6-sol"): Request {
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-native-auth",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, stream: true, input: [] }),
  });
}

const nativeUpstream: NativeFetch = async request => {
  expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(request.headers.get("authorization")).toBe("Bearer codex-native-auth");
  return new Response("data: native\n\ndata: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
};

describe("native route independence", () => {
  for (const mode of ["browser-only", "full"] as const) {
    test(`native request bypasses browser, local tools, and tunnel in ${mode} mode`, async () => {
      const config = defaultConfig(mode);
      let adapterConstructions = 0;
      const response = await responseRequest(nativeRequest(), config, () => {
        adapterConstructions += 1;
        throw new Error("native request must not construct the browser adapter");
      }, {
        rememberState: false,
        fetchNativeUpstream: nativeUpstream,
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("data: native\n\ndata: [DONE]\n\n");
      expect(adapterConstructions).toBe(0);
      // Full mode has deliberately not been given tunnel settings: native forwarding is upstream-
      // only and must remain usable when the optional local-tools tunnel is stopped or absent.
      expect(config.tunnel).toBeUndefined();
    });
  }

  test("switches Web to Native to Web without changing the installed route", async () => {
    const config = defaultConfig("browser-only");
    let webTurns = 0;
    let nativeTurns = 0;
    const adapterFactory = (): ProviderAdapter => ({
      name: "native-independence-web-fixture",
      async runTurn(_parsed, _incoming, emit) {
        webTurns += 1;
        emit({ type: "text_delta", text: `web-${webTurns}`, phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    });
    const fetchNativeUpstream: NativeFetch = async request => {
      nativeTurns += 1;
      return nativeUpstream(request);
    };
    const web = () => responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/high",
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }],
      }),
    }), config, adapterFactory, { rememberState: false, fetchNativeUpstream });

    expect((await (await web()).json() as { status: string }).status).toBe("completed");
    expect(await (await responseRequest(nativeRequest(), config, adapterFactory, {
      rememberState: false,
      fetchNativeUpstream,
    })).text()).toContain("data: native");
    expect((await (await web()).json() as { status: string }).status).toBe("completed");
    expect({ webTurns, nativeTurns }).toEqual({ webTurns: 2, nativeTurns: 1 });
  });
});
