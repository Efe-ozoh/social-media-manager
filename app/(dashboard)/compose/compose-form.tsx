"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  COMPOSE_PLATFORMS,
  SHARED_CAPTION_LIMIT,
  buildComposePayload,
  captionNote,
  captionUsage,
  contentLimit,
  draftFingerprint,
  emptyComposeDraft,
  formatScheduleLabel,
  selectedPlatforms,
  sharedCaptionLimit,
  utcToLocalDateTime,
  validateComposeDraft,
  zonedDateTimeToUtc,
  type ComposeContentType,
  type ComposeDraft,
  type ComposeIntent,
  type ComposePlatform,
} from "@/lib/compose-logic";
import type { PlatformStatus } from "@/lib/platform-status";
import { EMPTY_PREVIEW, SlidePreview, type PreviewState } from "./slide-preview";
import { TextPreview } from "./text-preview";

const LANGUAGE_OPTIONS = [
  { value: "", label: "Plain text" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "java", label: "Java" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "csharp", label: "C#" },
  { value: "cpp", label: "C++" },
  { value: "sql", label: "SQL" },
  { value: "bash", label: "Bash" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "html", label: "HTML" },
  { value: "css", label: "CSS" },
  { value: "php", label: "PHP" },
  { value: "ruby", label: "Ruby" },
  { value: "swift", label: "Swift" },
  { value: "kotlin", label: "Kotlin" },
] as const;

const CAROUSEL_OPTIONS = [
  { value: "auto", label: "Auto", hint: "Split into slides when needed" },
  { value: "on", label: "On", hint: "Prefer a carousel" },
  { value: "off", label: "Off", hint: "Keep it to one slide" },
] as const;

const FORMAT_OPTIONS = [
  {
    textOnly: false,
    label: "With images",
    hint: "Renders the text into slides and posts them with the caption.",
  },
  {
    textOnly: true,
    label: "Text only (no images)",
    hint: "Publishes the caption as a plain text post. Nothing is rendered or stored.",
  },
] as const;

type ApiPost = {
  id: string;
  bodyText: string;
  textOnly: boolean;
  contentType: string;
  code: string | null;
  language: string | null;
  caption: string;
  carouselMode: string;
  status: string;
  scheduledAt: string | null;
  targets: { platform: string; captionOverride: string | null }[];
};

