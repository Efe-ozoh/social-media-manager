import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadSlide } from "./slide-download";
import { PublishError } from "./types";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codesync-slides-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function mockFetch(response: Response | (() => never)): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (resource: RequestInfo | URL) => {
    const url =
      typeof resource === "string"
        ? resource
        : resource instanceof URL
          ? resource.toString()
          : resource.url;
    calls.push(url);
    if (typeof response === "function") return response();
    return response;
  }) as typeof fetch;

  return { fetchImpl, calls };
}

describe("downloadSlide", () => {
  it("reads a local-store URL from disk without fetching it over HTTP", async () => {
    const root = await makeTempRoot();
    const key = "posts/p1/abc/slide-1.jpg";
    await mkdir(path.join(root, path.dirname(key)), { recursive: true });
    await writeFile(path.join(root, key), JPEG);

    const { fetchImpl, calls } = mockFetch(() => {
      throw new Error("fetch should not be called for a local slide");
    });

    const result = await downloadSlide(`http://localhost:3000/uploads/${key}`, {
      platform: "telegram",
      label: "Slide 1",
      fetchImpl,
      localUploadRoot: root,
    });

    expect(result.source).toBe("local-disk");
    expect(result.bytes).toEqual(JPEG);
    expect(calls).toHaveLength(0);
  });

  it("fetches Vercel Blob and other non-local URLs unchanged", async () => {
    const { fetchImpl, calls } = mockFetch(
      new Response(new Uint8Array(JPEG), { headers: { "content-type": "image/jpeg" } }),
    );
    const url =
      "https://store123.public.blob.vercel-storage.com/posts/p1/abc/slide-1-x8f2kd.jpg";

    const result = await downloadSlide(url, {
      platform: "linkedin",
      label: "Slide 1",
      fetchImpl,
    });

    expect(result.source).toBe("http");
    expect(result.bytes).toEqual(JPEG);
    expect(calls).toEqual([url]);
  });

  it("does not map traversal URLs to local files", async () => {
    const parent = await makeTempRoot();
    const root = path.join(parent, "uploads");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(parent, "secret.jpg"), "secret");
    const { fetchImpl, calls } = mockFetch(new Response(new Uint8Array(JPEG)));

    const result = await downloadSlide(
      "http://localhost:3000/uploads/%2e%2e/secret.jpg",
      {
        platform: "telegram",
        label: "Slide 1",
        fetchImpl,
        localUploadRoot: root,
      },
    );

    expect(result.source).toBe("http");
    expect(result.bytes).toEqual(JPEG);
    expect(calls).toHaveLength(1);
  });

  it("reports a missing local file without falling back to HTTP", async () => {
    const root = await makeTempRoot();
    const { fetchImpl, calls } = mockFetch(new Response(new Uint8Array(JPEG)));

    await expect(
      downloadSlide("http://localhost:3000/uploads/posts/missing.jpg", {
        platform: "telegram",
        label: "Slide 1",
        fetchImpl,
        localUploadRoot: root,
      }),
    ).rejects.toBeInstanceOf(PublishError);

    expect(calls).toHaveLength(0);
  });

  it("keeps the HTTP error mapping for remote slides", async () => {
    const { fetchImpl } = mockFetch(new Response("no", { status: 503 }));

    try {
      await downloadSlide("https://cdn.example.com/slide.jpg", {
        platform: "linkedin",
        label: "Slide 1",
        fetchImpl,
      });
      throw new Error("expected the download to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PublishError);
      expect((error as PublishError).retryable).toBe(true);
      expect((error as PublishError).message).toContain("could not be downloaded");
    }
  });
});
