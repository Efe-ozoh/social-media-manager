/**
 * Manual end-to-end check for the publishers — SPEC sections 6 and 7.
 *
 *   npx tsx scripts/publish-test.ts                        LinkedIn, one image
 *   npx tsx scripts/publish-test.ts --multi                LinkedIn, then three
 *   npx tsx scripts/publish-test.ts --facebook             a Facebook Page post
 *   npx tsx scripts/publish-test.ts --instagram --multi    Instagram, then three
 *   npx tsx scripts/publish-test.ts --facebook --instagram both Meta platforms
 *
 * With no platform flag it publishes to LinkedIn, which is what this script
 * did when only LinkedIn was implemented.
 *
 * What it does, in order:
 *   1. loads the most recently updated account per selected platform from
 *      social_accounts, and stops with a clear message if it is missing,
 *      undecryptable or expired;
 *   2. renders the fixed sample below through the real renderer and the real
 *      image store — Vercel Blob when BLOB_READ_WRITE_TOKEN is set, local disk
 *      otherwise — so the slides published here are the slides a real post
 *      publishes;
 *   3. publishes one image, and with --multi three images.
 *
 * Facebook and Instagram fetch the images from their own servers, so they need
 * public HTTPS slide URLs; with the local disk store this script says so and
 * stops. LinkedIn uploads the bytes itself, so localhost URLs work there.
 *
 * It prints each post's URN or media id and any notes. It never prints a
 * token: the token is decrypted into memory, handed to the publisher and
 * nothing else.
 *
 * These are real, public posts. Every caption says it is a test; delete them
 * from the accounts afterwards.
 */

import { config } from "dotenv";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TokenCryptoError } from "../lib/crypto";
import type { PostMediaRow } from "../lib/render-post";
import {
  PublishError,
  type Publisher,
  type SocialAccount,
} from "../lib/publishers/types";

// Next.js reads .env.local; tsx does not, so do it before anything reads env.
// (dotenv never overrides a variable that is already set.)
config({ path: path.join(process.cwd(), ".env.local"), quiet: true });
config({ path: path.join(process.cwd(), ".env"), quiet: true });

/**
 * The content of the test carousel. Long enough to split into three slides,
 * which is what --multi needs, and short enough to read on a phone.
 */
export const SAMPLE_TEXT = `Every post in CodeSync Hub is written once and published everywhere. This one exists so the LinkedIn publisher can be exercised against the real API, with real slides, before the scheduler goes anywhere near a live account.

The cards you are reading were split and rendered on your own machine a few seconds ago. Nothing was uploaded until the publisher asked for the images, and every slide is a fixed 1080 by 1350 pixel PNG.

The first post below carries one image, because a single-image post is the path every LinkedIn app may take. The second run, with --multi, sends three, which uses the multi-image endpoint that not every app type is allowed to call.

If LinkedIn refuses the multi-image request, the publisher posts the first slide on its own and says so in its notes. That fallback is the reason this script prints notes at all: a quiet downgrade is easy to miss in a feed.

Line numbers, syntax colours and the slide footer appear on code cards, so a reader can point at a line in the comments. Text cards like this one are set in a proportional font, because a wall of monospace is harder to read than it looks.

Delete both test posts from your feed when you are done. They are markers, not content: the point was to prove that the stored token, the render and the upload line up, and that is now either true or plainly not.`;

type TestPlatform = "linkedin" | "facebook" | "instagram";

const PLATFORM_LABELS: Record<TestPlatform, string> = {
  linkedin: "LinkedIn",
  facebook: "Facebook Page",
  instagram: "Instagram",
};

const PLATFORM_FLAGS: Record<string, TestPlatform> = {
  "--linkedin": "linkedin",
  "--facebook": "facebook",
  "--instagram": "instagram",
};

/** Every caption says it is a test, so the posts are obvious in a feed. */
function captionFor(platform: TestPlatform, images: number): string {
  return (
    `CodeSync Hub publisher test on ${PLATFORM_LABELS[platform]}: ` +
    `${images} image${images === 1 ? "" : "s"}. Safe to delete.`
  );
}

