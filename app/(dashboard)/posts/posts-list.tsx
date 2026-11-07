"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useHydrated } from "@/lib/use-hydrated";
import {
  STATUS_FILTERS,
  attemptsLabel,
  canDeletePost,
  canEditPost,
  canPublishNow,
  canRetryTarget,
  filterPosts,
  formatLocalTime,
  needsAutoRefresh,
  postTime,
  previewOf,
  publishedPostUrl,
  statusFilterOf,
  targetLabel,
  targetTone,
  type BadgeTone,
  type PostSummary,
  type PostTargetSummary,
  type StatusFilter,
} from "@/lib/post-targets";

/**
 * The posts list.
 *
 * The server already returns posts newest first, so this never re-sorts. While
 * any target is pending or processing the list refreshes every 30 seconds; once
 * everything has settled it stops, so an idle page makes no requests at all.
 *
 * Every action here maps to an API route that enforces the same rule, so a
 * hidden button and a refused request can never disagree about permissions.
 */

const POLL_INTERVAL_MS = 30_000;

const PRIMARY =
  "inline-flex items-center justify-center rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const SECONDARY =
  "inline-flex items-center justify-center rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800";
const DANGER =
  "inline-flex items-center justify-center rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40";

const TONES: Record<BadgeTone, string> = {
  published:
    "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  pending:
    "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200",
  processing:
    "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  failed:
    "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200",
};

function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

function parentTone(status: string): BadgeTone {
  if (status === "published") return "published";
  if (status === "failed") return "failed";
  if (status === "processing") return "processing";
  return "pending";
}

/**
 * Times are formatted after mount, in the browser's own timezone. Doing it
 * during render would print the server's zone during hydration.
 */
function LocalTime({ value }: { value: string }) {
  const hydrated = useHydrated();

  return (
    <time dateTime={value} suppressHydrationWarning>
      {hydrated ? formatLocalTime(value) : "…"}
    </time>
  );
}

function TargetRow({
  target,
  busy,
  onRetry,
}: {
  target: PostTargetSummary;
  busy: boolean;
  onRetry: (target: PostTargetSummary) => void;
}) {
  const publishedUrl = publishedPostUrl(target.platform, target.externalPostId);

  return (
    <li className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{targetLabel(target.platform)}</span>
        <Badge tone={targetTone(target.status)}>{target.status}</Badge>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {attemptsLabel(target.attempts)}
        </span>
        {target.status === "pending" && target.nextAttemptAt ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Next attempt <LocalTime value={target.nextAttemptAt} />
          </span>
        ) : null}
        {publishedUrl ? (
          <a
            href={publishedUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-medium text-sky-700 underline underline-offset-2 dark:text-sky-300"
          >
            View on LinkedIn
          </a>
        ) : null}
      </div>

      {target.notes ? (
        <p className="mt-2 whitespace-pre-line rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="font-semibold">Publisher note:</span> {target.notes}
        </p>
      ) : null}

      {target.lastError ? (
        <p className="mt-2 whitespace-pre-line rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs leading-relaxed text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <span className="font-semibold">Last error:</span> {target.lastError}
        </p>
      ) : null}

      {target.requiresReconnect ? (
        <p className="mt-2 text-xs leading-relaxed text-red-700 dark:text-red-300">
          Reconnect needed.{" "}
          <Link href="/accounts" className="font-medium underline underline-offset-2">
            Open Accounts
          </Link>{" "}
          to reconnect this platform before retrying.
        </p>
      ) : null}

      {canRetryTarget(target) ? (
        <button
          type="button"
          onClick={() => onRetry(target)}
          disabled={busy}
          className={`${SECONDARY} mt-2`}
        >
          {busy ? "Retrying…" : "Retry"}
        </button>
      ) : null}
    </li>
  );
}

type Notice = { tone: "success" | "error"; text: string };

