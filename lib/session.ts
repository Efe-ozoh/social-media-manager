// Minimal single-user session: an HMAC-SHA256 signed cookie.
// Uses Web Crypto only, so it runs in both the Node.js and Edge runtimes
// (middleware included).

export const SESSION_COOKIE = "codesync_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type SessionPayload = {
  sub: "owner";
  iat: number;
  exp: number;
};

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The configured secret, or null when auth is not set up yet. */
export function getAuthSecret(): string | null {
  const secret = process.env.AUTH_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

export async function createSessionToken(
  secret: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const payload: SessionPayload = { sub: "owner", iat, exp: iat + SESSION_TTL_SECONDS };
  const encoded = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(encoded));
  return `${encoded}.${base64urlEncode(new Uint8Array(signature))}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
  secret: string | null = getAuthSecret(),
): Promise<boolean> {
  if (!token || !secret) return false;

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;

  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecode(signature),
      encoder.encode(encoded),
    );
    if (!valid) return false;

    const payload = JSON.parse(decoder.decode(base64urlDecode(encoded))) as SessionPayload;
    return (
      payload.sub === "owner" &&
      typeof payload.exp === "number" &&
      payload.exp * 1000 > Date.now()
    );
  } catch {
    return false;
  }
}
