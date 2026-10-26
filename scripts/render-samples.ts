import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createElement } from "react";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import {
  renderSlidesPng,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type BackgroundImage,
} from "../lib/renderer";
import { splitSlides, type SplitInput } from "../lib/splitter";
import {
  fetchBackgroundImage,
  hasUnsplashAccessKey,
  searchPortraitPhotos,
} from "../lib/unsplash";

/**
 * Renders five sample posts into out/ so the PNGs can be eyeballed:
 *
 *   out/short-text-1.png        one slide, no "1 / 1" indicator
 *   out/long-text-1..n.png      several proportional-font slides
 *   out/long-code-1..n.png      several monospace slides with line numbers
 *   out/text-unsplash-1..n.png  photo background via Unsplash, credited on
 *                               slide 1 (skipped when UNSPLASH_ACCESS_KEY is
 *                               not set — the app then uses solid cards)
 *   out/text-local-photo-1..n.png  a generated local image as the background,
 *                               so the overlay and text shadow can be checked
 *                               without an API key
 *
 * Run with: npm run render:samples
 *
 * This is a preview: it never calls Unsplash's download-tracking endpoint.
 */

const OUT_DIR = path.resolve("out");

const requireFromHere = createRequire(import.meta.url);

const SHORT_TEXT = `CodeSync Hub writes a post once and publishes it to LinkedIn, Facebook and Instagram. The renderer turns that post into fixed 1080 x 1350 slides before anything leaves your machine.`;

const LONG_TEXT = `Writing a post should feel like writing, not like formatting. You type the words, choose the platforms, and the app takes care of the rest.

Slides are fixed at 1080 by 1350 pixels, which is the 4:5 ratio every network in scope accepts. Nothing is resized on the way out, so what you preview is what gets published.

Long content is split into cards. A paragraph that would overflow a card breaks at a sentence, and a sentence that would overflow anyway breaks at a word. The break lands on a blank line or the end of a block when one is close enough, so a slide rarely ends in the middle of a thought.

Code gets its own treatment. It is set in a monospace font, colored by the language, and numbered down the left so a reader can refer to a line in the comments.

Every card carries a small footer once there is more than one of them, reading 2 / 5 and so on, so a reader always knows where they are in the carousel.

The whole point of doing this on your own infrastructure is that the tokens, the renders and the schedule stay with you. Nothing is uploaded until you press publish, and the renderer itself never touches the network.`;

const PHOTO_TEXT = `Some posts read better on a photograph than on a flat colour. A landscape or a texture behind the words gives a carousel a mood that a solid card cannot.

The photo sits full-bleed under a dark overlay, so the type stays as readable on a bright sky as it is on a night street. Text gets a soft shadow as a second layer of contrast.

Unsplash supplies the images. The picker searches portrait shots, and each result arrives already cropped to the slide size, so nothing is stretched or letterboxed on the way in.

Crediting the photographer is part of the deal. The first slide carries a quiet "Photo by" line with their name, linked back to their Unsplash profile.

Pick a photo per post, preview it, and change your mind as often as you like. Nothing is published until you schedule it.`;

const LONG_CODE = `type Job = {
  id: string;
  postId: string;
  runAt: Date;
  attempts: number;
};

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];

export function isDue(job: Job, now: Date): boolean {
  return job.runAt.getTime() <= now.getTime();
}

export function nextAttempt(job: Job, error: Error): Job {
  const attempts = job.attempts + 1;
  if (attempts > MAX_ATTEMPTS) {
    throw new Error(\`job \${job.id} exhausted: \${error.message}\`);
  }

  const index = Math.min(attempts - 1, BACKOFF_MS.length - 1);
  const delay = BACKOFF_MS[index];

  return {
    ...job,
    attempts,
    runAt: new Date(job.runAt.getTime() + delay),
  };
}

export async function dispatch(
  jobs: Job[],
  now = new Date(),
): Promise<{ done: Job[]; failed: Job[] }> {
  const done: Job[] = [];
  const failed: Job[] = [];

  for (const job of jobs) {
    if (!isDue(job, now)) continue;

    try {
      await publish(job.postId);
      done.push(job);
    } catch (error) {
      if (error instanceof Error && error.message === "locked") {
        continue;
      }

      const retried = nextAttempt(job, error as Error);
      if (retried.attempts > MAX_ATTEMPTS) {
        failed.push(retried);
      } else {
        queue.push(retried);
      }
    }
  }

  return { done, failed };
}

// Two dispatchers must never publish the same post twice: the row lock is
// taken before the status is read, and released only after the write lands.
async function publish(postId: string): Promise<void> {
  const row = await db.post.update({
    where: { id: postId },
    data: { status: "processing" },
  });

  await metaverse.upload(row);
}`;

