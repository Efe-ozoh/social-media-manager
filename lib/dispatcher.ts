/**
 * Scheduler — SPEC section 9.
 *
 * The dispatcher is split into two halves:
 *   - dispatchDue() is the orchestration: recover stuck work, claim due
 *     targets, publish each one, and recompute the parent post's status.
 *   - DispatchStore is everything that touches the database. The Prisma
 *     implementation below uses FOR UPDATE SKIP LOCKED, so two overlapping
 *     cron runs can never claim the same target. Tests inject an in-memory
 *     store and mock publishers, so nothing in this file needs a network or a
 *     database to be tested.
 *
 * A target is claimed (status -> processing, attempts + 1) inside the same
 * transaction that selects it. That is what makes double dispatch impossible:
 * the second run skips a locked row, and once this run commits the row is no
 * longer pending.
 *
 * Tokens are never logged. Error text is passed through redactSecrets() before
 * it is stored in last_error, and account decryption failures are replaced
 * with a generic reconnect message.
 */

import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import type { PostStatus } from "@/lib/generated/prisma/enums";
import { getPrisma } from "./prisma";
import {
  automatedPlatforms,
  platformMode,
  type PlatformName,
} from "./platforms";
import {
  getTelegramConfig,
  TelegramConfigError,
  telegramPublisher,
} from "./publishers/telegram";
import { linkedinPublisher } from "./publishers/linkedin";
import {
  PublishError,
  redactSecrets,
  toPublishError,
  toSocialAccount,
  type Publisher,
  type SocialAccount,
  type StoredAccountRow,
} from "./publishers/types";

/** The initial try plus three retries, then the target is failed. */
export const MAX_RETRIES = 3;
export const MAX_ATTEMPTS = MAX_RETRIES + 1;
/** The documented backoff schedule, one entry per retry, in minutes. */
export const RETRY_DELAYS_MINUTES = [1, 5, 15] as const;
/** A processing target older than this is presumed dead and reset to pending. */
export const STUCK_TARGET_MS = 10 * 60 * 1000;
/** Treat a token expiring within a minute as already gone. */
const EXPIRY_SKEW_MS = 60_000;

export const DEFAULT_CRON_BATCH_LIMIT = 3;
export const MIN_CRON_BATCH_LIMIT = 1;
export const MAX_CRON_BATCH_LIMIT = 10;
const MAX_DISPATCH_LIMIT = 100;
export const DISPATCH_TIME_BUDGET_MS = 20_000;

export function cronBatchLimit(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CRON_BATCH_LIMIT?.trim();
  if (!raw) return DEFAULT_CRON_BATCH_LIMIT;

  const value = Number(raw);
  if (!Number.isInteger(value)) return DEFAULT_CRON_BATCH_LIMIT;

  return Math.min(MAX_CRON_BATCH_LIMIT, Math.max(MIN_CRON_BATCH_LIMIT, value));
}

export type ClaimedTarget = {
  targetId: string;
  postId: string;
  platform: PlatformName;
  captionOverride: string | null;
  attempts: number;
  caption: string;
  /** Text-only posts publish with no images, whatever the storage says. */
  textOnly?: boolean;
};

export type ResetStuckInput = { cutoff: Date; now: Date };

export type ClaimInput = {
  now: Date;
  limit: number;
  /** Restricts a publish-now run to one post. */
  postId?: string;
};

export type MarkPublishedInput = {
  externalPostId: string;
  publishedAt: Date;
  notes?: string | null;
};

export type MarkFailureInput = {
  status: "pending" | "failed";
  lastError: string;
  nextAttemptAt: Date | null;
  requiresReconnect: boolean;
};

/** The database operations dispatchDue needs, so tests can supply a fake. */
export interface DispatchStore {
  resetStuckTargets(input: ResetStuckInput): Promise<number>;
  claimDueTargets(input: ClaimInput): Promise<ClaimedTarget[]>;
  getMediaUrls(postId: string): Promise<string[]>;
  getAccount(platform: PlatformName): Promise<StoredAccountRow | null>;
  markPublished(targetId: string, input: MarkPublishedInput): Promise<void>;
  markFailure(targetId: string, input: MarkFailureInput): Promise<void>;
  recomputePostStatus(postId: string): Promise<PostStatus>;
}

export type DispatchStatus = "published" | "retried" | "failed";

export type DispatchResult = {
  targetId: string;
  postId: string;
  platform: PlatformName;
  status: DispatchStatus;
  attempts: number;
  externalPostId?: string;
  error?: string;
  notes?: string;
};

