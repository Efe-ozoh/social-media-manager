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
import { renderPost, type RenderablePost } from "./render-post";

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
      expect(second.removedKeys).toEqual([]);

      const key = keyFromPublicUrl(first.media[0].url) as string;
      const dir = path.dirname(path.join(root, key));
      expect(await readdir(dir)).toEqual(["slide-1.png"]);
    },
    30_000,
  );

  it(
    "deletes the previous render's images when the content changes",
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
      expect(second.removedKeys).toEqual([oldKey]);
      await expect(stat(path.join(root, oldKey))).rejects.toThrow();

      const newKey = keyFromPublicUrl(second.media[0].url) as string;
      expect((await stat(path.join(root, newKey))).isFile()).toBe(true);
    },
    30_000,
  );

  it(
    "never deletes images belonging to another post",
    async () => {
      const { store } = await makeStore();
      const recording = new RecordingStore(store);
      const foreign = `posts/22222222-2222-4222-8222-222222222222/abc/slide-1.png`;
      const ownStale = `posts/${POST_ID}/stale/slide-9.png`;

      const result = await renderPost(post(), recording, {
        previousUrls: [`${BASE_URL}/uploads/${foreign}`, `${BASE_URL}/uploads/${ownStale}`],
      });

      expect(result.removedKeys).toEqual([ownStale]);
      expect(recording.deleted).toEqual([ownStale]);
      expect(recording.deleted).not.toContain(foreign);
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
    "removes old images and returns no media for empty content",
    async () => {
      const { store, root } = await makeStore();

      const first = await renderPost(post(), store);
      const oldKey = keyFromPublicUrl(first.media[0].url) as string;

      const result = await renderPost(post({ bodyText: "   \n  " }), store, {
        previousUrls: first.media.map((row) => row.url),
      });

      expect(result.media).toEqual([]);
      expect(result.slideCount).toBe(0);
      expect(result.removedKeys).toEqual([oldKey]);
      await expect(stat(path.join(root, oldKey))).rejects.toThrow();
    },
    30_000,
  );
});
