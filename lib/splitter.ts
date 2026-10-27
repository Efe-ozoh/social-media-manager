/**
 * Carousel splitter — SPEC section 8, "Splitter algorithm (lib/splitter.ts)".
 *
 * Pure: text + config in, slides out. No image rendering, no database, no I/O.
 *
 * SPEC rules implemented here:
 *  1. Normalize line endings and tabs; wrap lines wider than the slide's
 *     character capacity. Wrapped chunks count toward capacity and are marked
 *     as continuations, which carry no line number of their own.
 *  2. Fill each slide greedily up to `linesPerSlide`.
 *  3. When a slide is full, look back at most `lookback` (8) lines for a
 *     preferred break — a blank line, or a line that closes a block at
 *     indentation level 0 — and break there if found; otherwise hard-split.
 *  4. Line numbers are source line numbers and continue across slides.
 *  5. More slides than the carousel cap (default 10) sets `tooLong` together
 *     with the slide count, so the UI can warn and offer to trim.
 *  6. Everything that fits on one slide returns a single slide and no footer
 *     indicator (`showIndicator`).
 *  7. Plain text prefers paragraph boundaries, then sentence boundaries, and
 *     defaults to a larger proportional font (see STYLE_DEFAULTS).
 */

export type SplitContentType = "text" | "code";

export type SplitterConfig = {
  /** Slide width in px. Default 1080 (SPEC: fixed 1080 x 1350, 4:5). */
  slideWidth?: number;
  /** Slide height in px. Default 1350. */
  slideHeight?: number;
  /** Total vertical padding (top + bottom) in px. Default 120. */
  verticalPadding?: number;
  /** Total horizontal padding (left + right) in px. Default 80. */
  horizontalPadding?: number;
  /** Width reserved for the line-number gutter in px. Default 56. */
  lineNumberGutter?: number;
  /** Line height in px. Drives linesPerSlide. */
  lineHeight?: number;
  /** Font size in px. Drives the character capacity. */
  fontSize?: number;
  /**
   * Average glyph width as a fraction of the font size:
   * 0.6 for monospace code cards, ~0.5 for proportional text cards.
   */
  charAspectRatio?: number;
  /** Tab stop width in columns. Default 4. */
  tabWidth?: number;
  /** Lines to look back for a preferred break. SPEC default 8. */
  lookback?: number;
  /** Carousel item cap. SPEC default 10. */
  carouselCap?: number;
};

export type ResolvedSplitterConfig = Required<SplitterConfig>;

/** SPEC section 8 "Slide format" defaults, shared by both content types. */
const SHARED_DEFAULTS = {
  slideWidth: 1080,
  slideHeight: 1350,
  verticalPadding: 120,
  horizontalPadding: 80,
  lineNumberGutter: 56,
  tabWidth: 4,
  lookback: 8,
  carouselCap: 10,
} as const;

/**
 * SPEC rule 7: plain text uses a proportional font at a larger size;
 * code uses a monospace font at a smaller size.
 */
const STYLE_DEFAULTS: Record<
  SplitContentType,
  Pick<ResolvedSplitterConfig, "fontSize" | "lineHeight" | "charAspectRatio">
> = {
  code: { fontSize: 30, lineHeight: 44, charAspectRatio: 0.6 },
  text: { fontSize: 44, lineHeight: 60, charAspectRatio: 0.55 },
};

export type SplitInput = {
  text: string;
  /** Defaults to "text" — plain text is the default input (SPEC rule 7). */
  contentType?: SplitContentType;
  /** Passed through for the renderer; the splitter itself does not use it. */
  language?: string | null;
  config?: SplitterConfig;
};

export type SplitLine = {
  /** Source line number (1-based), or null for a wrapped continuation. */
  number: number | null;
  text: string;
  continuation: boolean;
};

export type Slide = {
  /** 0-based slide index (the renderer shows index + 1 / slideCount). */
  index: number;
  /** Source line number this slide starts on, even for a continuation. */
  startLine: number;
  lines: SplitLine[];
};

export type SplitResult = {
  slides: Slide[];
  slideCount: number;
  /** True when the content needs more slides than the carousel cap. */
  tooLong: boolean;
  /** False when everything fits on one slide (SPEC rule 6). */
  showIndicator: boolean;
  contentType: SplitContentType;
  language: string | null;
  config: ResolvedSplitterConfig;
  /** floor((slideHeight - verticalPadding) / lineHeight) */
  linesPerSlide: number;
  /** floor((slideWidth - 2 * horizontalPadding - lineNumberGutter) / (fontSize * charAspectRatio)) */
  charCapacity: number;
};