export type DispatchSummary = {
  recovered: number;
  claimed: number;
  published: number;
  retried: number;
  failed: number;
  results: DispatchResult[];
};

export type DispatchOptions = {
  store?: DispatchStore;
  publishers?: Partial<Record<PlatformName, Publisher>>;
  env?: Record<string, string | undefined>;
  now?: Date;
  limit?: number;
  timeBudgetMs?: number;
  clock?: () => number;
  postId?: string;
  accountKey?: Buffer;
};

const DEFAULT_PUBLISHERS: Partial<Record<PlatformName, Publisher>> = {
  linkedin: linkedinPublisher,
  telegram: telegramPublisher,
};

/**
 * The parent status after a target finishes. Targets with retries left keep
 * the post scheduled (otherwise the next dispatch could never find them);
 * only a fully settled set becomes published, partial or failed.
 */
export function computePostStatus(
  statuses: readonly ("pending" | "processing" | "published" | "failed")[],
): PostStatus {
  if (statuses.length === 0) return "scheduled";

  const published = statuses.filter((status) => status === "published").length;
  const failed = statuses.filter((status) => status === "failed").length;
  const open = statuses.filter(
    (status) => status === "pending" || status === "processing",
  ).length;

  if (published === statuses.length) return "published";
  if (failed === statuses.length) return "failed";
  if (open === 0 && published > 0 && failed > 0) return "partial";
  return "scheduled";
}

function retryDelayMs(error: PublishError, attempts: number): number {
  // Telegram's 429 retry_after wins: it is the platform telling us exactly
  // when it will accept the next request.
  if (typeof error.retryAfterSeconds === "number") {
    return Math.max(0, error.retryAfterSeconds) * 1000;
  }

  const minutes =
    RETRY_DELAYS_MINUTES[Math.max(0, attempts - 1)] ??
    RETRY_DELAYS_MINUTES[RETRY_DELAYS_MINUTES.length - 1];
  return minutes * 60 * 1000;
}

function safeErrorText(error: PublishError): string {
  const text = [error.message, error.detail].filter(Boolean).join(" ").trim();
  return redactSecrets(text || "Publishing failed.");
}

function reconnectMessage(text: string): string {
  return text.toLowerCase().includes("reconnect")
    ? text
    : `Reconnect the account. ${text}`;
}

/**
 * Publishes one claimed target. Publisher/account failures are turned into a
 * store update here; unexpected errors are allowed to bubble so dispatchDue
 * can keep working on the other targets.
 */
async function processTarget(
  target: ClaimedTarget,
  store: DispatchStore,
  publishers: Partial<Record<PlatformName, Publisher>>,
  env: Record<string, string | undefined>,
  now: Date,
  accountKey?: Buffer,
): Promise<DispatchResult> {
  const base = {
    targetId: target.targetId,
    postId: target.postId,
    platform: target.platform,
    attempts: target.attempts,
  };

  try {
    // Second line of defence: manual-export platforms must never be dispatched
    // even if an old or hand-edited row says otherwise.
    if (
      !automatedPlatforms(env).includes(target.platform) ||
      platformMode(target.platform) !== "automated"
    ) {
      throw new PublishError({
        code: "unsupported",
        platform: target.platform,
        message: `${target.platform} is not an automated publishing platform and was not dispatched.`,
      });
    }

    const account = await loadAccount(target.platform, store, env, now, accountKey);
    const publisher = publishers[target.platform];
    if (!publisher) {
      throw new PublishError({
        code: "unsupported",
        platform: target.platform,
        message: `No publisher is available for ${target.platform}.`,
      });
    }

    // A text-only post never has images to send, and is not even asked for
    // them: publishers get an empty list and post the caption as text.
    const imageUrls = target.textOnly ? [] : await store.getMediaUrls(target.postId);
    const caption =
      target.captionOverride && target.captionOverride.trim() !== ""
        ? target.captionOverride
        : target.caption;

    const result = await publisher.publish({ caption, imageUrls, account });
    const notes = result.notes && result.notes.length > 0 ? result.notes.join("\n") : null;

    await store.markPublished(target.targetId, {
      externalPostId: result.externalPostId,
      publishedAt: result.publishedAt,
      notes,
    });

    return {
      ...base,
      status: "published",
      externalPostId: result.externalPostId,
      ...(notes ? { notes } : {}),
    };
  } catch (error) {
    const publishError = toPublishError(error, target.platform);
    const requiresReconnect = publishError.requiresReconnect;
    const retryable = publishError.retryable && !requiresReconnect;
    const rawError = safeErrorText(publishError);
    const lastError = requiresReconnect ? reconnectMessage(rawError) : rawError;

    if (!retryable || target.attempts > MAX_RETRIES) {
      await store.markFailure(target.targetId, {
        status: "failed",
        lastError,
        nextAttemptAt: null,
        requiresReconnect,
      });
      return {
        ...base,
        status: "failed",
        error: lastError,
      };
    }

    const nextAttemptAt = new Date(now.getTime() + retryDelayMs(publishError, target.attempts));
    await store.markFailure(target.targetId, {
      status: "pending",
      lastError,
      nextAttemptAt,
      requiresReconnect: false,
    });

    return {
      ...base,
      status: "retried",
      error: lastError,
    };
  }
}

