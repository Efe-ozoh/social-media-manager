import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ prisma: undefined as unknown }));

vi.mock("@/lib/prisma", () => ({ getPrisma: () => state.prisma }));

import { POST } from "./route";

/**
 * The route with a fake Prisma client: no database, no network. The cases that
 * matter are the refusals (published target, wrong post, already queued) and
 * that a success resets the target and puts the parent back to scheduled, which
 * is what makes the dispatcher pick it up again.
 */

const POST_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";

type Target = {
  id: string;
  platform: string;
  captionOverride: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  processingStartedAt: Date | null;
  notes: string | null;
  requiresReconnect: boolean;
  externalPostId: string | null;
  publishedAt: Date | null;
};

function target(overrides: Partial<Target> = {}): Target {
  return {
    id: TARGET_ID,
    platform: "linkedin",
    captionOverride: null,
    status: "failed",
    attempts: 3,
    lastError: "The channel does not exist.",
    nextAttemptAt: null,
    processingStartedAt: null,
    notes: "One image instead of five",
    requiresReconnect: false,
    externalPostId: null,
    publishedAt: null,
    ...overrides,
  };
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    title: null,
    bodyText: "A line of text",
    contentType: "text",
    code: null,
    language: null,
    theme: "default",
    caption: "A caption",
    carouselMode: "auto",
    backgroundMode: "solid",
    backgroundQuery: null,
    bgUnsplashId: null,
    bgUrl: null,
    bgThumbUrl: null,
    bgAuthorName: null,
    bgAuthorUrl: null,
    bgColor: null,
    source: "manual",
    aiPrompt: null,
    status: "partial",
    scheduledAt: new Date("2026-06-01T12:00:00.000Z"),
    createdAt: new Date("2026-06-01T11:00:00.000Z"),
    updatedAt: new Date("2026-06-01T12:00:00.000Z"),
    media: [],
    targets: [target()],
    ...overrides,
  };
}

function fakePrisma(options: {
  post?: unknown;
  updated?: unknown;
  updateCount?: number;
} = {}) {
  const found = options.post === undefined ? post() : options.post;
  const updated = options.updated ?? post({ status: "scheduled" });

  const targetUpdate = vi.fn(async () => ({ count: options.updateCount ?? 1 }));
  const postUpdate = vi.fn(async () => undefined);
  const findUnique = vi.fn();

  if (found === null) {
    findUnique.mockResolvedValue(null);
  } else {
    findUnique.mockResolvedValueOnce(found).mockResolvedValueOnce(updated);
  }

  const tx = {
    postTarget: { updateMany: targetUpdate },
    post: { update: postUpdate },
  };

  const prisma = {
    post: { findUnique, update: postUpdate },
    postTarget: { updateMany: targetUpdate },
    $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
  };

  return { prisma, findUnique, targetUpdate, postUpdate };
}

function call(ids: { id?: string; targetId?: string } = {}) {
  return POST(new NextRequest("http://localhost:3000/x", { method: "POST" }), {
    params: Promise.resolve({
      id: ids.id ?? POST_ID,
      targetId: ids.targetId ?? TARGET_ID,
    }),
  });
}

beforeEach(() => {
  state.prisma = undefined;
});

describe("POST /api/posts/[id]/targets/[targetId]/retry", () => {
  it("rejects ids that are not UUIDs before touching the database", async () => {
    const response = await call({ targetId: "not-a-uuid" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid post or target id.",
    });
  });

  it("reports a missing post as a 404", async () => {
    state.prisma = fakePrisma({ post: null }).prisma;

    const response = await call();

    expect(response.status).toBe(404);
  });

  it("reports a target that belongs to another post as a 404", async () => {
    state.prisma = fakePrisma({ post: post({ targets: [] }) }).prisma;

    const response = await call();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Target not found." });
  });

  it("refuses to retry a target that is not failed", async () => {
    for (const status of ["published", "pending", "processing"]) {
      state.prisma = fakePrisma({
        post: post({ targets: [target({ status })] }),
      }).prisma;

      const response = await call();
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: "Only a failed target can be retried.",
      });
    }
  });

  it("refuses to retry a draft, which was never dispatched", async () => {
    state.prisma = fakePrisma({ post: post({ status: "draft" }) }).prisma;

    const response = await call();

    expect(response.status).toBe(409);
  });

  it("resets the target and queues the post again", async () => {
    const fake = fakePrisma();
    state.prisma = fake.prisma;

    const response = await call();
    const body = (await response.json()) as { ok: boolean; post: { status: string } };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.post.status).toBe("scheduled");

    expect(fake.targetUpdate).toHaveBeenCalledTimes(1);
    const update = (
      fake.targetUpdate.mock.calls as unknown as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }[][]
    )[0][0];
    expect(update.where).toEqual({
      id: TARGET_ID,
      postId: POST_ID,
      status: "failed",
    });
    expect(update.data).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
      notes: null,
      processingStartedAt: null,
    });
    expect(update.data.nextAttemptAt).toBeInstanceOf(Date);

    const parent = (
      fake.postUpdate.mock.calls as unknown as { data: Record<string, unknown> }[][]
    )[0][0];
    expect(parent.data.status).toBe("scheduled");
    // An existing schedule is respected rather than pulled forward.
    expect(parent.data).not.toHaveProperty("scheduledAt");
  });

  it("gives a post without a scheduled time one, so dispatch can claim it", async () => {
    const fake = fakePrisma({ post: post({ scheduledAt: null }) });
    state.prisma = fake.prisma;

    await call();

    const parent = (
      fake.postUpdate.mock.calls as unknown as { data: Record<string, unknown> }[][]
    )[0][0];
    expect(parent.data.scheduledAt).toBeInstanceOf(Date);
  });

  it("answers 409 when a concurrent request already reset the target", async () => {
    state.prisma = fakePrisma({ updateCount: 0 }).prisma;

    const response = await call();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Reload"),
    });
  });
});