/** A line on the slide, after normalization and wrapping. */
type Entry = {
  text: string;
  /** 1-based source line this entry came from. */
  sourceLine: number;
  continuation: boolean;
  blank: boolean;
  /** Leading whitespace width in columns (0 for continuations). */
  indent: number;
};

/** Break priorities: a text paragraph outranks a sentence; code treats a blank
 * line and a block closer equally. 0 means "never break here". */
const PARAGRAPH = 2;
const PREFERRED = 1;

export function splitSlides(input: SplitInput): SplitResult {
  const contentType = input.contentType ?? "text";
  const config = resolveConfig(contentType, input.config ?? {});

  const linesPerSlide = toCapacity(
    (config.slideHeight - config.verticalPadding) / config.lineHeight,
    "linesPerSlide",
  );
  const usableWidth =
    config.slideWidth - config.horizontalPadding * 2 - config.lineNumberGutter;
  const charCapacity = toCapacity(
    usableWidth / (config.fontSize * config.charAspectRatio),
    "charCapacity",
  );

  const sourceLines = normalizeSourceLines(input.text, config.tabWidth);
  const entries = buildEntries(sourceLines, charCapacity, contentType);

  const empty =
    entries.length === 0 || entries.every((entry) => entry.blank);

  const result: SplitResult = {
    slides: [],
    slideCount: 0,
    tooLong: false,
    showIndicator: false,
    contentType,
    language: input.language ?? null,
    config,
    linesPerSlide,
    charCapacity,
  };

  if (empty) return result;

  const slides = fillSlides(entries, {
    linesPerSlide,
    lookback: config.lookback,
    contentType,
  });

  result.slides = slides;
  result.slideCount = slides.length;
  result.tooLong = slides.length > config.carouselCap;
  result.showIndicator = slides.length > 1;
  return result;
}

function resolveConfig(
  contentType: SplitContentType,
  provided: SplitterConfig,
): ResolvedSplitterConfig {
  const overrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(provided)) {
    if (value !== undefined) overrides[key] = value;
  }
  const config = {
    ...SHARED_DEFAULTS,
    ...STYLE_DEFAULTS[contentType],
    ...overrides,
  } as ResolvedSplitterConfig;

  const positiveKeys: (keyof ResolvedSplitterConfig)[] = [
    "slideWidth",
    "slideHeight",
    "lineHeight",
    "fontSize",
    "charAspectRatio",
    "tabWidth",
    "carouselCap",
  ];
  for (const key of positiveKeys) {
    if (!(config[key] > 0)) {
      throw new RangeError(`splitter config: ${key} must be greater than 0`);
    }
  }
  const nonNegativeKeys: (keyof ResolvedSplitterConfig)[] = [
    "verticalPadding",
    "horizontalPadding",
    "lineNumberGutter",
  ];
  for (const key of nonNegativeKeys) {
    if (!(config[key] >= 0)) {
      throw new RangeError(`splitter config: ${key} must not be negative`);
    }
  }
  if (config.verticalPadding >= config.slideHeight) {
    throw new RangeError(
      "splitter config: verticalPadding must be smaller than slideHeight",
    );
  }
  if (config.horizontalPadding * 2 + config.lineNumberGutter >= config.slideWidth) {
    throw new RangeError(
      "splitter config: horizontal padding and gutter must be smaller than slideWidth",
    );
  }
  if (config.lookback < 0) {
    throw new RangeError("splitter config: lookback must not be negative");
  }
  return config;
}

function toCapacity(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(
      `splitter config: computed ${label} must be at least 1 (got ${value})`,
    );
  }
  return Math.floor(value);
}

/** SPEC rule 1: normalize line endings and tab stops. Whitespace-only lines
 * become plain empty lines. */
function normalizeSourceLines(raw: string, tabWidth: number): string[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  // A single trailing newline is an artifact, not an extra line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  return lines.map((line) => {
    const expanded = expandTabs(line, tabWidth);
    return expanded.trim() === "" ? "" : expanded;
  });
}

