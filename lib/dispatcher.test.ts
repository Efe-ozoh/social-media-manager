import { describe, expect, it, vi } from "vitest";
import {
  computePostStatus,
  createPrismaDispatchStore,
  cronBatchLimit,
  DEFAULT_CRON_BATCH_LIMIT,
  DISPATCH_TIME_BUDGET_MS,
  dispatchDue,
  MAX_ATTEMPTS,
  MAX_CRON_BATCH_LIMIT,
  MAX_RETRIES,
  MIN_CRON_BATCH_LIMIT,
  STUCK_TARGET_MS,
  type ClaimedTarget,
  type DispatchStore,
  type MarkFailureInput,
  type MarkPublishedInput,
  type ResetStuckInput,
} from "./dispatcher";
import type { PlatformName } from "./platforms";
import {
  PublishError,
  type PublishInput,
  type Publisher,
} from "./publishers/types";

const NOW = new Date("2026-06-01T12:00:00Z");
const ENV = {
  TELEGRAM_BOT_TOKEN: "123456789:AAHtest-token-do-not-leak-0123456789ab",
  TELEGRAM_CHANNEL_ID: "-1001234567890",
};

type FakePost = {
  id: string;
  caption: string;
  status: "scheduled" | "published" | "partial" | "failed";
  scheduledAt: Date;
  mediaUrls: string[];
  textOnly?: boolean;
};

type FakeTarget = {
  id: string;
  postId: string;
  platform: PlatformName;
  captionOverride: string | null;
  status: "pending" | "processing" | "published" | "failed";
  attempts: number;
  nextAttemptAt: Date | null;
  processingStartedAt: Date | null;
  notes: string | null;
  requiresReconnect: boolean;
  lastError: string | null;
  externalPostId: string | null;
  publishedAt: Date | null;
};

class FakeStore implements DispatchStore {
  readonly posts = new Map<string, FakePost>();
  readonly targets = new Map<string, FakeTarget>();

  addPost(
    id: string,
    overrides: Partial<FakePost> = {},
  ): FakePost {
    const post: FakePost = {
      id,
      caption: "A scheduler post",
      status: "scheduled",
      scheduledAt: new Date(NOW.getTime() - 60_000),
      mediaUrls: ["https://example.com/slide-1.jpg"],
      ...overrides,
    };
    this.posts.set(id, post);
    return post;
  }

  addTarget(
    id: string,
    postId: string,
    overrides: Partial<FakeTarget> = {},
  ): FakeTarget {
    const target: FakeTarget = {
      id,
      postId,
      platform: "telegram",
      captionOverride: null,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      processingStartedAt: null,
      notes: null,
      requiresReconnect: false,
      lastError: null,
      externalPostId: null,
      publishedAt: null,
      ...overrides,
    };
    this.targets.set(id, target);
    return target;
  }

  async resetStuckTargets({ cutoff, now }: ResetStuckInput): Promise<number> {
    let count = 0;
    for (const target of this.targets.values()) {
      if (
        target.status === "processing" &&
        (target.processingStartedAt === null ||
          target.processingStartedAt.getTime() < cutoff.getTime())
      ) {
        target.status = "pending";
        target.processingStartedAt = null;
        target.nextAttemptAt = now;
        count += 1;
      }
    }
    return count;
  }

  async claimDueTargets({
    now,
    limit,
    postId,
  }: {
    now: Date;
    limit: number;
    postId?: string;
  }): Promise<ClaimedTarget[]> {
    const candidates: { target: FakeTarget; post: FakePost }[] = [];

    for (const target of this.targets.values()) {
      if (postId && target.postId !== postId) continue;
      if (target.status !== "pending") continue;
      if (target.nextAttemptAt && target.nextAttemptAt.getTime() > now.getTime()) {
        continue;
      }

      const post = this.posts.get(target.postId);
      if (
        !post ||
        post.status !== "scheduled" ||
        post.scheduledAt.getTime() > now.getTime()
      ) {
        continue;
      }

      candidates.push({ target, post });
    }

    candidates.sort(
      (a, b) =>
        a.post.scheduledAt.getTime() - b.post.scheduledAt.getTime() ||
        a.target.id.localeCompare(b.target.id),
    );

    return candidates.slice(0, limit).map(({ target, post }) => {
      target.status = "processing";
      target.attempts += 1;
      target.processingStartedAt = now;
      target.nextAttemptAt = null;
      target.lastError = null;
      target.notes = null;

      return {
        targetId: target.id,
        postId: target.postId,
        platform: target.platform,
        captionOverride: target.captionOverride,
        attempts: target.attempts,
        caption: post.caption,
        textOnly: post.textOnly === true,
      };
    });
  }

