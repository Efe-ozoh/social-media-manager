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

const POST_ID = "b1946ac9-2f6c-4e1b-9d5a-0f2f4a7c8d3e";

function fakePrisma(post: unknown) {
  return { post: { findUnique: vi.fn(async () => post) } };
}

function call(id = POST_ID, slide = "2") {
  return GET(new NextRequest("http://localhost:3000/x"), {
    params: Promise.resolve({ id, slide }),
  });
}

beforeEach(() => {
  state.prisma = undefined;
  state.download.mockReset();
});

describe("GET /api/posts/[id]/export/slide/[slide]", () => {
  it("rejects a bad post id and a bad slide number", async () => {
    expect((await call("nope")).status).toBe(400);
    expect((await call(POST_ID, "0")).status).toBe(400);
    expect((await call(POST_ID, "abc")).status).toBe(400);
  });

  it("reports a missing post and a missing slide", async () => {
    state.prisma = fakePrisma(null);
    expect((await call()).status).toBe(404);

    state.prisma = fakePrisma({ id: POST_ID, media: [] });
    expect((await call()).status).toBe(404);
  });

  it("serves the slide as a JPEG with a readable file name", async () => {
    state.prisma = fakePrisma({
      id: POST_ID,
      media: [{ slideIndex: 1, url: "https://cdn.example.com/two.jpg" }],
    });
    state.download.mockResolvedValue({
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      source: "http",
    });

    const response = await call();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="post-b1946ac9-slide-2.jpg"',
    );
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([
      0xff, 0xd8, 0xff,
    ]);
  });

  it("answers 502 when the slide cannot be read", async () => {
    state.prisma = fakePrisma({
      id: POST_ID,
      media: [{ slideIndex: 1, url: "https://cdn.example.com/two.jpg" }],
    });
    state.download.mockRejectedValue(new Error("storage down"));

    const response = await call();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "Could not read that slide from storage.",
    });
  });
});