/** Deterministic, so re-running overwrites the same storage keys. */
const TEST_POST_ID = "linkedin-publish-test";

/** Slides the --multi step publishes. */
const MULTI_SLIDE_COUNT = 3;

/** A failure this script can explain, with the steps that fix it. */
class TestError extends Error {
  readonly hints: string[];

  constructor(message: string, hints: string[] = []) {
    super(message);
    this.name = "TestError";
    this.hints = hints;
  }
}

function appUrl(): string {
  return (process.env.APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

function connectHints(platform: TestPlatform): string[] {
  if (platform === "linkedin") {
    return [
      `Connect the account: ${appUrl()}/api/auth/linkedin/start (sign in to the app first).`,
      "That route needs LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY in .env.local.",
    ];
  }

  return [
    `Connect it: ${appUrl()}/api/auth/meta/start (sign in to the app first).`,
    "That route needs META_APP_ID, META_APP_SECRET and TOKEN_ENCRYPTION_KEY in .env.local.",
    "One Meta consent stores the Page and its linked Instagram account together.",
  ];
}

/**
 * One useful sentence from an error. Prisma echoes the query first and puts
 * the actual cause last, so those errors are read from the bottom.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";

  const lines = error.message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return error.name;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("P") && lines.length > 1) {
    return `${lines[lines.length - 1]} (${code})`;
  }
  return lines[0];
}

function parseArgs(argv: string[]): { multi: boolean; platforms: TestPlatform[] } {
  const options: { multi: boolean; platforms: TestPlatform[] } = {
    multi: false,
    platforms: [],
  };

  for (const arg of argv) {
    if (arg === "--multi") {
      options.multi = true;
      continue;
    }

    const platform = PLATFORM_FLAGS[arg];
    if (!platform) {
      throw new TestError(`Unknown argument: ${arg}`, [
        "Usage: npx tsx scripts/publish-test.ts [--linkedin|--facebook|--instagram] [--multi]",
        "  (no platform flag)  publish to LinkedIn",
        "  --linkedin          publish to the connected LinkedIn member",
        "  --facebook          publish to the connected Facebook Page",
        "  --instagram         publish to the connected Instagram account",
        "  --multi             also publish the first three slides as a carousel",
      ]);
    }
    if (!options.platforms.includes(platform)) options.platforms.push(platform);
  }

  if (options.platforms.length === 0) options.platforms.push("linkedin");
  return options;
}

/**
 * The most recently connected account for one platform. Several rows can
 * exist (one per member or Page), so this uses the newest, which means a
 * fresh reconnect is picked up.
 */
async function loadAccount(platform: TestPlatform): Promise<SocialAccount> {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new TestError("DATABASE_URL is not set, so the connected account cannot be read.", [
      "Add DATABASE_URL to .env.local, then run \"npm run db:migrate\".",
    ]);
  }

  const { getPrisma } = await import("../lib/prisma");
  const prisma = getPrisma();

  let rows;
  try {
    rows = await prisma.socialAccount.findMany({
      where: { platform },
      orderBy: { updatedAt: "desc" },
    });
  } catch (error) {
    throw new TestError(`Could not read social_accounts: ${describeError(error)}`, [
      "Is DATABASE_URL right, and is the database migrated? Try \"npm run db:migrate\".",
    ]);
  }

  const label = PLATFORM_LABELS[platform];
  if (rows.length === 0) {
    throw new TestError(`No connected ${label} account was found in the database.`, [
      "Connect one first:",
      ...connectHints(platform).map((line) => `  ${line}`),
      "Then run this script again.",
    ]);
  }

  const row = rows[0];
  if (rows.length > 1) {
    console.log(`Note: ${rows.length} ${label} accounts are stored; using the newest one.`);
  }

  const { toSocialAccount } = await import("../lib/publishers/types");
  let account: SocialAccount;
  try {
    account = toSocialAccount(row);
  } catch (error) {
    if (error instanceof TokenCryptoError) {
      throw new TestError(`The stored ${label} token could not be decrypted: ${error.message}`, [
        "TOKEN_ENCRYPTION_KEY must be the same key that was used when the account was connected.",
        ...connectHints(platform),
      ]);
    }
    throw error;
  }

  console.log(`\n${label} account: ${account.displayName} (${account.externalId})`);

  if (account.expiresAt && account.expiresAt.getTime() <= Date.now()) {
    throw new TestError(
      `The stored ${label} access token expired on ${account.expiresAt.toISOString()}.`,
      connectHints(platform),
    );
  }
  if (account.expiresAt) {
    const days = Math.floor((account.expiresAt.getTime() - Date.now()) / 86_400_000);
    console.log(`Token expires ${account.expiresAt.toISOString()} (~${days} days).`);
  } else if (platform === "facebook") {
    console.log("Token has no stored expiry; a long-lived Page token is documented as not expiring.");
  } else if (platform === "linkedin") {
    console.log("Token has no stored expiry; LinkedIn's default is about 60 days.");
  } else {
    console.log("Token has no stored expiry.");
  }

  return account;
}

/** The publisher the dispatcher would use for this platform. */
async function publisherFor(platform: TestPlatform): Promise<Publisher> {
  if (platform === "linkedin") {
    const { linkedinPublisher } = await import("../lib/publishers/linkedin");
    return linkedinPublisher;
  }
  if (platform === "facebook") {
    const { facebookPublisher } = await import("../lib/publishers/facebook");
    return facebookPublisher;
  }
  const { instagramPublisher } = await import("../lib/publishers/instagram");
  return instagramPublisher;
}

/**
 * The local disk store serves slides from APP_URL, so the app has to be
 * running for the publisher to download them. Only LinkedIn can use those
 * URLs — it uploads the bytes itself — and main() refuses Facebook and
 * Instagram before reaching this point when the store is local.
 */
async function assertSlidesReachable(urls: string[]): Promise<void> {
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TestError(`The image store returned an unusable URL: ${url}`);
    }

    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (!local) continue;

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      throw new TestError(
        `The slide at ${url} is not reachable (${describeError(error)}).`,
        [
          "Without BLOB_READ_WRITE_TOKEN, slides are written to public/uploads and served by the app.",
          "Start \"npm run dev\" in another terminal (so APP_URL answers) and run this script again,",
          "or set BLOB_READ_WRITE_TOKEN to upload to Vercel Blob instead.",
        ],
      );
    }
  }
}