  async getMediaUrls(postId: string): Promise<string[]> {
    return this.posts.get(postId)?.mediaUrls ?? [];
  }

  async getAccount(): Promise<null> {
    return null;
  }

  async markPublished(targetId: string, input: MarkPublishedInput): Promise<void> {
    const target = this.targets.get(targetId);
    if (!target) throw new Error(`missing target ${targetId}`);
    target.status = "published";
    target.externalPostId = input.externalPostId;
    target.publishedAt = input.publishedAt;
    target.notes = input.notes ?? null;
    target.lastError = null;
    target.nextAttemptAt = null;
    target.processingStartedAt = null;
    target.requiresReconnect = false;
  }

  async markFailure(targetId: string, input: MarkFailureInput): Promise<void> {
    const target = this.targets.get(targetId);
    if (!target) throw new Error(`missing target ${targetId}`);
    target.status = input.status;
    target.lastError = input.lastError;
    target.nextAttemptAt = input.nextAttemptAt;
    target.processingStartedAt = null;
    target.requiresReconnect = input.requiresReconnect;
  }

  async recomputePostStatus(postId: string) {
    const post = this.posts.get(postId);
    if (!post) throw new Error(`missing post ${postId}`);
    const statuses = [...this.targets.values()]
      .filter((target) => target.postId === postId)
      .map((target) => target.status);
    const status = computePostStatus(statuses);
    post.status = status as FakePost["status"];
    return status;
  }
}

function publisher(
  platform: PlatformName,
  publish: Publisher["publish"],
): Publisher {
  return {
    platform,
    maxImages: 10,
    maxCaptionLength: 10_000,
    publish,
  };
}

describe("computePostStatus", () => {
  it("recomputes published, partial and failed from target statuses", () => {
    expect(computePostStatus(["published", "published"])).toBe("published");
    expect(computePostStatus(["published", "failed"])).toBe("partial");
    expect(computePostStatus(["failed", "failed"])).toBe("failed");
  });

  it("keeps the post scheduled while any target can still run", () => {
    expect(computePostStatus(["published", "pending"])).toBe("scheduled");
    expect(computePostStatus(["failed", "processing"])).toBe("scheduled");
    expect(computePostStatus(["published", "pending", "failed"])).toBe(
      "scheduled",
    );
  });
});

describe("cronBatchLimit", () => {
  it("defaults to 3 and honours a valid override", () => {
    expect(DEFAULT_CRON_BATCH_LIMIT).toBe(3);
    expect(cronBatchLimit({})).toBe(3);
    expect(cronBatchLimit({ CRON_BATCH_LIMIT: "5" })).toBe(5);
  });

  it("clamps values and falls back for invalid input", () => {
    expect(cronBatchLimit({ CRON_BATCH_LIMIT: "0" })).toBe(
      MIN_CRON_BATCH_LIMIT,
    );
    expect(cronBatchLimit({ CRON_BATCH_LIMIT: "99" })).toBe(
      MAX_CRON_BATCH_LIMIT,
    );
    expect(cronBatchLimit({ CRON_BATCH_LIMIT: "many" })).toBe(
      DEFAULT_CRON_BATCH_LIMIT,
    );
    expect(cronBatchLimit({ CRON_BATCH_LIMIT: "3.5" })).toBe(
      DEFAULT_CRON_BATCH_LIMIT,
    );
  });
});

