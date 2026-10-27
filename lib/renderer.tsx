/**
 * Slide renderer — SPEC section 8, "Slide format" and "Rendering and storage".
 *
 * Takes the splitter's slides and renders each one to a fixed-size PNG with
 * Satori (JSX -> SVG, text embedded as glyph paths) and resvg (SVG -> PNG).
 * Shiki colors code cards; cards carry bundled Geist fonts, line numbers for
 * code, and a "2 / 5" footer indicator when the splitter set showIndicator.
 *
 * An optional background photo is drawn full-bleed under a dark overlay, with
 * a text shadow and a "Photo by {name} on Unsplash" credit on the first slide.
 * Code cards stay solid unless `usePhotoBehindCode` is set.
 *
 * Pure rendering: the PNG bytes are returned to the caller. No image upload,
 * no database, no network — a background is passed in as bytes.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReactNode } from "react";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import type {
  ResolvedSplitterConfig,
  Slide,
  SplitContentType,
  SplitResult,
} from "./splitter";

/** SPEC section 8: fixed size 1080 x 1350 px (4:5) for all slides. */
export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;

const MONO_FAMILY = "Geist Mono";
const SANS_FAMILY = "Geist Sans";

const MONO_PKG = "@fontsource/geist-mono";
const SANS_PKG = "@fontsource/geist-sans";

/** Shiki theme for the dark code card. */
const CODE_THEME = "github-dark";

type SlideTheme = {
  background: string;
  foreground: string;
  /** Line numbers and the footer indicator. */
  muted: string;
  fontFamily: string;
};

/** Themed background per card type (SPEC: "Themed background"). */
const THEMES: Record<SplitContentType, SlideTheme> = {
  code: {
    background: "#0d1117",
    foreground: "#e6edf3",
    muted: "#7d8590",
    fontFamily: MONO_FAMILY,
  },
  text: {
    background: "#faf9f7",
    foreground: "#18181b",
    muted: "#71717a",
    fontFamily: SANS_FAMILY,
  },
};

/**
 * A background photo, already cropped to the slide size by the caller (the
 * Unsplash URLs in lib/unsplash.ts ask imgix for 1080 x 1350). Bytes or a data
 * URI only: the renderer never fetches anything.
 */
export type BackgroundImage = {
  /** JPEG, PNG or WebP bytes, or an already-built `data:image/...` URI. */
  data: Buffer | Uint8Array | string;
  /** Unsplash credit, drawn on the first slide only. */
  attribution?: { name: string; url?: string };
};

export type SlideBackgroundOptions = {
  background?: BackgroundImage | null;
  /** Off by default: code cards keep their solid theme (SPEC slide format). */
  usePhotoBehindCode?: boolean;
};

/** ~55% black keeps light slide text readable over any photo. */
const PHOTO_OVERLAY = "rgba(0, 0, 0, 0.55)";
const PHOTO_TEXT_SHADOW = "0 2px 12px rgba(0, 0, 0, 0.6)";

/**
 * Photo-safe colours: white ink on the overlay. Code keeps its Shiki palette
 * (only the muted line numbers are lifted), since colouring is its meaning.
 */
function resolveTheme(contentType: SplitContentType, usesPhoto: boolean): SlideTheme {
  const base = THEMES[contentType];
  if (!usesPhoto) return base;
  return contentType === "text"
    ? { ...base, foreground: "#ffffff", muted: "rgba(255, 255, 255, 0.85)" }
    : { ...base, muted: "#c9d1d9" };
}

type SatoriFont = {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
};

type ColoredToken = { content: string; color?: string };

/**
 * Satori needs the raw woff2 bytes, so fonts are read from node_modules at
 * runtime. Resolving them through the bundler would make Turbopack try to
 * inline every candidate path (a computed require it cannot resolve).
 */
function fontFile(pkg: string, file: string): string {
  return path.join(process.cwd(), "node_modules", ...pkg.split("/"), "files", file);
}

let fontsPromise: Promise<SatoriFont[]> | undefined;

/** Bundled font files — the SPEC forbids depending on system fonts. */
function getFonts(): Promise<SatoriFont[]> {
  fontsPromise ??= (async () => {
    const specs: { pkg: string; file: string; name: string; weight: 400 | 700 }[] = [
      { pkg: MONO_PKG, file: "geist-mono-latin-400-normal.woff2", name: MONO_FAMILY, weight: 400 },
      { pkg: MONO_PKG, file: "geist-mono-latin-700-normal.woff2", name: MONO_FAMILY, weight: 700 },
      { pkg: SANS_PKG, file: "geist-sans-latin-400-normal.woff2", name: SANS_FAMILY, weight: 400 },
      { pkg: SANS_PKG, file: "geist-sans-latin-700-normal.woff2", name: SANS_FAMILY, weight: 700 },
    ];

    return Promise.all(
      specs.map(async (spec) => ({
        name: spec.name,
        weight: spec.weight,
        style: "normal" as const,
        data: await readFile(fontFile(spec.pkg, spec.file)),
      })),
    );
  })();
  return fontsPromise;
}