type Sample = {
  name: string;
  input: SplitInput;
  /** Undefined renders the solid theme. */
  background?: BackgroundImage;
};

/**
 * A photo-like test image made locally, so the overlay is checkable with no
 * API key. Rendered once with Satori and reused for every slide.
 */
async function makeLocalTestImage(): Promise<Buffer> {
  const font = await readFile(
    requireFromHere.resolve("@fontsource/geist-sans/files/geist-sans-latin-700-normal.woff2"),
  );

  const layer = (style: Record<string, number | string>) =>
    createElement("div", { style: { position: "absolute", display: "flex", ...style } });

  const element = createElement(
    "div",
    {
      style: {
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        position: "relative",
        display: "flex",
        background: "linear-gradient(165deg, #0b2a4a 0%, #2f6fb3 52%, #f2b134 100%)",
      },
    },
    // A sun low on the frame.
    layer({
      left: 470,
      top: 300,
      width: 430,
      height: 430,
      borderRadius: 215,
      background: "rgba(255, 244, 214, 0.92)",
    }),
    // Two hills, so the overlay has bright and dark areas to sit over.
    layer({
      left: -160,
      top: 820,
      width: 900,
      height: 900,
      borderRadius: 450,
      background: "rgba(10, 34, 41, 0.85)",
    }),
    layer({
      left: 480,
      top: 940,
      width: 900,
      height: 900,
      borderRadius: 450,
      background: "rgba(6, 22, 30, 0.9)",
    }),
    // A bright band near the top, where white text is hardest to read.
    layer({
      left: 0,
      top: 120,
      width: SLIDE_WIDTH,
      height: 240,
      background: "rgba(255, 255, 255, 0.28)",
    }),
  );

  const svg = await satori(element, {
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    fonts: [{ name: "Geist Sans", data: font, weight: 700, style: "normal" }],
  });

  return new Resvg(svg).render().asPng();
}

/** Builds the Unsplash sample, or explains why it was skipped. */
async function unsplashSample(): Promise<
  { background: BackgroundImage; credit: string } | { reason: string }
> {
  if (!hasUnsplashAccessKey()) {
    return { reason: "UNSPLASH_ACCESS_KEY is not set" };
  }

  const result = await searchPortraitPhotos("calm mountain lake", 6);
  if (result.error) return { reason: result.error };
  if (result.photos.length === 0) return { reason: "no photos matched" };

  // Try each result until one downloads; a single broken URL is not fatal.
  for (const photo of result.photos) {
    const data = await fetchBackgroundImage(photo.url);
    if (!data) continue;
    return {
      background: {
        data,
        attribution: { name: photo.authorName, url: photo.authorUrl },
      },
      credit: photo.attribution,
    };
  }

  return { reason: "could not download any of the photos" };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const samples: Sample[] = [
    { name: "short-text", input: { text: SHORT_TEXT, contentType: "text" } },
    { name: "long-text", input: { text: LONG_TEXT, contentType: "text" } },
    {
      name: "long-code",
      input: { text: LONG_CODE, contentType: "code", language: "typescript" },
    },
  ];

  const unsplash = await unsplashSample();
  if ("background" in unsplash) {
    samples.push({
      name: "text-unsplash",
      input: { text: PHOTO_TEXT, contentType: "text" },
      background: unsplash.background,
    });
    console.log(`text-unsplash: using ${unsplash.credit}`);
  } else {
    console.log(`text-unsplash: skipped (${unsplash.reason})`);
  }

  samples.push({
    name: "text-local-photo",
    input: { text: PHOTO_TEXT, contentType: "text" },
    background: { data: await makeLocalTestImage() },
  });
  console.log("text-local-photo: using a generated local test image");

  for (const sample of samples) {
    const split = splitSlides(sample.input);
    const pngs = await renderSlidesPng(split, { background: sample.background });

    console.log(
      `${sample.name}: ${split.slideCount} slide(s), ` +
        `indicator=${split.showIndicator}, tooLong=${split.tooLong}, ` +
        `background=${sample.background ? "photo" : "solid"}`,
    );

    for (const [index, png] of pngs.entries()) {
      const file = path.join(OUT_DIR, `${sample.name}-${index + 1}.png`);
      await writeFile(file, png);
      console.log(`  ${path.relative(process.cwd(), file)} (${png.length} bytes)`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