describe("dispatchDue", () => {

  it("claims in one transaction with FOR UPDATE SKIP LOCKED", async () => {
    const captured: { query?: { sql?: string; values?: unknown[] } } = {};
    const fakePrisma = {
      $transaction: async (callback: (tx: unknown) => unknown) =>
        callback({
          $queryRaw: async (query: { sql?: string; values?: unknown[] }) => {
            captured.query = query;
            return [];
          },
        }),
    } as unknown as Parameters<typeof createPrismaDispatchStore>[0];

    const store = createPrismaDispatchStore(fakePrisma);
    await store.claimDueTargets({ now: NOW, limit: 10 });

    const text = captured.query?.sql ?? String(captured.query);
    expect(text).toContain("FOR UPDATE OF t SKIP LOCKED");
    expect(text).toContain("status = 'processing'");
    expect(text).toContain("attempts = t.attempts + 1");
    // The claim carries the text-only flag so a dispatch never reads slides
    // for a post that has none.
    expect(text).toContain("text_only");
  });

  it("publishes a text-only post with an empty image list", async () => {
    const store = new FakeStore();
    store.addPost("post-1", {
      caption: "Plain words only",
      textOnly: true,
      // A leftover row must not leak into the publisher input.
      mediaUrls: ["https://example.com/leftover.jpg"],
    });
    store.addTarget("target-1", "post-1", { platform: "telegram" });

    const captured: PublishInput[] = [];
    const publish = vi.fn(async (input: PublishInput) => {
      captured.push(input);
      return { externalPostId: "telegram-77", publishedAt: NOW };
    });

    const summary = await dispatchDue({
      store,
      publishers: { telegram: publisher("telegram", publish) },
      env: ENV,
      now: NOW,
    });

    expect(summary.published).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0].imageUrls).toEqual([]);
    expect(captured[0].caption).toBe("Plain words only");
    expect(store.posts.get("post-1")?.status).toBe("published");
  });

  it("never lets two overlapping runs publish the same target", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1");

    const publish = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { externalPostId: "telegram-123", publishedAt: new Date() };
    });
    const publishers = { telegram: publisher("telegram", publish) };

    const [first, second] = await Promise.all([
      dispatchDue({ store, publishers, env: ENV, now: NOW }),
      dispatchDue({ store, publishers, env: ENV, now: NOW }),
    ]);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(first.claimed + second.claimed).toBe(1);
    expect(store.targets.get("target-1")?.status).toBe("published");
    expect(store.posts.get("post-1")?.status).toBe("published");
  });

  it("claims at most the default batch size of 3", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    for (let index = 1; index <= 4; index += 1) {
      store.addTarget(`target-${index}`, "post-1");
    }

    const publish = vi.fn(async () => ({
      externalPostId: "telegram-123",
      publishedAt: NOW,
    }));
    const summary = await dispatchDue({
      store,
      publishers: { telegram: publisher("telegram", publish) },
      env: ENV,
      now: NOW,
    });

    expect(summary.claimed).toBe(3);
    expect(summary.published).toBe(3);
    expect(store.targets.get("target-4")?.status).toBe("pending");
  });

  it("stops claiming once the time budget is spent", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1");
    store.addTarget("target-2", "post-1");
    store.addTarget("target-3", "post-1");

    let elapsed = 0;
    const publish = vi.fn(async () => {
      elapsed = DISPATCH_TIME_BUDGET_MS + 1;
      return { externalPostId: "telegram-123", publishedAt: NOW };
    });

    const summary = await dispatchDue({
      store,
      publishers: { telegram: publisher("telegram", publish) },
      env: ENV,
      now: NOW,
      limit: 3,
      clock: () => elapsed,
    });

    expect(summary.claimed).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(store.targets.get("target-2")?.status).toBe("pending");
    expect(store.targets.get("target-3")?.status).toBe("pending");
  });

  it("retries after 1, 5 and 15 minutes, then fails", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1");

    const publish = vi.fn(async () => {
      throw new PublishError({
        code: "network",
        platform: "telegram",
        message: "Telegram could not be reached.",
      });
    });
    const publishers = { telegram: publisher("telegram", publish) };

    const first = await dispatchDue({ store, publishers, env: ENV, now: NOW });
    expect(first.retried).toBe(1);
    expect(store.targets.get("target-1")).toMatchObject({
      status: "pending",
      attempts: 1,
    });
    expect(store.targets.get("target-1")?.nextAttemptAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 60_000).toISOString(),
    );

    // Not due yet.
    const early = await dispatchDue({
      store,
      publishers,
      env: ENV,
      now: new Date(NOW.getTime() + 30_000),
    });
    expect(early.claimed).toBe(0);

    const secondAt = new Date(NOW.getTime() + 61_000);
    const second = await dispatchDue({
      store,
      publishers,
      env: ENV,
      now: secondAt,
    });
    expect(second.retried).toBe(1);
    expect(store.targets.get("target-1")).toMatchObject({
      status: "pending",
      attempts: 2,
    });
    expect(store.targets.get("target-1")?.nextAttemptAt?.toISOString()).toBe(
      new Date(secondAt.getTime() + 5 * 60_000).toISOString(),
    );

    const thirdAt = new Date(secondAt.getTime() + 5 * 60_000 + 1_000);
    const third = await dispatchDue({
      store,
      publishers,
      env: ENV,
      now: thirdAt,
    });
    expect(third.retried).toBe(1);
    expect(store.targets.get("target-1")).toMatchObject({
      status: "pending",
      attempts: 3,
    });
    expect(store.targets.get("target-1")?.nextAttemptAt?.toISOString()).toBe(
      new Date(thirdAt.getTime() + 15 * 60_000).toISOString(),
    );

    const fourthAt = new Date(thirdAt.getTime() + 15 * 60_000 + 1_000);
    const fourth = await dispatchDue({
      store,
      publishers,
      env: ENV,
      now: fourthAt,
    });
    expect(fourth.failed).toBe(1);
    expect(store.targets.get("target-1")).toMatchObject({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      nextAttemptAt: null,
    });
    expect(MAX_ATTEMPTS).toBe(MAX_RETRIES + 1);
    expect(store.posts.get("post-1")?.status).toBe("failed");
  });

  it("honours a publisher's retryAfterSeconds", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1");

    const publish = vi.fn(async () => {
      throw new PublishError({
        code: "rate_limited",
        platform: "telegram",
        message: "Too many requests.",
        retryAfterSeconds: 17,
      });
    });

    await dispatchDue({
      store,
      publishers: { telegram: publisher("telegram", publish) },
      env: ENV,
      now: NOW,
    });

    expect(store.targets.get("target-1")?.nextAttemptAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 17_000).toISOString(),
    );
  });

  it("fails immediately on a non-retryable error and redacts tokens", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1");

    const publish = vi.fn(async () => {
      throw PublishError.validation(
        "telegram",
        "Bad request with token 123456789:AAHsecret-token-value-0123456789 in it.",
      );
    });

    const summary = await dispatchDue({
      store,
      publishers: { telegram: publisher("telegram", publish) },
      env: ENV,
      now: NOW,
    });

    expect(summary.failed).toBe(1);
    const target = store.targets.get("target-1");
    expect(target).toMatchObject({ status: "failed", attempts: 1 });
    expect(target?.lastError).not.toContain("AAHsecret-token-value");
    expect(target?.lastError).toContain("[redacted token]");
  });

  it("flags an account that must be reconnected", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1");

    const publish = vi.fn(async () => {
      throw PublishError.tokenExpired("telegram");
    });

    await dispatchDue({
      store,
      publishers: { telegram: publisher("telegram", publish) },
      env: ENV,
      now: NOW,
    });

    const target = store.targets.get("target-1");
    expect(target).toMatchObject({
      status: "failed",
      requiresReconnect: true,
    });
    expect(target?.lastError).toMatch(/reconnect/i);
  });

  it("recovers a target stuck in processing for more than 10 minutes", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1", {
      status: "processing",
      attempts: 1,
      processingStartedAt: new Date(NOW.getTime() - STUCK_TARGET_MS - 60_000),
    });

    const publish = vi.fn(async () => ({
      externalPostId: "telegram-999",
      publishedAt: NOW,
    }));

    const summary = await dispatchDue({
      store,
      publishers: { telegram: publisher("telegram", publish) },
      env: ENV,
      now: NOW,
    });

    expect(summary.recovered).toBe(1);
    expect(summary.published).toBe(1);
    expect(store.targets.get("target-1")?.status).toBe("published");
  });

  it("does not recover a fresh processing target", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1", {
      status: "processing",
      attempts: 1,
      processingStartedAt: new Date(NOW.getTime() - 9 * 60_000),
    });

    const publish = vi.fn(async () => ({
      externalPostId: "unused",
      publishedAt: NOW,
    }));

    const summary = await dispatchDue({
      store,
      publishers: { telegram: publisher("telegram", publish) },
      env: ENV,
      now: NOW,
    });

    expect(summary.recovered).toBe(0);
    expect(summary.claimed).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("recomputes the parent to partial when one target publishes and one fails", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1", { platform: "telegram" });
    store.addTarget("target-2", "post-1", { platform: "linkedin" });

    const telegram = publisher("telegram", async () => ({
      externalPostId: "telegram-1",
      publishedAt: NOW,
    }));
    const linkedin = publisher("linkedin", async () => {
      throw PublishError.permissionDenied("linkedin");
    });

    const summary = await dispatchDue({
      store,
      publishers: { telegram, linkedin },
      env: ENV,
      now: NOW,
    });

    expect(summary.published).toBe(1);
    expect(summary.failed).toBe(1);
    expect(store.posts.get("post-1")?.status).toBe("partial");
  });

  it("stores publisher notes for the UI", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1");

    const notes = ["Published with the first slide only."];
    const publish = vi.fn(async () => ({
      externalPostId: "telegram-1",
      publishedAt: NOW,
      notes,
    }));

    await dispatchDue({
      store,
      publishers: { telegram: publisher("telegram", publish) },
      env: ENV,
      now: NOW,
    });

    expect(store.targets.get("target-1")?.notes).toBe(notes[0]);
  });

  it("never calls a publisher for a manual-export platform", async () => {
    const store = new FakeStore();
    store.addPost("post-1");
    store.addTarget("target-1", "post-1", { platform: "instagram" });

    const publish = vi.fn(async () => ({
      externalPostId: "should-not-exist",
      publishedAt: NOW,
    }));

    await dispatchDue({
      store,
      publishers: { instagram: publisher("instagram", publish) },
      env: ENV,
      now: NOW,
    });

    expect(publish).not.toHaveBeenCalled();
    expect(store.targets.get("target-1")).toMatchObject({ status: "failed" });
    expect(store.targets.get("target-1")?.lastError).toMatch(/not an automated/);
  });
});
