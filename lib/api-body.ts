/**
 * Reads and size-limits a JSON request body before parsing it.
 *
 * The declared Content-Length is refused before buffering, and the real byte
 * length is checked again afterwards because a client can omit or lie about
 * the header.
 */

import { MAX_BODY_BYTES } from "./preview-request";

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<JsonBodyResult> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, status: 413, error: `Request body is too large (${maxBytes} bytes max).` };
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, status: 400, error: "Could not read the request body." };
  }

  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { ok: false, status: 413, error: `Request body is too large (${maxBytes} bytes max).` };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON body." };
  }
}
