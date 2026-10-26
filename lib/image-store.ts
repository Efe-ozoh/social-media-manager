/**
 * Slide image storage — SPEC section 8, "Rendering and storage".
 *
 * Uploads go to Vercel Blob when BLOB_READ_WRITE_TOKEN is set, and otherwise
 * to a git-ignored folder under public/uploads that Next serves in
 * development. Callers only depend on the two-method ImageStore interface.
 *
 * Vercel Blob usage follows the current SDK (v2): `put(pathname, body, {
 * access: "public", addRandomSuffix: true })` gives every slide a random,
 * unguessable public URL, and `del()` accepts the stored pathname.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { BlobNotFoundError, del, put } from "@vercel/blob";

export type ImageStoreKind = "vercel-blob" | "local-disk";

export interface ImageStore {
  /** Which backend this is, for logs and diagnostics. */
  readonly kind: ImageStoreKind;
  /**
   * Uploads `buffer` under `key` and returns the public URL.
   * `key` is a relative path such as `posts/<postId>/<hash>/slide-1.png`.
   */
  put(buffer: Buffer | Uint8Array, key: string): Promise<string>;
  /**
   * Deletes the object stored under `key`. Idempotent: a missing object is
   * not an error, so a retried cleanup can never fail a render.
   */
  delete(key: string): Promise<void>;
}

/** Where the local backend writes, relative to the app root. */
export const LOCAL_UPLOAD_SEGMENT = "uploads";

/** Host used by public Vercel Blob URLs. */
const VERCEL_BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

const MAX_KEY_LENGTH = 240;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

/**
 * Validates a storage key and returns it without leading or doubled slashes.
 * Keys are pathnames inside one store, so anything that could escape that
 * namespace (traversal, absolute paths, backslashes) is rejected.
 */
export function sanitizeKey(key: string): string {
  const normalized = key.replace(/^\/+/, "").replace(/\/{2,}/g, "/");

  if (normalized.length === 0) throw new Error("image key must not be empty");
  if (normalized.length > MAX_KEY_LENGTH) {
    throw new Error(`image key is too long (${MAX_KEY_LENGTH} characters max)`);
  }
  if (normalized.includes("..") || normalized.includes("\\") || normalized.includes("\0")) {
    throw new Error("image key must not contain '..', backslashes or null bytes");
  }
  if (!KEY_PATTERN.test(normalized)) {
    throw new Error("image key may only contain letters, digits, '.', '_', '-' and '/'");
  }
  if (normalized.endsWith("/")) throw new Error("image key must name a file");
  return normalized;
}

/**
 * Recovers the storage key from a public URL this module produced, so a
 * re-render can delete what the previous render uploaded. Returns null for
 * URLs that are not ours.
 */
export function keyFromPublicUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }

  let key: string | null = null;
  if (parsed.protocol === "https:" && parsed.hostname.endsWith(VERCEL_BLOB_HOST_SUFFIX)) {
    key = pathname;
  } else if (pathname.startsWith(`${LOCAL_UPLOAD_SEGMENT}/`)) {
    key = pathname.slice(LOCAL_UPLOAD_SEGMENT.length + 1);
  }
  if (key === null) return null;

  try {
    return sanitizeKey(key);
  } catch {
    return null;
  }
}

/**
 * Development backend: writes into `public/uploads` (git-ignored) and returns
 * a URL on APP_URL. `next dev` serves files added at runtime; a production
 * build snapshots public/, so production needs BLOB_READ_WRITE_TOKEN.
 */
export class LocalDiskImageStore implements ImageStore {
  readonly kind = "local-disk" as const;

  private readonly root: string;
  private readonly baseUrl: string;

  constructor(options: { root?: string; baseUrl?: string } = {}) {
    this.root = path.resolve(
      options.root ?? path.join(process.cwd(), "public", LOCAL_UPLOAD_SEGMENT),
    );
    this.baseUrl = (options.baseUrl ?? process.env.APP_URL ?? "http://localhost:3000").replace(
      /\/+$/,
      "",
    );
  }

  async put(buffer: Buffer | Uint8Array, key: string): Promise<string> {
    const safe = sanitizeKey(key);
    const file = this.resolve(safe);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buffer);
    return `${this.baseUrl}/${LOCAL_UPLOAD_SEGMENT}/${safe}`;
  }

  async delete(key: string): Promise<void> {
    // force: true makes this idempotent, like the Blob backend.
    await rm(this.resolve(sanitizeKey(key)), { force: true });
  }

  private resolve(safeKey: string): string {
    const file = path.resolve(this.root, safeKey);
    if (!file.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("image key resolves outside the upload directory");
    }
    return file;
  }
}

/** Production backend: public Vercel Blob objects with random suffixes. */
export class VercelBlobImageStore implements ImageStore {
  readonly kind = "vercel-blob" as const;

  constructor(private readonly token?: string) {}

  async put(buffer: Buffer | Uint8Array, key: string): Promise<string> {
    // The SDK accepts Buffer; normalise anything else it might be handed.
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const blob = await put(sanitizeKey(key), body, {
      // SPEC: public slides, and an unguessable suffix on every upload.
      access: "public",
      addRandomSuffix: true,
      contentType: "image/png",
      token: this.token,
    });
    return blob.url;
  }

  async delete(key: string): Promise<void> {
    try {
      // The SDK accepts a pathname, and only this store's token can delete.
      await del(sanitizeKey(key), { token: this.token });
    } catch (error) {
      // Already gone (or a retried cleanup): not an error.
      if (!(error instanceof BlobNotFoundError)) throw error;
    }
  }
}

/**
 * Picks the backend from the environment: Blob when a token exists, local
 * disk otherwise. `env` is injectable so tests never read the real env.
 */
export function createImageStore(
  options: { env?: Record<string, string | undefined> } = {},
): ImageStore {
  const env = options.env ?? process.env;
  const token = env.BLOB_READ_WRITE_TOKEN?.trim();
  if (token) return new VercelBlobImageStore(token);
  return new LocalDiskImageStore({ baseUrl: env.APP_URL });
}