/**
 * Renders the sample through the real renderer and image store, so what gets
 * published is exactly what a real post would publish. Exported so this step
 * can be checked on its own, with no connected account.
 */
export async function prepareCarousel(): Promise<{
  media: PostMediaRow[];
  slideCount: number;
  renderedSlideCount: number;
  background: "photo" | "solid";
}> {
  const [{ renderPost }, { createImageStore }, { splitSlides }] = await Promise.all([
    import("../lib/render-post"),
    import("../lib/image-store"),
    import("../lib/splitter"),
  ]);

  const store = createImageStore();
  console.log(`Image store: ${store.kind}`);

  const split = splitSlides({ text: SAMPLE_TEXT, contentType: "text" });
  const render = await renderPost(
    {
      id: TEST_POST_ID,
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

  if (render.media.length === 0) {
    throw new TestError("The renderer produced no slides, so there is nothing to publish.");
  }

  console.log(
    `Rendered ${render.renderedSlideCount} slide(s) of ${split.slideCount} ` +
      `(${render.media[0].width}x${render.media[0].height}, ${render.background} background).`,
  );
  for (const row of render.media) {
    console.log(`  slide ${row.slideIndex + 1}: ${row.url}`);
  }
  await assertSlidesReachable(render.media.map((row) => row.url));

  return {
    media: render.media,
    slideCount: split.slideCount,
    renderedSlideCount: render.renderedSlideCount,
    background: render.background,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Meta fetches the slides itself, so a local disk store cannot work there.
  // Checked before rendering so the failure explains the fix, not a dead URL.
  const metaPlatforms = options.platforms.filter((platform) => platform !== "linkedin");
  if (metaPlatforms.length > 0) {
    const { createImageStore } = await import("../lib/image-store");
    if (createImageStore().kind === "local-disk") {
      throw new TestError(
        `Cannot publish to ${metaPlatforms.map((p) => PLATFORM_LABELS[p]).join(" or ")} with the ` +
          "local disk image store: Meta fetches slides from its own servers and cannot reach localhost.",
        [
          "Set BLOB_READ_WRITE_TOKEN in .env.local so slides are hosted at public HTTPS URLs,",
          "then run this script again. LinkedIn is unaffected: it uploads the image bytes itself.",
        ],
      );
    }
  }

  // Fail on a missing connection before spending time rendering.
  const accounts = new Map<TestPlatform, SocialAccount>();
  for (const platform of options.platforms) {
    accounts.set(platform, await loadAccount(platform));
  }

  const carousel = await prepareCarousel();

  if (options.multi && carousel.media.length < MULTI_SLIDE_COUNT) {
    throw new TestError(
      `--multi needs ${MULTI_SLIDE_COUNT} slides, but the sample rendered ${carousel.media.length}.`,
      ["Lengthen SAMPLE_TEXT in this script so it splits into at least three slides."],
    );
  }

  const published: { label: string; id: string }[] = [];

  for (const platform of options.platforms) {
    const account = accounts.get(platform) as SocialAccount;
    const publisher = await publisherFor(platform);

    const run = async (label: string, urls: string[]) => {
      console.log(`\n[${PLATFORM_LABELS[platform]}] ${label}`);
      console.log(`  publishing ${urls.length} image(s) as ${account.displayName}...`);

      const started = Date.now();
      const result = await publisher.publish({
        caption: captionFor(platform, urls.length),
        imageUrls: urls,
        account,
      });

      console.log(`  post id: ${result.externalPostId}`);
      console.log(
        `  notes: ${result.notes && result.notes.length > 0 ? result.notes.join(" | ") : "none"}`,
      );
      console.log(`  took ${((Date.now() - started) / 1000).toFixed(1)}s`);

      published.push({ label: `${PLATFORM_LABELS[platform]} — ${label}`, id: result.externalPostId });
    };

    await run("one image", [carousel.media[0].url]);

    if (options.multi) {
      await run(
        `${MULTI_SLIDE_COUNT} images (--multi)`,
        carousel.media.slice(0, MULTI_SLIDE_COUNT).map((row) => row.url),
      );
    }
  }

  console.log("\nDone.");
  for (const entry of published) console.log(`  ${entry.label}: ${entry.id}`);
  console.log("Check the posts on each platform, then delete them.");
}

function reportFailure(error: unknown): void {
  console.error("\n✖ Publish test failed.");

  if (error instanceof TestError) {
    console.error(`  ${error.message}`);
    for (const hint of error.hints) console.error(`  ${hint}`);
    return;
  }

  if (error instanceof PublishError) {
    // Messages and details are already redacted by the publisher.
    console.error(`  ${error.platform ?? "provider"} ${error.code}: ${error.message}`);
    if (error.detail) console.error(`  detail: ${error.detail}`);
    console.error(`  retryable: ${error.retryable ? "yes" : "no"}`);
    if (error.requiresReconnect) {
      const platform = (error.platform ?? "linkedin") as TestPlatform;
      for (const hint of connectHints(platform)) console.error(`  ${hint}`);
    }
    return;
  }

  console.error(`  ${describeError(error)}`);
  if (process.env.DEBUG) console.error(error);
}

// Importing this module (to reuse SAMPLE_TEXT) must not publish anything.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    reportFailure(error);
    process.exit(1);
  });
}
