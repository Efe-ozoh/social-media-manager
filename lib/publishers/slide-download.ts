/**
 * Shared slide download for publishers that upload image bytes themselves.
 *
 * A local-disk image store writes slides under public/uploads and publishes a
 * URL on APP_URL. Reading that file directly means local publishing tests do
 * not need `npm run dev` running just to serve the slide back over HTTP.
 * Anything that is not a local-store URL — a Vercel Blob URL in particular —
 * is fetched exactly as before.
 */

import { readFile } from "node:fs/promises";
import { localUploadKeyFromUrl, localUploadPath } from "@/lib/image-store";
import { PublishError, type PlatformName } from "./types";

export type SlideDownloadOptions = {
  platform: PlatformName;
  label: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Test override for the local-disk root. */
  localUploadRoot?: string;
};

export type SlideDownload = {
  bytes: Uint8Array;
  source: "local-disk" | "http";
};

const DEFAULT_TIMEOUT_MS = 20_000;

function emptySlide(platform: PlatformName, label: string): PublishError {
  return new PublishError({
    code: "provider_error",
    platform,
    message: `${label} downloaded as an empty file. This will be retried.`,
  });
}

/**
 * Returns the bytes for one slide. Local-store URLs are read from disk with
 * the store's key-to-path mapping and traversal guard; every other URL is
 * fetched over HTTP, so Vercel Blob keeps its current path.
 */
export async function downloadSlide(
  url: string,
  options: SlideDownloadOptions,
): Promise<SlideDownload> {
  const { platform, label } = options;
  const localKey = localUploadKeyFromUrl(url);

  if (localKey !== null) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        await readFile(localUploadPath(localKey, { root: options.localUploadRoot })),
      );
    } catch {
      throw new PublishError({
        code: "provider_error",
        platform,
        message:
          `${label} could not be read from the local image store. ` +
          "Check that public/uploads still holds the slide.",
        retryable: false,
      });
    }
    if (bytes.byteLength === 0) throw emptySlide(platform, label);
    return { bytes, source: "local-disk" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw PublishError.network(
      platform,
      `${label} could not be downloaded from the image store. This will be retried.`,
    );
  }

  if (!response.ok) {
    throw PublishError.fromStatus(
      response.status,
      `${label} could not be downloaded from the image store (HTTP ${response.status}).`,
      { platform },
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw emptySlide(platform, label);
  return { bytes, source: "http" };
}
