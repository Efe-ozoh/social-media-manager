import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  keyFromPublicUrl,
  LocalDiskImageStore,
  sanitizeKey,
  type ImageStore,
} from "./image-store";
import {
  deleteStaleImages,
  renderPost,
  type RenderablePost,
} from "./render-post";

const POST_ID = "11111111-1111-4111-8111-111111111111";
const BASE_URL = "http://localhost:3000";

const tempRoots: string[] = [];

async function makeStore(): Promise<{ store: LocalDiskImageStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "codesync-render-"));
  tempRoots.push(root);
  return { store: new LocalDiskImageStore({ root, baseUrl: BASE_URL }), root };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function post(overrides: Partial<RenderablePost> = {}): RenderablePost {
  return {
    id: POST_ID,
    bodyText: "Rendering a post once is enough. The dashboard shows the slides before you schedule anything.",
    code: null,
    contentType: "text",
    language: null,
    backgroundMode: "solid",
    bgUrl: null,
    bgAuthorName: null,
    bgAuthorUrl: null,
    ...overrides,
  };
}

/** Local store that records deletes, for asserting cleanup boundaries. */
class RecordingStore implements ImageStore {
  readonly kind = "local-disk" as const;
  readonly deleted: string[] = [];

  constructor(private readonly inner: ImageStore) {}

  put(buffer: Buffer | Uint8Array, key: string): Promise<string> {
    return this.inner.put(buffer, key);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    await this.inner.delete(key);
  }
}

/** In-memory store that can fail on a chosen upload. */
class MemoryStore implements ImageStore {
  readonly kind = "local-disk" as const;
  readonly files = new Map<string, Buffer>();
  readonly deleted: string[] = [];
  failOnPut = Number.POSITIVE_INFINITY;
  private calls = 0;

  async put(buffer: Buffer | Uint8Array, key: string): Promise<string> {
    this.calls += 1;
    if (this.calls === this.failOnPut) throw new Error("upload failed");
    const safe = sanitizeKey(key);
    this.files.set(safe, Buffer.from(buffer));
    return `${BASE_URL}/uploads/${safe}`;
  }

  async delete(key: string): Promise<void> {
    const safe = sanitizeKey(key);
    this.deleted.push(safe);
    this.files.delete(safe);
  }
}