type Notice = { tone: "success" | "error"; text: string };

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60 sm:p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
            {description}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function draftFromPost(post: ApiPost, timeZone: string): ComposeDraft {
  const code =
    post.contentType === "code" && post.code?.trim()
      ? post.code
      : post.bodyText;
  const platforms = new Set(post.targets.map((target) => target.platform));
  const override = (platform: ComposePlatform) =>
    post.targets.find((target) => target.platform === platform)?.captionOverride ??
    "";
  const carouselMode =
    post.carouselMode === "on" || post.carouselMode === "off"
      ? post.carouselMode
      : "auto";

  return {
    ...emptyComposeDraft(),
    textOnly: post.textOnly === true,
    text: code,
    contentType: post.contentType === "code" ? "code" : "text",
    language: post.language ?? "",
    caption: post.caption,
    carouselMode,
    scheduleLocal: utcToLocalDateTime(post.scheduledAt, timeZone),
    targets: {
      linkedin: platforms.has("linkedin"),
      telegram: platforms.has("telegram"),
    },
    captionOverrides: {
      linkedin: override("linkedin"),
      telegram: override("telegram"),
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function apiError(data: unknown, fallback: string): string {
  if (typeof data === "object" && data !== null) {
    const value = (data as { error?: unknown }).error;
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return fallback;
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function initialTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function ComposeForm({ postId }: { postId: string | null }) {
  const router = useRouter();
  const [timeZone] = useState<string>(initialTimeZone);
  const [statuses, setStatuses] = useState<PlatformStatus[]>([]);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusReload, setStatusReload] = useState(0);
  const [postLoaded, setPostLoaded] = useState(postId === null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedPostId, setSavedPostId] = useState<string | null>(postId);
  const [draft, setDraft] = useState<ComposeDraft>(emptyComposeDraft);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>(EMPTY_PREVIEW);
  const [slideIndex, setSlideIndex] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<ComposeIntent | null>(null);
  const initializedTargets = useRef(false);

  useEffect(() => {
    let alive = true;

    fetch("/api/platforms/status", { cache: "no-store" })
      .then(async (response) => {
        const data = await readJson(response);
        if (!response.ok) {
          throw new Error(apiError(data, "Could not load platform status."));
        }
        const platforms =
          typeof data === "object" && data !== null
            ? (data as { platforms?: unknown }).platforms
            : undefined;
        if (!Array.isArray(platforms)) {
          throw new Error("Platform status returned an unexpected response.");
        }
        if (!alive) return;

        const safePlatforms = platforms as PlatformStatus[];
        setStatuses(safePlatforms);
        setStatusError(null);
        setStatusLoaded(true);

        if (!postId && !initializedTargets.current) {
          initializedTargets.current = true;
          const available = safePlatforms.filter((status) => status.canPublish);
          const targets = {
            linkedin: available.some((status) => status.platform === "linkedin"),
            telegram: available.some((status) => status.platform === "telegram"),
          };
          setBaseline(
            draftFingerprint({ ...emptyComposeDraft(), targets }),
          );
          setDraft((current) => ({ ...current, targets }));
        }
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setStatuses([]);
        setStatusLoaded(true);
        setStatusError(
          error instanceof Error
            ? error.message
            : "Could not load platform status.",
        );
        if (!postId && !initializedTargets.current) {
          initializedTargets.current = true;
          setBaseline(draftFingerprint(emptyComposeDraft()));
        }
      });

    return () => {
      alive = false;
    };
  }, [postId, statusReload]);

  useEffect(() => {
    if (!postId) return;
    let alive = true;

    fetch(`/api/posts/${postId}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await readJson(response);
        if (!response.ok) {
          throw new Error(apiError(data, "Could not load the post."));
        }
        const post =
          typeof data === "object" && data !== null
            ? (data as { post?: unknown }).post
            : undefined;
        if (typeof post !== "object" || post === null) {
          throw new Error("The post response was incomplete.");
        }
        if (!alive) return;

        const editable = post as ApiPost;
        if (editable.status !== "draft" && editable.status !== "scheduled") {
          throw new Error("Only draft or scheduled posts can be edited.");
        }

        const next = draftFromPost(editable, timeZone);
        setDraft(next);
        setBaseline(draftFingerprint(next));
        setPostLoaded(true);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setLoadError(
          error instanceof Error ? error.message : "Could not load the post.",
        );
        setPostLoaded(true);
      });

    return () => {
      alive = false;
    };
  }, [postId, timeZone]);

  const ready = statusLoaded && postLoaded;
  const dirty = baseline !== null && baseline !== draftFingerprint(draft);
  // Text-only posts have no slides to render, so the preview endpoint is never
  // called for them.
  const previewInputValid =
    !draft.textOnly &&
    draft.text.trim() !== "" &&
    draft.text.length <= contentLimit(draft.contentType);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const guardInternalLink = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#") || link.target === "_blank") return;
      if (window.confirm("Leave this page? Unsaved changes will be lost.")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardInternalLink, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", guardInternalLink, true);
    };
  }, [dirty]);

  useEffect(() => {
    if (!ready || !previewInputValid) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreview((current) => ({ ...current, loading: true, error: null }));

      try {
        const response = await fetch("/api/render/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            text: draft.text,
            contentType: draft.contentType,
            language:
              draft.contentType === "code"
                ? draft.language.trim() || null
                : null,
          }),
        });
        const data = await readJson(response);
        if (!response.ok) {
          throw new Error(apiError(data, "Could not render the preview."));
        }
        if (controller.signal.aborted) return;

        const record = data as {
          slides?: { index: number; dataUri: string; width: number; height: number }[];
          slideCount?: number;
          renderedSlideCount?: number;
          tooLong?: boolean;
        };

        setPreview({
          loading: false,
          error: null,
          slides: Array.isArray(record.slides) ? record.slides : [],
          slideCount: record.slideCount ?? 0,
          renderedSlideCount: record.renderedSlideCount ?? 0,
          tooLong: record.tooLong === true,
        });
        setSlideIndex(0);
      } catch (error) {
        if (controller.signal.aborted) return;
        setPreview({
          ...EMPTY_PREVIEW,
          error:
            error instanceof Error
              ? error.message
              : "Could not render the preview.",
        });
      }
    }, 600);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    ready,
    previewInputValid,
    draft.text,
    draft.contentType,
    draft.language,
  ]);

  if (loadError) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="text-xl font-semibold tracking-tight">Compose</h1>
        <div
          role="alert"
          className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          {loadError}
        </div>
        <Link
          href="/compose"
          className="mt-5 inline-flex rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Start a new post
        </Link>
      </main>
    );
  }

  if (!ready) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="text-xl font-semibold tracking-tight">Compose</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Loading the editor…
        </p>
      </main>
    );
  }

  const currentTimeZone = timeZone;
  const editorLimit = contentLimit(draft.contentType);
  const captionLimitShown = draft.textOnly
    ? sharedCaptionLimit(draft)
    : SHARED_CAPTION_LIMIT;
  const selected = selectedPlatforms(draft);
  const scheduleDate = draft.scheduleLocal
    ? zonedDateTimeToUtc(draft.scheduleLocal, currentTimeZone)
    : null;
  const visiblePreview = previewInputValid ? preview : EMPTY_PREVIEW;
  const visibleSlideIndex = Math.min(
    slideIndex,
    Math.max(0, visiblePreview.slides.length - 1),
  );

  function update<K extends keyof ComposeDraft>(
    key: K,
    value: ComposeDraft[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function setTarget(platform: ComposePlatform, checked: boolean) {
    setDraft((current) => ({
      ...current,
      targets: { ...current.targets, [platform]: checked },
    }));
  }

  function setOverride(platform: ComposePlatform, value: string) {
    setDraft((current) => ({
      ...current,
      captionOverrides: {
        ...current.captionOverrides,
        [platform]: value,
      },
    }));
  }

  async function submit(intent: ComposeIntent) {
    if (pending) return;
    setFormError(null);
    setNotice(null);

    const validation = validateComposeDraft({
      draft,
      statuses,
      timeZone: currentTimeZone,
      requireSchedule: intent === "schedule",
    });
    if (!validation.ok) {
      setFormError(validation.errors.join(" "));
      return;
    }

    if (
      intent === "publish-now" &&
      !window.confirm("Publish this post now? This cannot be undone.")
    ) {
      return;
    }

    setPending(intent);
    try {
      let id = savedPostId;
      const includeStatus = intent !== "publish-now" || id === null;
      const payload = buildComposePayload({
        draft,
        intent,
        timeZone: currentTimeZone,
        includeStatus,
      });

      if (id) {
        const response = await fetch(`/api/posts/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(
            apiError(await readJson(response), "Could not save the post."),
          );
        }
        setSavedPostId(id);
      } else {
        const response = await fetch("/api/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await readJson(response);
        if (!response.ok) {
          throw new Error(apiError(data, "Could not save the post."));
        }
        const saved =
          typeof data === "object" && data !== null
            ? (data as { post?: { id?: unknown } }).post
            : undefined;
        if (typeof saved?.id !== "string") {
          throw new Error("The post was saved but no id was returned.");
        }
        id = saved.id;
        setSavedPostId(id);
      }

      setBaseline(draftFingerprint(draft));

      if (intent === "publish-now") {
        const response = await fetch(`/api/posts/${id}/publish-now`, {
          method: "POST",
        });
        const data = await readJson(response);
        if (!response.ok) {
          throw new Error(
            apiError(data, "The post was saved, but publishing failed."),
          );
        }

        const summary =
          typeof data === "object" && data !== null
            ? (data as { failed?: unknown; retried?: unknown })
            : {};
        const failed =
          typeof summary.failed === "number" ? summary.failed : 0;
        const retried =
          typeof summary.retried === "number" ? summary.retried : 0;

        if (failed > 0) {
          setFormError(
            `${failed} target${failed === 1 ? "" : "s"} failed to publish. ` +
              "The post is saved; retry it from the Posts page.",
          );
          return;
        }
        if (retried > 0) {
          setNotice({
            tone: "success",
            text: `Publishing started; ${retried} target${
              retried === 1 ? "" : "s"
            } will retry automatically.`,
          });
        }
      }

      router.push("/posts");
      router.refresh();
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Could not save the post. Try again.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {savedPostId ? "Edit post" : "Compose"}
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Write once, check the preview, then save, schedule or publish now.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          {dirty ? <span>Unsaved changes</span> : null}
          {savedPostId ? (
            <Link
              href="/compose"
              className="rounded-lg border border-zinc-300 px-2.5 py-1.5 font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              New post
            </Link>
          ) : null}
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:items-start">
        <div className="space-y-5">
          <Card
            title="Format"
            description="Text-only posts publish the caption as plain text: no slide is rendered, stored or uploaded."
          >
            <div
              role="radiogroup"
              aria-label="Post format"
              className="grid gap-2 sm:grid-cols-2"
            >
              {FORMAT_OPTIONS.map((option) => (
                <label
                  key={option.label}
                  className={`cursor-pointer rounded-lg border p-3 text-sm transition-colors ${
                    draft.textOnly === option.textOnly
                      ? "border-zinc-400 bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800/50"
                      : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/30"
                  }`}
                >
                  <input
                    type="radio"
                    name="format"
                    checked={draft.textOnly === option.textOnly}
                    onChange={() => update("textOnly", option.textOnly)}
                    className="mr-2"
                  />
                  <span className="font-medium">{option.label}</span>
                  <span className="mt-1 block pl-5 text-xs text-zinc-500 dark:text-zinc-400">
                    {option.hint}
                  </span>
                </label>
              ))}
            </div>
          </Card>

          {!draft.textOnly ? (
            <Card
              title="Content"
              description="Text becomes the readable card; code becomes a syntax-highlighted monospace card."
            >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div
                role="group"
                aria-label="Content type"
                className="inline-flex rounded-lg border border-zinc-300 p-0.5 dark:border-zinc-700"
              >
                {(["text", "code"] as ComposeContentType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={draft.contentType === type}
                    onClick={() => update("contentType", type)}
                    className={`rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors ${
                      draft.contentType === type
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>

              <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                Auto-convert
                <select
                  disabled
                  aria-label="Auto-convert to code (coming in Phase 6)"
                  className="rounded-md border border-zinc-300 bg-zinc-100 px-2 py-1 opacity-70 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option>Off — Phase 6</option>
                </select>
              </label>
            </div>

            <textarea
              value={draft.text}
              onChange={(event) => update("text", event.target.value)}
              rows={12}
              spellCheck={draft.contentType === "text"}
              aria-label={draft.contentType === "code" ? "Code" : "Text"}
              placeholder={
                draft.contentType === "code"
                  ? "Paste your code here…"
                  : "Write the post here…"
              }
              className={`w-full resize-y rounded-lg border bg-white px-3 py-2 text-sm leading-relaxed outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400/30 dark:bg-zinc-950 ${
                draft.text.length > editorLimit
                  ? "border-red-400 dark:border-red-700"
                  : "border-zinc-300 dark:border-zinc-700"
              } ${draft.contentType === "code" ? "font-mono" : ""}`}
            />

            <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                {draft.contentType === "code" ? (
                  <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                    Language
                    <select
                      value={draft.language}
                      onChange={(event) =>
                        update("language", event.target.value)
                      }
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      {LANGUAGE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    The editor limit is{" "}
                    {editorLimit.toLocaleString("en-US")} characters.
                  </p>
                )}
              </div>
              <p
                className={`text-xs tabular-nums ${
                  draft.text.length > editorLimit
                    ? "font-medium text-red-600 dark:text-red-400"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {draft.text.length.toLocaleString("en-US")} /{" "}
                {editorLimit.toLocaleString("en-US")}
              </p>
            </div>
            </Card>
          ) : null}

          <Card
            title={draft.textOnly ? "Caption (the whole post)" : "Caption"}
            description={
              draft.textOnly
                ? "A text-only post is published exactly as written. The tightest limit among the selected platforms applies."
                : "Used for every selected platform unless that platform has its own override."
            }
          >
            <textarea
              value={draft.caption}
              onChange={(event) => update("caption", event.target.value)}
              rows={4}
              aria-label="Caption"
              placeholder={
                draft.textOnly
                  ? "Write the post. It is published exactly as typed…"
                  : "The caption or commentary that goes with the slides…"
              }
              className={`w-full resize-y rounded-lg border bg-white px-3 py-2 text-sm leading-relaxed outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400/30 dark:bg-zinc-950 ${
                draft.caption.length > captionLimitShown
                  ? "border-red-400 dark:border-red-700"
                  : "border-zinc-300 dark:border-zinc-700"
              }`}
            />
            <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                {draft.textOnly ? (
                  <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                    {captionNote("linkedin")} {captionNote("telegram")}
                  </p>
                ) : (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    The caption ceiling is{" "}
                    {SHARED_CAPTION_LIMIT.toLocaleString("en-US")} characters.
                  </p>
                )}
              </div>
              <p
                className={`text-xs tabular-nums ${
                  draft.caption.length > captionLimitShown
                    ? "font-medium text-red-600 dark:text-red-400"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {draft.caption.length.toLocaleString("en-US")} /{" "}
                {captionLimitShown.toLocaleString("en-US")}
              </p>
            </div>
          </Card>

          <Card
            title="Platforms"
            description="Only connected, automated platforms can be selected."
          >
            {statusError ? (
              <div
                role="alert"
                className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
              >
                <span>{statusError}</span>
                <button
                  type="button"
                  onClick={() => {
                    setStatusLoaded(false);
                    setStatusError(null);
                    setStatusReload((value) => value + 1);
                  }}
                  className="rounded-md border border-red-300 px-2 py-1 font-medium hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/40"
                >
                  Retry
                </button>
              </div>
            ) : null}

            <div className="space-y-3">
              {COMPOSE_PLATFORMS.map((platform) => {
                const status = statuses.find(
                  (candidate) => candidate.platform === platform,
                );
                const selectedPlatform = draft.targets[platform];
                const disabled = !status?.canPublish;
                const usage = captionUsage(draft, platform);
                const hasOverride =
                  draft.captionOverrides[platform].trim() !== "";

                return (
                  <div
                    key={platform}
                    className={`rounded-lg border p-3 ${
                      selectedPlatform
                        ? "border-zinc-400 bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800/40"
                        : "border-zinc-200 dark:border-zinc-800"
                    }`}
                  >
                    <label className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selectedPlatform}
                        disabled={disabled}
                        onChange={(event) =>
                          setTarget(platform, event.target.checked)
                        }
                        className="mt-1 size-4 rounded border-zinc-300 dark:border-zinc-700"
                      />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">
                            {status?.label ?? platform}
                          </span>
                          {status?.displayName ? (
                            <span className="text-xs text-zinc-500 dark:text-zinc-400">
                              {status.displayName}
                            </span>
                          ) : null}
                          {status?.connected ? (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
                              Connected
                            </span>
                          ) : status ? (
                            <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                              Not connected
                            </span>
                          ) : null}
                        </span>

                        {status?.disabledReason ? (
                          <span className="mt-1 block text-xs text-red-600 dark:text-red-400">
                            {status.disabledReason}
                          </span>
                        ) : null}

                        {status?.expiresAt ? (
                          <span
                            className={`mt-1 block text-xs ${
                              status.expired
                                ? "text-red-600 dark:text-red-400"
                                : status.expiresSoon
                                  ? "text-amber-700 dark:text-amber-300"
                                  : "text-zinc-500 dark:text-zinc-400"
                            }`}
                          >
                            Token {status.expired ? "expired" : "expires"}{" "}
                            {formatExpiry(status.expiresAt)}
                            {status.daysUntilExpiry !== null && !status.expired
                              ? ` (${status.daysUntilExpiry} day${
                                  status.daysUntilExpiry === 1 ? "" : "s"
                                } left)`
                              : ""}
                          </span>
                        ) : null}

                        {platform === "telegram" && status?.configured ? (
                          <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
                            Configured from the bot token and channel id.
                          </span>
                        ) : null}

                        <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
                          {captionNote(platform)}
                        </span>
                      </span>
                    </label>

                    {selectedPlatform ? (
                      <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-700">
                        <label className="block text-xs font-medium">
                          Caption override for {status?.label ?? platform}{" "}
                          <span className="font-normal text-zinc-500 dark:text-zinc-400">
                            (optional)
                          </span>
                          <textarea
                            value={draft.captionOverrides[platform]}
                            onChange={(event) =>
                              setOverride(platform, event.target.value)
                            }
                            rows={3}
                            disabled={disabled}
                            placeholder="Leave blank to use the shared caption."
                            className="mt-1 w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400/30 disabled:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:disabled:bg-zinc-900"
                          />
                        </label>
                        <div className="mt-1 flex flex-wrap justify-between gap-2">
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            {hasOverride ? "Custom override" : "Shared caption"}
                          </span>
                          <span
                            className={`text-xs tabular-nums ${
                              usage.overLimit || usage.overrideTooLong
                                ? "font-medium text-red-600 dark:text-red-400"
                                : "text-zinc-500 dark:text-zinc-400"
                            }`}
                          >
                            {usage.length.toLocaleString("en-US")} /{" "}
                            {usage.limit.toLocaleString("en-US")}
                          </span>
                        </div>
                        {usage.overrideTooLong ? (
                          <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                            Overrides are capped at 4,096 characters by the posts
                            API.
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <p className="mt-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              Instagram and Facebook are manual-export targets in this version;
              they cannot be scheduled here.
            </p>
          </Card>

          <Card title={draft.textOnly ? "Schedule" : "Carousel and schedule"}>
            {!draft.textOnly ? (
            <div
              role="radiogroup"
              aria-label="Carousel mode"
              className="grid gap-2 sm:grid-cols-3"
            >
              {CAROUSEL_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`cursor-pointer rounded-lg border p-3 text-sm transition-colors ${
                    draft.carouselMode === option.value
                      ? "border-zinc-400 bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800/50"
                      : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/30"
                  }`}
                >
                  <input
                    type="radio"
                    name="carousel"
                    value={option.value}
                    checked={draft.carouselMode === option.value}
                    onChange={() =>
                      update(
                        "carouselMode",
                        option.value as ComposeDraft["carouselMode"],
                      )
                    }
                    className="mr-2"
                  />
                  <span className="font-medium">{option.label}</span>
                  <span className="mt-1 block pl-5 text-xs text-zinc-500 dark:text-zinc-400">
                    {option.hint}
                  </span>
                </label>
              ))}
            </div>
            ) : null}

            <div className="mt-5">
              <label htmlFor="schedule-at" className="block text-sm font-medium">
                Schedule for
              </label>
              <input
                id="schedule-at"
                type="datetime-local"
                value={draft.scheduleLocal}
                onChange={(event) =>
                  update("scheduleLocal", event.target.value)
                }
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-400/30 dark:border-zinc-700 dark:bg-zinc-950"
              />
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Timezone: <span className="font-medium">{currentTimeZone}</span>.
                The server stores the matching UTC time.
              </p>
              {draft.scheduleLocal ? (
                scheduleDate ? (
                  <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
                    {formatScheduleLabel(scheduleDate, currentTimeZone)}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    That date and time does not exist in this timezone.
                  </p>
                )
              ) : null}
            </div>
          </Card>

          {formError ? (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            >
              {formError}
            </div>
          ) : null}
          {notice ? (
            <div
              role="status"
              className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
            >
              {notice.text}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => submit("draft")}
              disabled={pending !== null}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              {pending === "draft" ? "Saving…" : "Save draft"}
            </button>
            <button
              type="button"
              onClick={() => submit("schedule")}
              disabled={pending !== null}
              className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {pending === "schedule" ? "Scheduling…" : "Schedule"}
            </button>
            <button
              type="button"
              onClick={() => submit("publish-now")}
              disabled={pending !== null}
              className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            >
              {pending === "publish-now" ? "Publishing…" : "Publish now"}
            </button>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {selected.length === 0
              ? "Select at least one platform before saving."
              : `Targets: ${selected
                  .map(
                    (platform) =>
                      statuses.find((status) => status.platform === platform)
                        ?.label ?? platform,
                  )
                  .join(", ")}.`}
          </p>
        </div>

        <div className="space-y-4 lg:sticky lg:top-20">
          {draft.textOnly ? (
            <>
              <TextPreview caption={draft.caption} />
              <p className="px-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                No slides are rendered for a text-only post, so the SlidePreview
                is replaced by the plain-text preview above.
              </p>
            </>
          ) : (
            <>
              <SlidePreview
                state={visiblePreview}
                index={visibleSlideIndex}
                onIndexChange={setSlideIndex}
              />
              <p className="px-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                Preview updates automatically after you stop typing. A long post is
                capped at the carousel limit, and the warning shows before you save.
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
