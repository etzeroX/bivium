import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { compactRequest, responseRequest } from "../src/server";

for (const endpoint of ["responses", "responses/compact"] as const) {
  for (const scrub of [false, true]) {
    test(`native ${endpoint} preserves encoded bodies or scrubs bridge artifacts (scrub=${scrub})`, async () => {
      const checkpoint = "Retain exact repository state";
      const body = {
        model: "gpt-5.6-sol", stream: false,
        ...(scrub ? { previous_response_id: "resp_local_web_compaction" } : {}),
        input: scrub ? [{ type: "compaction", id: "cmp_11111111111111111111111111111111",
          encrypted_content: `ocx1:${Buffer.from(checkpoint).toString("base64")}` }]
          : [{ type: "message", role: "user", content: [{ type: "input_text", text: "Native task" }] }],
      };
      const bytes = Bun.zstdCompressSync(Buffer.from(JSON.stringify(body)));
      const request = new Request(`http://127.0.0.1/v1/${endpoint}`, {
        method: "POST", headers: { authorization: "Bearer native-auth", "content-type": "application/json",
          "content-encoding": "zstd", "content-length": String(bytes.byteLength) }, body: new Uint8Array(bytes).buffer,
      });
      let requests = 0;
      const handler = endpoint === "responses" ? responseRequest : compactRequest;
      const response = await handler(request, defaultConfig("full"), () => {
        throw new Error("Native path must not construct the browser adapter");
      }, {
        fetchNativeUpstream: async forwarded => {
          requests++;
          expect(forwarded.url).toBe(`https://chatgpt.com/backend-api/codex/${endpoint}`);
          expect(forwarded.headers.get("authorization")).toBe("Bearer native-auth");
          if (scrub) {
            expect(forwarded.headers.get("content-encoding")).toBeNull();
            expect(forwarded.headers.get("content-length")).toBeNull();
            const cleaned = await forwarded.json() as { input: unknown[] };
            expect(cleaned).not.toHaveProperty("previous_response_id");
            expect(JSON.stringify(cleaned)).toContain(checkpoint);
            expect(JSON.stringify(cleaned)).not.toContain("ocx1:");
          } else {
            expect(forwarded.headers.get("content-encoding")).toBe("zstd");
            expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(new Uint8Array(bytes));
          }
          return new Response("native-result");
        },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("native-result");
      expect(requests).toBe(1);
    });
  }
}