export function PostsList() {
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    try {
      const response = await fetch("/api/posts", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as
        | { posts?: PostSummary[]; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(data?.error ?? "Could not load posts.");
      }

      setPosts(Array.isArray(data?.posts) ? data.posts : []);
      setError(null);
    } catch (loadError) {
      // A failed background refresh keeps the last good list on screen.
      if (!options.silent) {
        setError(
          loadError instanceof Error ? loadError.message : "Could not load posts.",
        );
      }
    }
  }, []);

  // The first load is a promise chain, so every state update happens in a
  // callback rather than synchronously inside the effect.
  useEffect(() => {
    let cancelled = false;

    fetch("/api/posts", { cache: "no-store" })
      .then(async (response) => ({
        ok: response.ok,
        data: (await response.json().catch(() => null)) as
          | { posts?: PostSummary[]; error?: string }
          | null,
      }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setError(data?.error ?? "Could not load posts.");
          return;
        }
        setPosts(Array.isArray(data?.posts) ? data.posts : []);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load posts.");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const polling = useMemo(
    () => (posts ? needsAutoRefresh(posts) : false),
    [posts],
  );

  useEffect(() => {
    if (!polling) return;

    const timer = window.setInterval(() => {
      void load({ silent: true });
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [polling, load]);

  async function publishNow(post: PostSummary) {
    if (!window.confirm("Publish this post now on every target that has not published yet?")) {
      return;
    }

    setBusyKey(`${post.id}:publish`);
    setNotice(null);
    try {
      const response = await fetch(`/api/posts/${post.id}/publish-now`, {
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) throw new Error(data?.error ?? "Could not publish the post.");

      setNotice({ tone: "success", text: "Publishing started. Refreshing status…" });
      await load({ silent: true });
    } catch (publishError) {
      setNotice({
        tone: "error",
        text:
          publishError instanceof Error
            ? publishError.message
            : "Could not publish the post.",
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function remove(post: PostSummary) {
    if (!window.confirm("Delete this post and its slides? This cannot be undone.")) {
      return;
    }

    setBusyKey(`${post.id}:delete`);
    setNotice(null);
    try {
      const response = await fetch(`/api/posts/${post.id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(data?.error ?? "Could not delete the post.");
      }

      setPosts((current) => (current ?? []).filter((row) => row.id !== post.id));
      setNotice({ tone: "success", text: "Post deleted." });
    } catch (deleteError) {
      setNotice({
        tone: "error",
        text:
          deleteError instanceof Error
            ? deleteError.message
            : "Could not delete the post.",
      });
    } finally {
      setBusyKey(null);
    }
  }

  async function retry(post: PostSummary, target: PostTargetSummary) {
    setBusyKey(`${target.id}:retry`);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/posts/${post.id}/targets/${target.id}/retry`,
        { method: "POST" },
      );
      const data = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) throw new Error(data?.error ?? "Could not retry the target.");

      setNotice({
        tone: "success",
        text: `${targetLabel(target.platform)} will be retried on the next dispatch.`,
      });
      await load({ silent: true });
    } catch (retryError) {
      setNotice({
        tone: "error",
        text:
          retryError instanceof Error
            ? retryError.message
            : "Could not retry the target.",
      });
    } finally {
      setBusyKey(null);
    }
  }

  if (error && !posts) {
    return (
      <div
        role="alert"
        className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
      >
        <p>{error}</p>
        <button type="button" onClick={() => void load()} className={`${SECONDARY} mt-3`}>
          Try again
        </button>
      </div>
    );
  }

  if (!posts) {
    return (
      <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">Loading posts…</p>
    );
  }

  const visible = filterPosts(posts, filter);

  return (
    <div className="mt-5">
      <div role="tablist" aria-label="Filter posts by status" className="flex flex-wrap gap-1">
        {STATUS_FILTERS.map((option) => {
          const active = filter === option.value;
          const count =
            option.value === "all"
              ? posts.length
              : posts.filter((post) => statusFilterOf(post.status) === option.value).length;

          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(option.value)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              }`}
            >
              {option.label}
              <span className="ml-1.5 text-xs opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {notice ? (
        <p
          role="status"
          className={`mt-4 rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
              : "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      {posts.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-zinc-300 p-6 text-center dark:border-zinc-700">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Nothing here yet. Write a post and save it as a draft or schedule it.
          </p>
          <Link href="/compose" className={`${PRIMARY} mt-3`}>
            Compose a post
          </Link>
        </div>
      ) : visible.length === 0 ? (
        <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
          No posts with this status.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {visible.map((post) => {
            const time = postTime(post);
            const timeLabel =
              time.kind === "published"
                ? "Published"
                : time.kind === "scheduled"
                  ? "Scheduled for"
                  : "Created";

            return (
              <li
                key={post.id}
                className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {previewOf(post.bodyText, 90) || "(no text)"}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {timeLabel} <LocalTime value={time.value} />
                      {post.scheduledAt && time.kind !== "scheduled" ? (
                        <>
                          {" · "}Scheduled for <LocalTime value={post.scheduledAt} />
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Badge tone={parentTone(post.status)}>{post.status}</Badge>
                </div>

                {/* Image posts lead with their first slide; a text-only post
                    has no thumbnail, so the caption is the whole preview. */}
                <div className="mt-2 flex items-start gap-3">
                  {!post.textOnly && post.media[0] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={post.media[0].url}
                      alt={`Slide ${post.media[0].slideIndex + 1}`}
                      className="h-16 w-12 shrink-0 rounded-md border border-zinc-200 object-cover dark:border-zinc-800"
                    />
                  ) : null}
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                      {previewOf(post.caption, 220)}
                    </p>
                    {post.textOnly ? (
                      <p className="mt-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                        Text only — no images
                      </p>
                    ) : post.media.length > 1 ? (
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        {post.media.length} slides
                      </p>
                    ) : null}
                  </div>
                </div>

                <ul className="mt-3 space-y-2">
                  {post.targets.map((target) => (
                    <TargetRow
                      key={target.id}
                      target={target}
                      busy={busyKey === `${target.id}:retry`}
                      onRetry={(row) => void retry(post, row)}
                    />
                  ))}
                </ul>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {canEditPost(post) ? (
                    <Link href={`/compose?id=${post.id}`} className={SECONDARY}>
                      Edit
                    </Link>
                  ) : null}
                  {canPublishNow(post) ? (
                    <button
                      type="button"
                      onClick={() => void publishNow(post)}
                      disabled={busyKey === `${post.id}:publish`}
                      className={PRIMARY}
                    >
                      {busyKey === `${post.id}:publish` ? "Publishing…" : "Publish now"}
                    </button>
                  ) : null}
                  <Link href={`/posts/${post.id}/export`} className={SECONDARY}>
                    Export
                  </Link>
                  {canDeletePost(post) ? (
                    <button
                      type="button"
                      onClick={() => void remove(post)}
                      disabled={busyKey === `${post.id}:delete`}
                      className={DANGER}
                    >
                      {busyKey === `${post.id}:delete` ? "Deleting…" : "Delete"}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
        {polling
          ? "Refreshing every 30 seconds while a target is still publishing."
          : "Statuses refresh automatically while something is in flight."}
      </p>
    </div>
  );
}