const CODE_LANGS: BundledLanguage[] = [
  "typescript",
  "javascript",
  "json",
  "css",
  "html",
  "bash",
  "python",
  "markdown",
  "yaml",
  "sql",
];

const LANG_ALIASES: Record<string, BundledLanguage> = {
  ts: "typescript",
  js: "javascript",
  jsx: "jsx",
  tsx: "tsx",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
};

let highlighterPromise: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [CODE_THEME], langs: CODE_LANGS });
  return highlighterPromise;
}

/**
 * Colorizes one slide. Tokenizing the slide's own lines keeps multi-line
 * constructs (strings, comments) colored inside the slide; a slide that
 * starts mid-block restarts the grammar, which is the trade-off of taking
 * only slides as input.
 */
async function tokensForSlide(
  slide: Slide,
  language: string | null,
  fallback: string,
): Promise<ColoredToken[][]> {
  const plain = (): ColoredToken[][] =>
    slide.lines.map((line) => [{ content: line.text, color: fallback }]);

  if (!language || slide.lines.length === 0) return plain();

  try {
    const highlighter = await getHighlighter();
    const loaded: string[] = highlighter.getLoadedLanguages();
    const wanted: string[] = [language, LANG_ALIASES[language]].filter(
      (candidate): candidate is string => typeof candidate === "string",
    );
    const lang = wanted.find((candidate) => loaded.includes(candidate));
    if (!lang) return plain();

    const source = slide.lines.map((line) => line.text).join("\n");
    // Safe: `lang` came from getLoadedLanguages(), so Shiki can load it.
    const { tokens } = highlighter.codeToTokens(source, {
      lang: lang as BundledLanguage,
      theme: CODE_THEME,
    });

    return slide.lines.map((line, index) => {
      const tokensForLine = tokens[index];
      return tokensForLine && tokensForLine.length > 0
        ? tokensForLine.map((token) => ({ content: token.content, color: token.color }))
        : [{ content: line.text, color: fallback }];
    });
  } catch {
    return plain();
  }
}

export type SlideRenderInput = {
  /** One slide straight out of `splitSlides()`. */
  slide: Slide;
  /** 0-based position of the slide in the post. */
  index: number;
  /** Total slide count, shown in the "2 / 5" indicator. */
  slideCount: number;
  /** From the splitter; false means a single slide and no indicator. */
  showIndicator: boolean;
  contentType: SplitContentType;
  /** Language for Shiki, when the content is code. */
  language: string | null;
  /** The splitter's resolved config, so layout and capacity always agree. */
  config: ResolvedSplitterConfig;
} & SlideBackgroundOptions;

/**
 * The data URI for a usable background, or null to fall back to the solid
 * theme. Invalid or unsupported image bytes fall back instead of throwing.
 */
function backgroundDataUri(input: SlideRenderInput): string | null {
  if (!input.background?.data) return null;
  // A photo behind code is opt-in; text cards take a photo by default.
  if (input.contentType === "code" && input.usePhotoBehindCode !== true) return null;
  return toDataUri(input.background.data);
}

/**
 * Renders a single slide to PNG bytes.
 *
 * A background that even Satori/resvg cannot decode (a truncated download,
 * say) degrades to the solid theme instead of failing the post.
 */
export async function renderSlidePng(input: SlideRenderInput): Promise<Buffer> {
  try {
    return await renderSlideWithBackground(input, backgroundDataUri(input));
  } catch (error) {
    if (!input.background?.data) throw error;
    return renderSlideWithBackground({ ...input, background: null }, null);
  }
}

async function renderSlideWithBackground(
  input: SlideRenderInput,
  backgroundSrc: string | null,
): Promise<Buffer> {
  const usesPhoto = backgroundSrc !== null;
  const theme = resolveTheme(input.contentType, usesPhoto);
  const isCode = input.contentType === "code";
  const tokens = isCode
    ? await tokensForSlide(input.slide, input.language, theme.foreground)
    : [];

  const element = slideElement(input, theme, tokens, backgroundSrc);
  const svg = await satori(element, {
    width: input.config.slideWidth,
    height: input.config.slideHeight,
    fonts: await getFonts(),
  });

  return new Resvg(svg).render().asPng();
}