function expandTabs(line: string, tabWidth: number): string {
  if (!line.includes("\t")) return line;

  let out = "";
  let column = 0;
  for (const char of line) {
    if (char === "\t") {
      const pad = tabWidth - (column % tabWidth);
      out += " ".repeat(pad);
      column += pad;
    } else {
      out += char;
      column += 1;
    }
  }
  return out;
}

function buildEntries(
  lines: string[],
  charCapacity: number,
  contentType: SplitContentType,
): Entry[] {
  const entries: Entry[] = [];

  lines.forEach((line, index) => {
    const sourceLine = index + 1;

    if (line === "") {
      entries.push({
        text: "",
        sourceLine,
        continuation: false,
        blank: true,
        indent: 0,
      });
      return;
    }

    const indent = line.length - line.trimStart().length;
    // Plain text may break between words; code is cut at the exact character
    // capacity so no character is ever moved or dropped.
    const chunks = wrapLine(line, charCapacity, contentType === "text");
    chunks.forEach((text, chunkIndex) => {
      entries.push({
        text,
        sourceLine,
        continuation: chunkIndex > 0,
        blank: false,
        indent: chunkIndex === 0 ? indent : 0,
      });
    });
  });

  return entries;
}

function wrapLine(line: string, capacity: number, wordWrap: boolean): string[] {
  if (line.length <= capacity) return [line];

  const chunks: string[] = [];
  let rest = line;
  while (rest.length > capacity) {
    const window = rest.slice(0, capacity);
    let cut = capacity;
    if (wordWrap) {
      const space = window.lastIndexOf(" ");
      if (space > 0) cut = space;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    if (wordWrap && rest.startsWith(" ")) rest = rest.slice(1);
  }
  chunks.push(rest);
  return chunks;
}

function fillSlides(
  entries: Entry[],
  options: { linesPerSlide: number; lookback: number; contentType: SplitContentType },
): Slide[] {
  const { linesPerSlide, lookback, contentType } = options;
  const slides: Slide[] = [];
  let start = 0;

  while (start < entries.length) {
    const hasMore = entries.length - start > linesPerSlide;
    // SPEC rule 3: only a full slide chooses between a preferred break and a
    // hard split; the last slide simply takes what is left (SPEC rule 2).
    const end = hasMore
      ? findBreak(entries, start, linesPerSlide, lookback, contentType)
      : entries.length;

    slides.push({
      index: slides.length,
      startLine: entries[start].sourceLine,
      lines: entries.slice(start, end).map((entry) => ({
        number: entry.continuation ? null : entry.sourceLine,
        text: entry.text,
        continuation: entry.continuation,
      })),
    });
    start = end;
  }

  return slides;
}

/** Returns the absolute index at which the current slide ends. */
function findBreak(
  entries: Entry[],
  start: number,
  linesPerSlide: number,
  lookback: number,
  contentType: SplitContentType,
): number {
  const limit = start + linesPerSlide;
  const first = Math.max(start, limit - 1 - lookback);

  let best = -1;
  let bestPriority = 0;
  // Walk backwards so ties resolve to the break closest to the limit.
  for (let index = limit - 1; index >= first; index -= 1) {
    const priority = breakPriority(entries[index], contentType);
    if (priority > bestPriority) {
      bestPriority = priority;
      best = index;
    }
  }

  return best >= 0 ? best + 1 : limit;
}

function breakPriority(entry: Entry, contentType: SplitContentType): number {
  if (entry.blank) {
    // SPEC rule 7: for plain text a blank line is a paragraph boundary, which
    // outranks sentence boundaries.
    return contentType === "text" ? PARAGRAPH : PREFERRED;
  }
  if (contentType === "text") {
    return isSentenceEnd(entry.text) ? PREFERRED : 0;
  }
  return isBlockCloser(entry) ? PREFERRED : 0;
}

/** SPEC rule 3: "a line that closes a block at indentation level 0". */
function isBlockCloser(entry: Entry): boolean {
  if (entry.indent !== 0) return false;
  const trimmed = entry.text.trim();
  return /^[}\])]/.test(trimmed) || trimmed.startsWith("</");
}

/** SPEC rule 7: sentence boundaries are the second choice for plain text. */
function isSentenceEnd(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed === "") return false;
  return /[.!?…][”"'’)\]]*$/.test(trimmed);
}
