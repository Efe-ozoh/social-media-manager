import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createImageStore,
  keyFromPublicUrl,
  localUploadKeyFromUrl,
  localUploadPath,
  LocalDiskImageStore,
  sanitizeKey,
} from "./image-store";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codesync-images-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("LocalDiskImageStore", () => {
  it("writes the file under the root and returns a localhost URL", async () => {
    const root = await makeTempRoot();
    const store = new LocalDiskImageStore({ root, baseUrl: "http://localhost:3000" });

    const url = await store.put(Buffer.from("png-bytes"), "posts/p1/abc/slide-1.png");

    expect(url).toBe("http://localhost:3000/uploads/posts/p1/abc/slide-1.png");
    const onDisk = await readFile(path.join(root, "posts/p1/abc/slide-1.png"));
    expect(onDisk.toString()).toBe("png-bytes");
  });

  it("creates nested directories and writes every slide of a carousel", async () => {
    const root = await makeTempRoot();
    const store = new LocalDiskImageStore({ root, baseUrl: "http://localhost:3000/" });

    const urls = await Promise.all([
      store.put(Buffer.from("one"), "posts/p1/abc/slide-1.png"),
      store.put(Buffer.from("two"), "posts/p1/abc/slide-2.png"),
    ]);

    expect(urls).toEqual([
      "http://localhost:3000/uploads/posts/p1/abc/slide-1.png",
      "http://localhost:3000/uploads/posts/p1/abc/slide-2.png",
    ]);
    expect((await stat(path.join(root, "posts/p1/abc/slide-2.png"))).isFile()).toBe(true);
  });

  it("delete removes the file and is safe to repeat", async () => {
    const root = await makeTempRoot();
    const store = new LocalDiskImageStore({ root });

    await store.put(Buffer.from("x"), "posts/p1/a/slide-1.png");
    await store.delete("posts/p1/a/slide-1.png");
    await expect(stat(path.join(root, "posts/p1/a/slide-1.png"))).rejects.toThrow();

    // A missing object is not an error, so cleanup can be retried.
    await expect(store.delete("posts/p1/a/slide-1.png")).resolves.toBeUndefined();
  });

  it("refuses keys that could escape the upload directory", async () => {
    const root = await makeTempRoot();
    const store = new LocalDiskImageStore({ root });

    for (const key of ["../escape.png", "posts/../../escape.png", "a\\b.png", "", "a b.png"]) {
      await expect(store.put(Buffer.from("x"), key)).rejects.toThrow();
    }
    expect(sanitizeKey("posts//p1/slide.png")).toBe("posts/p1/slide.png");
    expect(sanitizeKey("/posts/p1/slide.png")).toBe("posts/p1/slide.png");
  });
});

describe("createImageStore", () => {
  it("uses local disk when BLOB_READ_WRITE_TOKEN is unset", () => {
    const store = createImageStore({ env: {} });
    expect(store.kind).toBe("local-disk");
  });

  it("uses Vercel Blob when a token is set", () => {
    const store = createImageStore({ env: { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test" } });
    expect(store.kind).toBe("vercel-blob");
  });

  it("ignores a blank token", () => {
    const store = createImageStore({ env: { BLOB_READ_WRITE_TOKEN: "  " } });
    expect(store.kind).toBe("local-disk");
  });
});

describe("keyFromPublicUrl", () => {
  it("recovers the key from a local URL", () => {
    expect(
      keyFromPublicUrl("http://localhost:3000/uploads/posts/p1/abc/slide-1.png"),
    ).toBe("posts/p1/abc/slide-1.png");
  });

  it("recovers the key (with random suffix) from a Blob URL", () => {
    expect(
      keyFromPublicUrl(
        "https://store123.public.blob.vercel-storage.com/posts/p1/abc/slide-1-x8f2kd.png",
      ),
    ).toBe("posts/p1/abc/slide-1-x8f2kd.png");
  });

  it("returns null for URLs it did not produce", () => {
    expect(keyFromPublicUrl("https://example.com/posts/p1/slide-1.png")).toBeNull();
    expect(keyFromPublicUrl("http://localhost:3000/other/slide-1.png")).toBeNull();
    expect(keyFromPublicUrl("not a url")).toBeNull();
  });

  it("rejects traversal hidden in a URL", () => {
    expect(keyFromPublicUrl("http://localhost:3000/uploads/../secret.png")).toBeNull();
    expect(keyFromPublicUrl("http://localhost:3000/uploads/%2e%2e/secret.png")).toBeNull();
  });
});

describe("localUploadKeyFromUrl", () => {
  it("recovers a key only from local-store URLs", () => {
    expect(
      localUploadKeyFromUrl("http://localhost:3000/uploads/posts/p1/abc/slide-1.jpg"),
    ).toBe("posts/p1/abc/slide-1.jpg");

    expect(
      localUploadKeyFromUrl(
        "https://store123.public.blob.vercel-storage.com/posts/p1/abc/slide-1.jpg",
      ),
    ).toBeNull();
    expect(localUploadKeyFromUrl("https://example.com/posts/p1/slide-1.jpg")).toBeNull();
    expect(localUploadKeyFromUrl("not a url")).toBeNull();
  });

  it("rejects traversal and non-http URLs instead of mapping them to disk", () => {
    expect(localUploadKeyFromUrl("http://localhost:3000/uploads/../secret.png")).toBeNull();
    expect(localUploadKeyFromUrl("http://localhost:3000/uploads/%2e%2e/secret.png")).toBeNull();
    expect(localUploadKeyFromUrl("file:///uploads/posts/p1/slide-1.jpg")).toBeNull();
  });
});

describe("localUploadPath", () => {
  it("maps a key inside the configured upload root and rejects escapes", async () => {
    const root = await makeTempRoot();

    expect(localUploadPath("posts/p1/slide-1.jpg", { root })).toBe(
      path.join(root, "posts/p1/slide-1.jpg"),
    );
    expect(() => localUploadPath("../secret.png", { root })).toThrow();
    expect(() => localUploadPath("a\\b.png", { root })).toThrow();
  });
});