async function loadAccount(
  platform: PlatformName,
  store: DispatchStore,
  env: Record<string, string | undefined>,
  now: Date,
  accountKey?: Buffer,
): Promise<SocialAccount> {
  if (platform === "telegram") {
    try {
      const config = getTelegramConfig(env);
      return {
        id: `telegram:${config.chatId}`,
        platform: "telegram",
        externalId: config.chatId,
        displayName: "Telegram channel",
        // Telegram reads its token from the environment; the account row is
        // only here to satisfy the shared Publisher contract.
        accessToken: "",
        refreshToken: null,
        expiresAt: null,
      };
    } catch (error) {
      const message =
        error instanceof TelegramConfigError
          ? error.message
          : "Telegram is not configured.";
      throw PublishError.validation("telegram", message);
    }
  }

  if (platform !== "linkedin") {
    throw new PublishError({
      code: "unsupported",
      platform,
      message: `No account loader is available for ${platform}.`,
    });
  }

  const row = await store.getAccount("linkedin");
  if (!row) {
    throw PublishError.tokenExpired(
      "linkedin",
      "No LinkedIn account is connected. Reconnect the account.",
    );
  }

  let account: SocialAccount;
  try {
    account = toSocialAccount(row, accountKey);
  } catch {
    // The decrypt error deliberately never includes the ciphertext or key.
    throw PublishError.tokenExpired(
      "linkedin",
      "The stored LinkedIn token could not be read. Reconnect the account.",
    );
  }

  if (
    account.expiresAt &&
    account.expiresAt.getTime() <= now.getTime() + EXPIRY_SKEW_MS
  ) {
    throw PublishError.tokenExpired(
      "linkedin",
      "The LinkedIn access token has expired. Reconnect the account.",
    );
  }

  return account;
}

/**
 * Claims and publishes due targets one at a time until the batch limit or time
 * budget is reached. Runs are safe to overlap: the store claims with FOR UPDATE
 * SKIP LOCKED.
 */
