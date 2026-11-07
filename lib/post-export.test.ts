import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const download = vi.hoisted(() => vi.fn());

vi.mock("./publishers/slide-download", () => ({
  downloadSlide: (...args: unknown[]) => download(...args),
}));

import { readSlides, toArrayBuffer, zipSlides } from "./post-export";

const ID = "b1946ac9-2f6c-4e1b-9d5a-0f2f4a7c8d3e";
const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(() => {
  download.mockReset();
});

describe("readSlides", () => {
  it("numbers and names slides in order, even when rows arrive unsorted", async () => {
    download.mockImplementation(async (url: string) => ({
      bytes: bytes(url),
      source: "local-disk",
    }));

    const slides = await readSlides(ID, [
      { slideIndex: 1, url: "https://cdn.example.com/two.jpg" },
      { slideIndex: 0, url: "https://cdn.example.com/one.jpg" },
    ]);

    expect(slides.map((slide) => slide.slideNumber)).toEqual([1, 2]);
    expect(slides.map((slide) => slide.fileName)).toEqual([
      "post-b1946ac9-slide-1.jpg",
      "post-b1946ac9-slide-2.jpg",
    ]);
    expect(new TextDecoder().decode(slides[0].bytes)).toBe(
      "https://cdn.example.com/one.jpg",
    );
  });

  it("propagates a read failure so the route can answer with an error", async () => {
    download.mockRejectedValue(new Error("storage is down"));

    await expect(readSlides(ID, [{ slideIndex: 0, url: "https://x/y.jpg" }])).rejects.toThrow(
      "storage is down",
    );
  });
});

describe("zipSlides", () => {
  it("puts one entry per slide under its download name", () => {
    const zip = zipSlides([
      { slideNumber: 1, fileName: "post-b1946ac9-slide-1.jpg", bytes: bytes("first") },
      { slideNumber: 2, fileName: "post-b1946ac9-slide-2.jpg", bytes: bytes("second") },
    ]);

    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      "post-b1946ac9-slide-1.jpg",
      "post-b1946ac9-slide-2.jpg",
    ]);
    expect(new TextDecoder().decode(entries["post-b1946ac9-slide-1.jpg"])).toBe("first");
    expect(new TextDecoder().decode(entries["post-b1946ac9-slide-2.jpg"])).toBe("second");
  });

  it("round-trips bytes that are not valid UTF-8", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0x80]);
    const zip = zipSlides([
      { slideNumber: 1, fileName: "slide.jpg", bytes: jpeg },
    ]);

    expect(Array.from(unzipSync(zip)["slide.jpg"])).toEqual(Array.from(jpeg));
  });
});

describe("toArrayBuffer", () => {
  it("copies the bytes into a standalone buffer", () => {
    const source = new Uint8Array([1, 2, 3]);
    const buffer = toArrayBuffer(source);

    expect(buffer.byteLength).toBe(3);
    expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3]);
  });
});
