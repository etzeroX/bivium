const MAX_ENCODED_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_REQUEST_BYTES = 128 * 1024 * 1024;

function assertWithinLimit(bytes: number, limit: number, label: string): void {
  if (bytes > limit) throw new Error(`${label} exceeds ${limit} bytes`);
}

export interface ReadJsonRequestBody {
  value: unknown;
  /** Exact wire bytes, retained only when a routed native request must be forwarded verbatim. */
  encodedBody: ArrayBuffer;
}

export async function decodeJsonRequestBody(encodedBody: ArrayBuffer, headers: Headers): Promise<unknown> {
  const encoded = new Uint8Array(encodedBody);
  assertWithinLimit(encoded.byteLength, MAX_ENCODED_REQUEST_BYTES, "Encoded request body");

  const contentEncoding = (headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  let decoded: Uint8Array;
  if (contentEncoding === "" || contentEncoding === "identity") {
    decoded = encoded;
  } else if (contentEncoding === "zstd") {
    decoded = await Bun.zstdDecompress(encoded);
  } else {
    throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`);
  }
  assertWithinLimit(decoded.byteLength, MAX_DECODED_REQUEST_BYTES, "Decoded request body");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  return JSON.parse(text) as unknown;
}

export async function readJsonRequestBodyWithEncoded(request: Request): Promise<ReadJsonRequestBody> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength)) {
    assertWithinLimit(declaredLength, MAX_ENCODED_REQUEST_BYTES, "Encoded request body");
  }

  const encodedBody = await request.arrayBuffer();
  return { value: await decodeJsonRequestBody(encodedBody, request.headers), encodedBody };
}

export async function readJsonRequestBody(request: Request): Promise<unknown> {
  return (await readJsonRequestBodyWithEncoded(request)).value;
}