export async function dispatchDue(
  options: DispatchOptions = {},
): Promise<DispatchSummary> {
  const store = options.store ?? createPrismaDispatchStore();
  const publishers = { ...DEFAULT_PUBLISHERS, ...options.publishers };
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const limit = Math.max(
    1,
    Math.min(options.limit ?? DEFAULT_CRON_BATCH_LIMIT, MAX_DISPATCH_LIMIT),
  );
  const timeBudgetMs = Math.max(
    0,
    options.timeBudgetMs ?? DISPATCH_TIME_BUDGET_MS,
  );
  const clock = options.clock ?? Date.now;
  const startedAt = clock();

  const recovered = await store.resetStuckTargets({
    cutoff: new Date(now.getTime() - STUCK_TARGET_MS),
    now,
  });

  const results: DispatchResult[] = [];
  let claimed = 0;

  while (claimed < limit && clock() - startedAt < timeBudgetMs) {
    const [target] = await store.claimDueTargets({
      now,
      limit: 1,
      ...(options.postId ? { postId: options.postId } : {}),
    });
    if (!target) break;

    claimed += 1;
    let result: DispatchResult;
    try {
      result = await processTarget(
        target,
        store,
        publishers,
        env,
        now,
        options.accountKey,
      );
    } catch (error) {
      // An unexpected failure (for example the database going away) must not
      // stop the rest of the batch. Leave recovery to the stuck-job reset.
      result = {
        targetId: target.targetId,
        postId: target.postId,
        platform: target.platform,
        status: "failed",
        attempts: target.attempts,
        error: redactSecrets(error instanceof Error ? error.message : "Unknown dispatch error"),
      };
    }

    results.push(result);

    // Recompute after every target, so the list view never shows a stale
    // parent status while a batch is still running.
    await store.recomputePostStatus(target.postId);
  }

  return {
    recovered,
    claimed,
    published: results.filter((result) => result.status === "published").length,
    retried: results.filter((result) => result.status === "retried").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}

type RawClaimedTarget = {
  targetId: string;
  postId: string;
  platform: string;
  captionOverride: string | null;
  attempts: number;
  caption: string;
  textOnly: boolean;
};

/** The production store: all scheduler state lives in Postgres. */
export function createPrismaDispatchStore(
  prisma: PrismaClient = getPrisma(),
): DispatchStore {
  return {
    async resetStuckTargets({ cutoff, now }) {
      const result = await prisma.postTarget.updateMany({
        where: {
          status: "processing",
          OR: [
            { processingStartedAt: null },
            { processingStartedAt: { lt: cutoff } },
          ],
        },
        data: {
          status: "pending",
          processingStartedAt: null,
          nextAttemptAt: now,
        },
      });
      return result.count;
    },

    async claimDueTargets({ now, limit, postId }) {
      const postFilter = postId
        ? Prisma.sql`AND t.post_id = ${postId}::uuid`
        : Prisma.empty;

      const rows = await prisma.$transaction(async (tx) => {
        return tx.$queryRaw<RawClaimedTarget[]>(Prisma.sql`
          WITH due AS (
            SELECT
              t.id AS target_id,
              t.post_id,
              t.platform,
              t.caption_override,
              t.attempts + 1 AS attempts,
              p.caption,
              p.text_only
            FROM "post_targets" t
            JOIN "posts" p ON p.id = t.post_id
            WHERE p.status = 'scheduled'
              AND p.scheduled_at IS NOT NULL
              AND p.scheduled_at <= ${now}
              AND t.status = 'pending'
              AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ${now})
              ${postFilter}
            ORDER BY p.scheduled_at ASC, t.id ASC
            FOR UPDATE OF t SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE "post_targets" t
          SET
            status = 'processing',
            attempts = t.attempts + 1,
            processing_started_at = ${now},
            next_attempt_at = NULL,
            last_error = NULL,
            notes = NULL,
            requires_reconnect = false
          FROM due
          WHERE t.id = due.target_id
          RETURNING
            t.id AS "targetId",
            t.post_id AS "postId",
            t.platform::text AS "platform",
            t.caption_override AS "captionOverride",
            t.attempts AS "attempts",
            due.caption AS "caption",
            due.text_only AS "textOnly"
        `);
      });

      return rows.map((row) => ({
        targetId: row.targetId,
        postId: row.postId,
        platform: row.platform as PlatformName,
        captionOverride: row.captionOverride,
        attempts: Number(row.attempts),
        caption: row.caption,
        textOnly: row.textOnly === true,
      }));
    },

    async getMediaUrls(postId) {
      const media = await prisma.postMedia.findMany({
        where: { postId },
        orderBy: { slideIndex: "asc" },
        select: { url: true },
      });
      return media.map((row) => row.url);
    },

    async getAccount(platform) {
      const row = await prisma.socialAccount.findFirst({
        where: { platform },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          platform: true,
          externalId: true,
          displayName: true,
          accessTokenEnc: true,
          refreshTokenEnc: true,
          expiresAt: true,
        },
      });
      if (!row) return null;
      return {
        ...row,
        platform: row.platform as PlatformName,
      };
    },

    async markPublished(targetId, input) {
      await prisma.postTarget.update({
        where: { id: targetId },
        data: {
          status: "published",
          externalPostId: input.externalPostId,
          publishedAt: input.publishedAt,
          lastError: null,
          nextAttemptAt: null,
          processingStartedAt: null,
          requiresReconnect: false,
          notes: input.notes ?? null,
        },
      });
    },

    async markFailure(targetId, input) {
      await prisma.postTarget.update({
        where: { id: targetId },
        data: {
          status: input.status,
          lastError: input.lastError,
          nextAttemptAt: input.nextAttemptAt,
          processingStartedAt: null,
          requiresReconnect: input.requiresReconnect,
        },
      });
    },

    async recomputePostStatus(postId) {
      const targets = await prisma.postTarget.findMany({
        where: { postId },
        select: { status: true },
      });
      const status = computePostStatus(targets.map((target) => target.status));
      await prisma.post.updateMany({ where: { id: postId }, data: { status } });
      return status;
    },
  };
}
