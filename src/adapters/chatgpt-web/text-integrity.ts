import { createHash } from "node:crypto";
import type { CompiledChatGptWebPrompt } from "./prompt";

const SYNTHETIC_MARKER = /\b(TITLE_MARKER|BODY_BEGIN|BODY_MIDDLE|BODY_END)_[A-Za-z0-9_-]+\b/g;

export function chatGptTextIntegrityDiagnosticsEnabled(): boolean {
  return process.env.CODEX_CHATGPT_WEB_TEXT_INTEGRITY === "1";
}

export interface ChatGptTextIntegrityFingerprint {
  sha256: string;
  utf8Bytes: number;
  utf16Chars: number;
  codePoints: number;
  lines: number;
  markers: Array<{ kind: string; sha256: string; count: number }>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function chatGptTextIntegrityFingerprint(text: string): ChatGptTextIntegrityFingerprint {
  const markerCounts = new Map<string, { kind: string; sha256: string; count: number }>();
  for (const match of text.matchAll(SYNTHETIC_MARKER)) {
    const marker = match[0];
    const kind = match[1]!;
    const digest = sha256(marker);
    const key = `${kind}:${digest}`;
    const existing = markerCounts.get(key);
    if (existing) existing.count += 1;
    else markerCounts.set(key, { kind, sha256: digest, count: 1 });
  }
  return {
    sha256: sha256(text),
    utf8Bytes: Buffer.byteLength(text, "utf8"),
    utf16Chars: text.length,
    codePoints: [...text].length,
    lines: text.length === 0 ? 0 : text.split("\n").length,
    markers: [...markerCounts.values()].sort((left, right) => (
      left.kind.localeCompare(right.kind) || left.sha256.localeCompare(right.sha256)
    )),
  };
}

export function reportChatGptTextIntegrity(
  traceId: string,
  boundary: string,
  segments: ReadonlyArray<{ name: string; text: string }>,
  detail?: Record<string, string | number | boolean | null>,
): void {
  if (!chatGptTextIntegrityDiagnosticsEnabled()) return;
  if (!/^[a-f0-9]{12}$/.test(traceId)) throw new Error("ChatGPT text-integrity trace id is invalid");
  if (!/^[a-z0-9_]+$/.test(boundary)) throw new Error("ChatGPT text-integrity boundary is invalid");
  console.info(`[chatgpt-web] text-integrity ${JSON.stringify({
    version: 1,
    traceId,
    boundary,
    segments: segments.map(segment => ({
      name: segment.name,
      ...chatGptTextIntegrityFingerprint(segment.text),
    })),
    ...(detail ? { detail } : {}),
  })}`);
}

export function reportCompiledChatGptPromptIntegrity(
  traceId: string,
  boundary: string,
  prompt: CompiledChatGptWebPrompt,
): void {
  reportChatGptTextIntegrity(traceId, boundary, [
    { name: "text", text: prompt.text },
    ...(prompt.multipart?.parts.map((text, index) => ({
      name: `multipart_part_${index + 1}`,
      text,
    })) ?? []),
    ...(prompt.multipart ? [{ name: "multipart_commit", text: prompt.multipart.commit }] : []),
  ], {
    images: prompt.images.length,
    skillFiles: prompt.skillFiles?.length ?? 0,
    multipartParts: prompt.multipart?.parts.length ?? 0,
  });
}
