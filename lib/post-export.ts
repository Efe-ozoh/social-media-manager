/**
 * Reading and zipping a post's slides for the manual-export screens.
 *
 * The export routes run on the server, so they can reuse the same slide loader
 * the publishers use: local-disk URLs are read from public/uploads, and
 * anything else (Vercel Blob) is fetched. Nothing here needs a browser, and the
 * owner's caption is never modified.
 */

import { zipSync } from "fflate";
import { slideFileName } from "./export-files";
import { downloadSlide } from "./publishers/slide-download";

export type ExportMediaRow = {
  slideIndex: number;
  url: string;
};

export type ExportedSlide = {
  /** 1-based, matching the file name and what the owner sees. */
  slideNumber: number;
  fileName: string;
  bytes: Uint8Array;
};

export type ReadSlidesOptions = {
  fetchImpl?: typeof fetch;
  localUploadRoot?: string;
};

/** Reads every slide in slide order, named for download. */
export async function readSlides(
  postId: string,
  media: readonly ExportMediaRow[],
  options: ReadSlidesOptions = {},
): Promise<ExportedSlide[]> {
  const ordered = [...media].sort((a, b) => a.slideIndex - b.slideIndex);

  return Promise.all(
    ordered.map(async (row) => {
      const slideNumber = row.slideIndex + 1;
      const { bytes } = await downloadSlide(row.url, {
        platform: "instagram",
        label: `Slide ${slideNumber}`,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.localUploadRoot ? { localUploadRoot: options.localUploadRoot } : {}),
      });

      return { slideNumber, fileName: slideFileName(postId, slideNumber), bytes };
    }),
  );
}

/**
 * Packs the slides into one ZIP, one entry per slide and no folder.
 * JPEGs are already compressed, so level 6 costs little and changes nothing.
 */
export function zipSlides(slides: readonly ExportedSlide[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const slide of slides) entries[slide.fileName] = slide.bytes;

  return zipSync(entries, { level: 6 });
}

/** A Response body needs an ArrayBuffer, not a possibly-shared view. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}
