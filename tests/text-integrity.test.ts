import { afterEach, expect, test } from "bun:test";
import {
  chatGptTextIntegrityFingerprint,
  reportChatGptTextIntegrity,
} from "../src/adapters/chatgpt-web/text-integrity";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";

const originalDiagnostics = process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY;

afterEach(() => {
  if (originalDiagnostics === undefined) delete process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY;
  else process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY = originalDiagnostics;
});

test("text-integrity fingerprints expose only hashes, sizes, lines and marker classes", () => {
  const marker = "BODY_MIDDLE_case_7f3a";
  const secret = "private-body-sentinel-never-log";
  const fingerprint = chatGptTextIntegrityFingerprint(`heading\n${marker}\n${secret}`);
  const serialized = JSON.stringify(fingerprint);

  expect(fingerprint).toMatchObject({ utf16Chars: 61, codePoints: 61, lines: 3 });
  expect(fingerprint.utf8Bytes).toBe(61);
  expect(fingerprint.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(fingerprint.markers).toEqual([{
    kind: "BODY_MIDDLE",
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    count: 1,
  }]);
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toContain(secret);
});

test("text-integrity reporting is opt-in and never writes prompt text", () => {
  const originalInfo = console.info;
  const lines: string[] = [];
  console.info = (...values: unknown[]) => { lines.push(values.join(" ")); };
  try {
    delete process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY;
    reportChatGptTextIntegrity("abcdef123456", "responses_input", [{
      name: "body",
      text: "TITLE_MARKER_private private-body",
    }]);
    expect(lines).toEqual([]);

    process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY = "1";
    reportChatGptTextIntegrity("abcdef123456", "responses_input", [{
      name: "body",
      text: "TITLE_MARKER_private private-body",
    }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"boundary":"responses_input"');
    expect(lines[0]).toContain('"kind":"TITLE_MARKER"');
    expect(lines[0]).not.toContain("TITLE_MARKER_private");
    expect(lines[0]).not.toContain("private-body");
  } finally {
    console.info = originalInfo;
  }
});

test("title and body markers survive Responses parsing and prompt compilation", () => {
  const title = "TITLE_MARKER_71c9";
  const begin = "BODY_BEGIN_2a44";
  const middle = "BODY_MIDDLE_5e10";
  const end = "BODY_END_99bd";
  const body = {
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    input: [{
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `${title}\n\n${begin}\nFirst paragraph with punctuation: á, 漢字, \"quotes\".\n\n${middle}\nSecond paragraph.\n\n${end}`,
      }],
    }],
  };
  const parsed = parseRequest(body);
  const compiled = compileChatGptWebPrompt(parsed, {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true,
    proAvailable: true,
  });
  const markers = [title, begin, middle, end];

  const rawFingerprint = chatGptTextIntegrityFingerprint(JSON.stringify(body));
  const parsedFingerprint = chatGptTextIntegrityFingerprint(JSON.stringify(parsed.context.messages));
  const compiledFingerprint = chatGptTextIntegrityFingerprint(compiled.text);
  for (const marker of markers) {
    expect(JSON.stringify(parsed.context.messages).match(new RegExp(marker, "g"))).toHaveLength(1);
    expect(compiled.text.match(new RegExp(marker, "g"))).toHaveLength(1);
  }
  expect(parsedFingerprint.markers).toEqual(rawFingerprint.markers);
  expect(compiledFingerprint.markers).toEqual(rawFingerprint.markers);
});

test("text-integrity accepts the owned compaction fallback trace id without exposing prompt text", () => {
  const originalInfo = console.info;
  const originalDiagnostics = process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY;
  const lines: string[] = [];
  console.info = (...values: unknown[]) => { lines.push(values.join(" ")); };
  try {
    process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY = "1";

    expect(() => reportChatGptTextIntegrity(
      "abcdef123456_fallback",
      "compiled_prompt",
      [{
        name: "body",
        text: "BODY_BEGIN_fallback_probe private-fallback-sentinel",
      }],
    )).not.toThrow();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"traceId":"abcdef123456_fallback"');
    expect(lines[0]).toContain('"kind":"BODY_BEGIN"');
    expect(lines[0]).not.toContain("BODY_BEGIN_fallback_probe");
    expect(lines[0]).not.toContain("private-fallback-sentinel");
  } finally {
    console.info = originalInfo;
  }
});

test("text-integrity ignores untrusted trace ids instead of affecting production", () => {
  const originalInfo = console.info;
  const originalDiagnostics = process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY;
  const lines: string[] = [];
  console.info = (...values: unknown[]) => { lines.push(values.join(" ")); };
  try {
    process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY = "1";

    expect(() => reportChatGptTextIntegrity(
      "unsafe-trace-id-with-user-content",
      "compiled_prompt",
      [{
        name: "body",
        text: "BODY_BEGIN_untrusted secret-never-log",
      }],
    )).not.toThrow();

    expect(lines).toEqual([]);
  } finally {
    console.info = originalInfo;
  }
});

test("text-integrity ignores invalid boundaries instead of affecting production", () => {
  const originalInfo = console.info;
  const originalDiagnostics = process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY;
  const lines: string[] = [];
  console.info = (...values: unknown[]) => { lines.push(values.join(" ")); };
  try {
    process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY = "1";

    expect(() => reportChatGptTextIntegrity(
      "abcdef123456",
      "compiled prompt unsafe",
      [{
        name: "body",
        text: "BODY_BEGIN_boundary secret-never-log",
      }],
    )).not.toThrow();

    expect(lines).toEqual([]);
  } finally {
    console.info = originalInfo;
  }
});

test("text-integrity logger failures never affect production", () => {
  const originalInfo = console.info;
  const originalDiagnostics = process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY;
  try {
    process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY = "1";

    console.info = () => {
      throw new Error("simulated diagnostic logger failure");
    };

    expect(() => reportChatGptTextIntegrity(
      "abcdef123456_fallback",
      "compiled_prompt",
      [{
        name: "body",
        text: "BODY_BEGIN_logger secret-never-log",
      }],
    )).not.toThrow();
  } finally {
    console.info = originalInfo;
  }
});
