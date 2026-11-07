import { unzipSync } from "fflate";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  prisma: undefined as unknown,
  download: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: () => state.prisma }));

vi.mock("@/lib/publishers/slide-download", () => ({
  downloadSlide: (...args: unknown[]) => state.download(...args),
}));

import { GET } from "./route";

/**
 * The ZIP route reads the post's own post_media rows and nothing else, so the
 * test checks the parts the owner sees: the download name, the ZIP type, and
 * one entry per slide with the slide's own bytes.
 */

const POST_ID = "b1946ac9-2f6c-4e1b-9d5a-0f2f4a7c8d3e";
const bytes = (text: string) => new TextEncoder().encode(text);

function fakePrisma(post: unknown) {
  return { post: { findUnique: vi.fn(async () => post) } };
}

function call(id = POST_ID) {
  return GET(new NextRequest("http://localhost:3000/x"), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  state.prisma = undefined;
  state.download.mockReset();
});

describe("GET /api/posts/[id]/export/zip", () => {
  it("rejects an id that is not a UUID", async () => {
    const response = await call("nope");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid post id." });
  });

  it("reports a missing post as a 404", async () => {
    state.prisma = fakePrisma(null);

    const response = await call();

    expect(response.status).toBe(404);
  });

  it("refuses a post with no saved slides", async () => {
    state.prisma = fakePrisma({ id: POST_ID, media: [] });

    const response = await call();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "This post has no saved slides to export.",
    });
  });

  it("streams a ZIP named after the post, with one entry per slide", async () => {
    state.prisma = fakePrisma({
      id: POST_ID,
      media: [
        { slideIndex: 0, url: "https://cdn.example.com/one.jpg" },
        { slideIndex: 1, url: "https://cdn.example.com/two.jpg" },
      ],
    });
    state.download.mockImplementation(async (url: string) => ({
      bytes: bytes(url),
      source: "http",
    }));

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="post-b1946ac9-slides.zip"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");

    const zip = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get("content-length")).toBe(String(zip.byteLength));

    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      "post-b1946ac9-slide-1.jpg",
      "post-b1946ac9-slide-2.jpg",
    ]);
    expect(new TextDecoder().decode(entries["post-b1946ac9-slide-1.jpg"])).toBe(
      "https://cdn.example.com/one.jpg",
    );

    // Slides are read from the stored URLs, in slide order.
    expect(state.download.mock.calls.map((call) => call[0])).toEqual([
      "https://cdn.example.com/one.jpg",
      "https://cdn.example.com/two.jpg",
    ]);
  });

  it("answers 502 when a slide cannot be read, without leaking storage detail", async () => {
    state.prisma = fakePrisma({
      id: POST_ID,
      media: [{ slideIndex: 0, url: "https://cdn.example.com/one.jpg" }],
    });
    state.download.mockRejectedValue(
      new Error("token=secret-value provider said no"),
    );

    const response = await call();

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Could not read this post's slides from storage.");
    expect(JSON.stringify(body)).not.toContain("secret-value");
  });
});
