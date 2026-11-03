import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dispatchDue } from "../lib/dispatcher";
import { createImageStore, keyFromPublicUrl } from "../lib/image-store";
import { parsePostCreate } from "../lib/post-request";
import { getPrisma } from "../lib/prisma";
import { telegramPublisher } from "../lib/publishers/telegram";
import { PublishError, type Publisher } from "../lib/publishers/types";
import {
  deleteStaleImages,
  renderPost,
  type PostMediaRow,
} from "../lib/render-post";

export const SAMPLE_TEXT = `CodeSync Hub scheduler test.

This post was created directly with the same validation, rendering and database code the Posts API uses. It exists so scheduled publishing, retries and backoff can be watched without touching the dashboard.

LinkedIn and Telegram are the only targets. Both captions say this is a test, and it is safe to delete the posts when the run is finished.`;

const PLATFORM_LABELS = {
  linkedin: "LinkedIn",
  telegram: "Telegram",
} as const;

type TestPlatform = keyof typeof PLATFORM_LABELS;

const TWO_MINUTES_MS = 2 * 60 * 1000;
const LOOP_INTERVAL_MS = 20 * 1000;
const MAX_RUN_MS = 5 * 60 * 1000;

type Options = {
  now: boolean;
  failTelegram: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { now: false, failTelegram: false };

  for (const arg of argv) {
    if (arg === "--now") {
      options.now = true;
    } else if (arg === "--fail-telegram") {
      options.failTelegram = true;
    } else {
      throw new Error(
        `Unknown argument: ${arg}\n` +
          "Usage: pnpm exec tsx --env-file=.env.local scripts/schedule-test.ts [--now] [--fail-telegram]",
      );
    }
  }

  return options;
}

function captionFor(platform: TestPlatform, images: number): string {
  return (
    `CodeSync Hub publisher test on ${PLATFORM_LABELS[platform]}: ` +
    `${images} image${images === 1 ? "" : "s"}. Safe to delete.`
  );
}

function mediaKeys(media: PostMediaRow[]): string[] {
  return media
    .map((row) => keyFromPublicUrl(row.url))
    .filter((key): key is string => key !== null);
}

function failingTelegramPublisher(): Publisher {
  return {
    platform: "telegram",
    maxImages: telegramPublisher.maxImages,
    maxCaptionLength: telegramPublisher.maxCaptionLength,
    async publish() {
      throw PublishError.network(
        "telegram",
        "schedule-test: Telegram was deliberately broken for this run. This will be retried.",
      );
    },
  };
}

function oneLine(value: string | null): string {
  const text = value?.replace(/\s+/g, " ").trim();
  return text && text.length > 0 ? text : "-";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prisma = getPrisma();

  try {
    const now = new Date();
    const scheduledAt = options.now ? now : new Date(now.getTime() + TWO_MINUTES_MS);
    const id = randomUUID();
    const store = createImageStore();

    const rendered = await renderPost(
      {
        id,
        bodyText: SAMPLE_TEXT,
        code: null,
        contentType: "text",
        language: null,
        backgroundMode: "solid",
        bgUrl: null,
        bgAuthorName: null,
        bgAuthorUrl: null,
      },
      store,
    );

    const slideCount = rendered.media.length;
    const caption = `CodeSync Hub scheduler test: ${slideCount} image${slideCount === 1 ? "" : "s"}. Safe to delete.`;
    const parsed = parsePostCreate(
      {
        text: SAMPLE_TEXT,
        content_type: "text",
        code: null,
        language: null,
        theme: "default",
        caption,
        carousel_mode: "auto",
        source: "manual",
        status: "scheduled",
        scheduled_at: scheduledAt.toISOString(),
        background: { mode: "solid" },
        targets: (Object.keys(PLATFORM_LABELS) as TestPlatform[]).map((platform) => ({
          platform,
          captionOverride: captionFor(platform, slideCount),
        })),
      },
      options.now ? { now: new Date(now.getTime() - 1_000) } : { now },
    );

    if (!parsed.ok) {
      await deleteStaleImages(mediaKeys(rendered.media), store);
      throw new Error(parsed.error);
    }

    const input = parsed.value;

    try {
      await prisma.post.create({
        data: {
          id,
          title: input.title,
          bodyText: input.bodyText,
          contentType: input.contentType,
          code: input.code,
          language: input.language,
          theme: input.theme,
          caption: input.caption,
          carouselMode: input.carouselMode,
          source: input.source,
          aiPrompt: input.aiPrompt,
          status: input.status,
          scheduledAt: input.scheduledAt,
          ...input.background,
          media: {
            create: rendered.media.map((row) => ({
              slideIndex: row.slideIndex,
              url: row.url,
              width: row.width,
              height: row.height,
            })),
          },
          targets: {
            create: input.targets.map((target) => ({
              platform: target.platform,
              captionOverride: target.captionOverride,
            })),
          },
        },
      });
    } catch (error) {
      await deleteStaleImages(mediaKeys(rendered.media), store);
      throw error;
    }

    await deleteStaleImages(rendered.staleKeys, store);

    console.log(`Post id: ${id}`);
    console.log(
      `Scheduled at: ${scheduledAt.toISOString()}${options.now ? " (immediate)" : ""}`,
    );
    console.log(`Slides: ${slideCount}`);

    if (options.failTelegram) {
      console.log(
        "Telegram will fail with a retryable network error for this run; real config is unchanged.",
      );
    }

    const publishers = options.failTelegram
      ? { telegram: failingTelegramPublisher() }
      : undefined;

    const started = Date.now();

    while (true) {
      const summary = await dispatchDue({
        postId: id,
        ...(publishers ? { publishers } : {}),
      });

      const targets = await prisma.postTarget.findMany({
        where: { postId: id },
        orderBy: { platform: "asc" },
        select: {
          platform: true,
          status: true,
          attempts: true,
          notes: true,
          lastError: true,
          nextAttemptAt: true,
          requiresReconnect: true,
        },
      });

      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(
        `\n[+${elapsed}s] claimed=${summary.claimed} published=${summary.published} ` +
          `retried=${summary.retried} failed=${summary.failed}`,
      );

      for (const target of targets) {
        const label = PLATFORM_LABELS[target.platform as TestPlatform] ?? target.platform;
        console.log(
          `  ${label.padEnd(8)} status=${target.status} attempts=${target.attempts} ` +
            `notes=${oneLine(target.notes)} last_error=${oneLine(target.lastError)} ` +
            `next_attempt=${target.nextAttemptAt?.toISOString() ?? "-"} ` +
            `requires_reconnect=${target.requiresReconnect}`,
        );
      }

      if (
        targets.length > 0 &&
        targets.every(
          (target) => target.status === "published" || target.status === "failed",
        )
      ) {
        console.log("\nAll targets are finished.");
        return;
      }

      const remaining = MAX_RUN_MS - (Date.now() - started);
      if (remaining <= 0) {
        console.log(
          "\nStopped after 5 minutes; at least one target is still pending. Delete the test post when done.",
        );
        process.exitCode = 1;
        return;
      }

      const wait = Math.min(LOOP_INTERVAL_MS, remaining);
      console.log(`Waiting ${Math.round(wait / 1000)}s...`);
      await sleep(wait);
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error("\nSchedule test failed.");
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