describe("renderPost", () => {
  it(
    "renders, uploads and returns post_media rows",
    async () => {
      const { store, root } = await makeStore();

      const result = await renderPost(post(), store);

      expect(result.media).toHaveLength(1);
      expect(result.background).toBe("solid");
      expect(result.renderedSlideCount).toBe(result.media.length);

      const row = result.media[0];
      expect(row.slideIndex).toBe(0);
      expect(row.width).toBe(1080);
      expect(row.height).toBe(1350);
      expect(row.url).toMatch(
        new RegExp(`^${BASE_URL}/uploads/posts/${POST_ID}/[0-9a-f]{16}/slide-1\\.png$`),
      );

      const key = keyFromPublicUrl(row.url);
      expect(key).not.toBeNull();
      const bytes = await readFile(path.join(root, key as string));
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    },
    30_000,
  );

  it(
    "is idempotent for unchanged content: same keys, no orphans",
    async () => {
      const { store, root } = await makeStore();

      const first = await renderPost(post(), store);
      const second = await renderPost(post(), store, {
        previousUrls: first.media.map((row) => row.url),
      });

      expect(second.media.map((row) => row.url)).toEqual(first.media.map((row) => row.url));
      expect(second.staleKeys).toEqual([]);

      const key = keyFromPublicUrl(first.media[0].url) as string;
      const dir = path.dirname(path.join(root, key));
      expect(await readdir(dir)).toEqual(["slide-1.png"]);
    },
    30_000,
  );

  it(
    "reports the previous render's images as stale and only deletes them on request",
    async () => {
      const { store, root } = await makeStore();

      const first = await renderPost(post(), store);
      const oldKey = keyFromPublicUrl(first.media[0].url) as string;

      const second = await renderPost(
        post({ bodyText: "Completely different words, so the fingerprint changes and new keys are used." }),
        store,
        { previousUrls: first.media.map((row) => row.url) },
      );

      expect(second.media[0].url).not.toBe(first.media[0].url);
      expect(second.staleKeys).toEqual([oldKey]);

      // Nothing was deleted by the render itself: the caller may still fail
      // to save, and the rows it has not replaced must keep working.
      expect((await stat(path.join(root, oldKey))).isFile()).toBe(true);

      const newKey = keyFromPublicUrl(second.media[0].url) as string;
      expect((await stat(path.join(root, newKey))).isFile()).toBe(true);

      const cleanup = await deleteStaleImages(second.staleKeys, store);
      expect(cleanup.deleted).toEqual([oldKey]);
      expect(cleanup.failed).toEqual([]);
      await expect(stat(path.join(root, oldKey))).rejects.toThrow();
      expect((await stat(path.join(root, newKey))).isFile()).toBe(true);
    },
    30_000,
  );

  it(
    "never deletes images belonging to another post",
    async () => {
      const { store, root } = await makeStore();
      const recording = new RecordingStore(store);
      const foreign = `posts/22222222-2222-4222-8222-222222222222/abc/slide-1.png`;
      const ownStale = `posts/${POST_ID}/stale/slide-9.png`;
      await store.put(Buffer.from("foreign"), foreign);
      await store.put(Buffer.from("own"), ownStale);

      const result = await renderPost(post(), recording, {
        previousUrls: [`${BASE_URL}/uploads/${foreign}`, `${BASE_URL}/uploads/${ownStale}`],
      });

      // Rendering deletes nothing at all now.
      expect(recording.deleted).toEqual([]);
      expect(result.staleKeys).toEqual([ownStale]);

      await deleteStaleImages(result.staleKeys, recording);
      expect(recording.deleted).toEqual([ownStale]);
      expect(recording.deleted).not.toContain(foreign);
      await expect(stat(path.join(root, ownStale))).rejects.toThrow();
      expect((await stat(path.join(root, foreign))).isFile()).toBe(true);
    },
    30_000,
  );

  it("compensates a failed upload instead of leaving half a carousel", async () => {
    const store = new MemoryStore();
    store.failOnPut = 2;

    const longText = Array.from(
      { length: 12 },
      (_, index) => `Paragraph ${index + 1}: ${"slides are rendered once and uploaded together. ".repeat(3)}`,
    ).join("\n\n");

    await expect(renderPost(post({ bodyText: longText }), store)).rejects.toThrow("upload failed");

    // The first slide was uploaded, then rolled back when the second failed.
    expect(store.files.size).toBe(0);
    expect(store.deleted).toHaveLength(1);
  });

  it(
    "returns no media and stale keys for empty content",
    async () => {
      const { store, root } = await makeStore();

      const first = await renderPost(post(), store);
      const oldKey = keyFromPublicUrl(first.media[0].url) as string;

      const result = await renderPost(post({ bodyText: "   \n  " }), store, {
        previousUrls: first.media.map((row) => row.url),
      });

      expect(result.media).toEqual([]);
      expect(result.slideCount).toBe(0);
      expect(result.staleKeys).toEqual([oldKey]);
      expect((await stat(path.join(root, oldKey))).isFile()).toBe(true);

      await deleteStaleImages(result.staleKeys, store);
      await expect(stat(path.join(root, oldKey))).rejects.toThrow();
    },
    30_000,
  );
});

describe("deleteStaleImages", () => {
  it("deduplicates keys and is idempotent", async () => {
    const { store, root } = await makeStore();
    const key = `posts/${POST_ID}/abc/slide-1.png`;
    await store.put(Buffer.from("slide"), key);

    const first = await deleteStaleImages([key, key], store);
    expect(first.deleted).toEqual([key]);
    expect(first.failed).toEqual([]);

    // The local store treats a missing object as success, so a retry is safe.
    const second = await deleteStaleImages([key], store);
    expect(second.deleted).toEqual([key]);
    await expect(stat(path.join(root, key))).rejects.toThrow();
  });

  it("reports failures instead of throwing, so a saved post stays saved", async () => {
    const store: ImageStore = {
      kind: "local-disk",
      put: async () => `${BASE_URL}/uploads/x.png`,
      delete: async (key) => {
        if (key.endsWith("slide-2.png")) throw new Error("storage unavailable");
      },
    };

    const result = await deleteStaleImages(
      [`posts/${POST_ID}/abc/slide-1.png`, `posts/${POST_ID}/abc/slide-2.png`],
      store,
    );

    expect(result.deleted).toEqual([`posts/${POST_ID}/abc/slide-1.png`]);
    expect(result.failed).toEqual([
      { key: `posts/${POST_ID}/abc/slide-2.png`, error: "storage unavailable" },
    ]);
  });
});