/** Renders every slide of a split to PNG bytes, in slide order. */
export async function renderSlidesPng(
  result: SplitResult,
  options: SlideBackgroundOptions = {},
): Promise<Buffer[]> {
  const pngs: Buffer[] = [];
  // Sequential: the first render warms up Satori's layout engine and Shiki.
  for (const [index, slide] of result.slides.entries()) {
    pngs.push(
      await renderSlidePng({
        slide,
        index,
        slideCount: result.slideCount,
        showIndicator: result.showIndicator,
        contentType: result.contentType,
        language: result.language,
        config: result.config,
        ...options,
      }),
    );
  }
  return pngs;
}

/**
 * Wraps raw image bytes as a data URI. Returns null for anything the renderer
 * cannot safely hand to Satori, so a missing or bad photo degrades to the
 * solid background instead of failing the render.
 */
function toDataUri(data: Buffer | Uint8Array | string): string | null {
  if (typeof data === "string") {
    return data.startsWith("data:image/") ? data : null;
  }
  const bytes = data instanceof Uint8Array ? data : null;
  if (!bytes || bytes.length < 12) return null;

  const mime = sniffImageMime(bytes);
  if (!mime) return null;
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Advance widths in em per character class, used only to bound the scaled font
 * size. These are rough, but erring high is the safe direction: the bound is
 * there to stop a line leaving the card, so an over-estimate costs a couple of
 * pixels of type size and an under-estimate costs clipped text.
 */
const NARROW_GLYPHS = "iljtfr.,;:!'\"|()[]{}/\\`- ";
const WIDE_GLYPHS = "MWmw@%&#";

/** Estimated rendered width of `text`, in em. */
export function lineEm(text: string): number {
  let em = 0;
  for (const char of text) {
    if (NARROW_GLYPHS.includes(char)) em += 0.32;
    else if (WIDE_GLYPHS.includes(char)) em += 0.95;
    else if (char >= "0" && char <= "9") em += 0.62;
    else if (char !== char.toLowerCase()) em += 0.72;
    else em += 0.54;
  }
  return em;
}

/** Floor for the scaled size: text never gets smaller than this, because a
 * slide that dense has already been split into more slides by the splitter. */
export const TEXT_FONT_MIN = 36;
/** Ceiling for the scaled size: a card with two lines should not turn into a
 * billboard. */
export const TEXT_FONT_MAX = 64;

/**
 * Text cards scale their font to how much text the slide carries: a slide with
 * two lines is drawn larger than a nearly full one. Code cards keep the
 * splitter's monospace size, because their breaks are exact character cuts
 * rather than word wrapping, so their line lengths are already maximal.
 *
 * Exported bounds are the min and max of that scale.
 *
 * The growth is bounded by two things: the vertical room left on the slide,
 * and the width of the longest line. That second bound is what keeps a
 * scaled-up line inside the card. It can only bind below the base size for a
 * line the splitter could not wrap (a single long token), and it is stricter
 * than the splitter's flat `charAspectRatio` for wide glyph runs.
 */
export function computePerSlideFont(
  slide: Slide,
  isText: boolean,
  config: ResolvedSplitterConfig,
): number {
  if (!isText) return config.fontSize;

  const baseFont = config.fontSize;

  // Vertical room: fewer lines on the slide => grow toward TEXT_FONT_MAX.
  const linesPerSlide = Math.max(
    1,
    Math.floor((config.slideHeight - config.verticalPadding) / config.lineHeight),
  );
  const fillRatio = Math.min(1, (slide.lines.length || 1) / linesPerSlide);
  const byHeight = Math.max(
    TEXT_FONT_MIN,
    baseFont + (TEXT_FONT_MAX - baseFont) * (1 - fillRatio),
  );

  // Horizontal room: the longest line must still fit the width. The splitter
  // measures lines with one average ratio, which is honest for prose but
  // optimistic for wide glyphs ("MMMMMMMM"), so the renderer bounds itself with
  // a per-character estimate instead of a flat average.
  const usableWidth =
    config.slideWidth - config.horizontalPadding * 2 - config.lineNumberGutter;
  const widestEm = slide.lines.reduce((max, line) => Math.max(max, lineEm(line.text)), 0);
  const byWidth = widestEm > 0 ? usableWidth / widestEm : TEXT_FONT_MAX;

  // Floor to an even size so rounding cannot push a line back over the edge.
  const size = Math.min(TEXT_FONT_MAX, byHeight, byWidth);
  return Math.max(2, Math.floor(size / 2) * 2);
}

function slideElement(
  input: SlideRenderInput,
  theme: SlideTheme,
  tokens: ColoredToken[][],
  backgroundSrc: string | null,
): ReactNode {
  const { slide, index, slideCount, showIndicator, contentType, config } = input;
  const isCode = contentType === "code";
  const usesPhoto = backgroundSrc !== null;
  const textShadow = usesPhoto ? PHOTO_TEXT_SHADOW : undefined;
  const credit = usesPhoto ? (input.background?.attribution?.name?.trim() ?? "") : "";

  // Per-slide font size: text slides can grow when they have little text.
  const fontSize = computePerSlideFont(slide, !isCode, config);
  // Keep the config's own line-height ratio as the font scales.
  const lineHeight = Math.round(fontSize * (config.lineHeight / config.fontSize));

  const actualLinesOnSlide = Math.min(
    slide.lines.length,
    Math.floor((config.slideHeight - config.verticalPadding) / lineHeight),
  );
  const usedHeight = actualLinesOnSlide * lineHeight;
  const remainingHeight = config.slideHeight - config.verticalPadding - usedHeight;
  const verticalOffset = Math.max(0, Math.round(remainingHeight / 2));

  const padSide = config.horizontalPadding / 2;
  // Same usable width the splitter sized lines against.
  const usableWidth =
    config.slideWidth - config.horizontalPadding * 2 - config.lineNumberGutter;
  const blockWidth = isCode ? config.lineNumberGutter + usableWidth : usableWidth;
  const blockOffset = (config.slideWidth - padSide * 2 - blockWidth) / 2;

  const rows = slide.lines.map((line, lineIndex) => (
    <div
      key={lineIndex}
      style={{
        display: "flex",
        flexDirection: "row",
        height: lineHeight,
        alignItems: "center",
      }}
    >
      {isCode ? (
        <div
          style={{
            width: config.lineNumberGutter,
            boxSizing: "border-box",
            paddingRight: 16,
            textAlign: "right",
            color: theme.muted,
            fontFamily: MONO_FAMILY,
            fontSize: Math.round(fontSize * 0.75),
            flexGrow: 0,
            flexShrink: 0,
            textShadow,
          }}
        >
          {/* A continuation carries no number; the space keeps the gutter box
              occupied so the code text stays aligned with the rows above. */}
          {line.number === null ? "\u00a0" : String(line.number)}
        </div>
      ) : null}
      <div
        style={{
          whiteSpace: "pre",
          fontFamily: theme.fontFamily,
          fontSize,
          color: theme.foreground,
          flexShrink: 0,
          textShadow,
        }}
      >
        {isCode
          ? (tokens[lineIndex] ?? [{ content: line.text, color: theme.foreground }]).map(
              (token, tokenIndex) => (
                <span key={tokenIndex} style={{ color: token.color ?? theme.foreground }}>
                  {token.content}
                </span>
              ),
            )
          : line.text}
      </div>
    </div>
  ));

  return (
    <div
      style={{
        width: config.slideWidth,
        height: config.slideHeight,
        background: theme.background,
        color: theme.foreground,
        fontFamily: theme.fontFamily,
        fontSize,
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        position: "relative",
      }}
    >
      {/* Full-bleed photo, then the overlay, then the text on top. */}
      {usesPhoto ? (
        // Satori lays out SVG, not the DOM; next/image cannot be used here.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={backgroundSrc}
          alt=""
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: config.slideWidth,
            height: config.slideHeight,
            objectFit: "cover",
          }}
        />
      ) : null}
      {usesPhoto ? (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: config.slideWidth,
            height: config.slideHeight,
            background: PHOTO_OVERLAY,
          }}
        />
      ) : null}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          padding: `${config.verticalPadding / 2}px ${padSide}px`,
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: blockWidth,
            marginLeft: blockOffset,
            marginTop: verticalOffset,
          }}
        >
          {rows}
        </div>
        {/* Unsplash requires crediting the photographer and linking back. */}
        {index === 0 && credit ? (
          <div
            style={{
              position: "absolute",
              left: padSide,
              bottom: 16,
              maxWidth: config.slideWidth - padSide * 2 - 120,
              fontFamily: SANS_FAMILY,
              fontSize: 24,
              color: theme.foreground,
              textShadow,
            }}
          >
            {`Photo by ${credit} on Unsplash`}
          </div>
        ) : null}
        {showIndicator ? (
          <div
            style={{
              position: "absolute",
              right: padSide,
              bottom: 16,
              fontFamily: MONO_FAMILY,
              fontSize: 32,
              fontWeight: 700,
              color: theme.foreground,
              textShadow,
            }}
          >
            {`${index + 1} / ${slideCount}`}
          </div>
        ) : null}
      </div>
    </div>
  );
}
