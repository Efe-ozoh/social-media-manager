import { describe, expect, it } from "vitest";
import {
  STATUS_FILTERS,
  attemptsLabel,
  canDeletePost,
  canEditPost,
  canPublishNow,
  canRetryTarget,
  filterPosts,
  formatLocalTime,
  matchesStatusFilter,
  needsAutoRefresh,
  postTime,
  previewOf,
  publishedPostUrl,
  statusFilterOf,
  targetLabel,
  targetTone,
} from "./post-targets";

const TARGET = {
  id: "t1",
  platform: "linkedin",
  status: "pending",
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  notes: null,
  requiresReconnect: false,
  externalPostId: null,
  publishedAt: null,
  processingStartedAt: null,
};

describe("status filters", () => {
  it("offers the tabs the posts page shows", () => {
    expect(STATUS_FILTERS.map((filter) => filter.value)).toEqual([
      "all",
      "draft",
      "scheduled",
      "published",
      "partial",
      "failed",
    ]);
  });

  it("keeps in-flight posts with the scheduled ones", () => {
    expect(statusFilterOf("processing")).toBe("scheduled");
    expect(statusFilterOf("scheduled")).toBe("scheduled");
  });

  it("maps every settled status to its own tab", () => {
    expect(statusFilterOf("draft")).toBe("draft");
    expect(statusFilterOf("published")).toBe("published");
    expect(statusFilterOf("partial")).toBe("partial");
    expect(statusFilterOf("failed")).toBe("failed");
  });

  it("keeps an unknown status visible instead of dropping it", () => {
    expect(statusFilterOf("something-new")).toBe("draft");
  });

  it("matches everything on the All tab", () => {
    expect(matchesStatusFilter("published", "all")).toBe(true);
    expect(matchesStatusFilter("draft", "published")).toBe(false);
  });

  it("filters without reordering", () => {
    const posts = [
      { id: "a", status: "published" },
      { id: "b", status: "draft" },
      { id: "c", status: "published" },
    ];

    expect(filterPosts(posts, "published").map((post) => post.id)).toEqual(["a", "c"]);
  });
});

describe("previewOf", () => {
  it("collapses whitespace so a card stays one line", () => {
    expect(previewOf("  first\n\n  line  ")).toBe("first line");
  });

  it("truncates with an ellipsis", () => {
    const preview = previewOf("a".repeat(50), 20);
    expect(preview).toHaveLength(20);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("returns an empty string for an empty body", () => {
    expect(previewOf("   \n ")).toBe("");
  });
});

describe("postTime", () => {
  it("prefers the latest publication", () => {
    const time = postTime({
      scheduledAt: "2026-06-01T12:00:00.000Z",
      createdAt: "2026-05-30T12:00:00.000Z",
      targets: [
        { publishedAt: "2026-06-01T12:01:00.000Z" },
        { publishedAt: "2026-06-01T12:02:00.000Z" },
      ],
    });

    expect(time).toEqual({ kind: "published", value: "2026-06-01T12:02:00.000Z" });
  });

  it("falls back to the scheduled time", () => {
    const time = postTime({
      scheduledAt: "2026-06-01T12:00:00.000Z",
      createdAt: "2026-05-30T12:00:00.000Z",
      targets: [{ publishedAt: null }],
    });

    expect(time).toEqual({ kind: "scheduled", value: "2026-06-01T12:00:00.000Z" });
  });

  it("shows the creation time for a draft", () => {
    const time = postTime({
      scheduledAt: null,
      createdAt: "2026-05-30T12:00:00.000Z",
      targets: [],
    });

    expect(time).toEqual({ kind: "created", value: "2026-05-30T12:00:00.000Z" });
  });
});

describe("formatLocalTime", () => {
  it("formats in the requested zone", () => {
    const iso = "2026-06-01T12:00:00.000Z";
    const utc = formatLocalTime(iso, { locale: "en-US", timeZone: "UTC" });
    const tokyo = formatLocalTime(iso, { locale: "en-US", timeZone: "Asia/Tokyo" });

    expect(utc).toContain("2026");
    expect(tokyo).toContain("2026");
    expect(utc).not.toBe(tokyo);
  });

  it("returns an empty string for an unparseable value", () => {
    expect(formatLocalTime("not a date")).toBe("");
  });
});

describe("capabilities", () => {
  it("allows editing a draft or scheduled post", () => {
    expect(canEditPost({ status: "draft", targets: [{ status: "pending" }] })).toBe(true);
    expect(canEditPost({ status: "scheduled", targets: [{ status: "pending" }] })).toBe(true);
  });

  it("refuses edits once a target has published or is publishing", () => {
    expect(
      canEditPost({ status: "scheduled", targets: [{ status: "published" }] }),
    ).toBe(false);
    expect(
      canEditPost({ status: "scheduled", targets: [{ status: "processing" }] }),
    ).toBe(false);
  });

  it("refuses edits after the post settled", () => {
    expect(canEditPost({ status: "published", targets: [] })).toBe(false);
    expect(canEditPost({ status: "failed", targets: [] })).toBe(false);
  });

  it("deletes only drafts and scheduled posts", () => {
    expect(canDeletePost({ status: "draft" })).toBe(true);
    expect(canDeletePost({ status: "scheduled" })).toBe(true);
    expect(canDeletePost({ status: "partial" })).toBe(false);
    expect(canDeletePost({ status: "published" })).toBe(false);
  });

  it("offers publish now while something is not published yet", () => {
    expect(canPublishNow({ targets: [{ status: "pending" }] })).toBe(true);
    expect(canPublishNow({ targets: [{ status: "failed" }] })).toBe(true);
    expect(canPublishNow({ targets: [{ status: "published" }] })).toBe(false);
  });

  it("retries only settled failures", () => {
    expect(canRetryTarget({ status: "failed" })).toBe(true);
    expect(canRetryTarget({ status: "pending" })).toBe(false);
    expect(canRetryTarget({ status: "published" })).toBe(false);
  });

  it("polls while anything is pending or processing", () => {
    expect(needsAutoRefresh([{ targets: [{ status: "pending" }] }])).toBe(true);
    expect(needsAutoRefresh([{ targets: [{ status: "processing" }] }])).toBe(true);
    expect(needsAutoRefresh([{ targets: [{ status: "published" }] }])).toBe(false);
    expect(needsAutoRefresh([])).toBe(false);
  });
});

describe("labels", () => {
  it("counts attempts readably", () => {
    expect(attemptsLabel(0)).toBe("no attempts yet");
    expect(attemptsLabel(1)).toBe("1 attempt");
    expect(attemptsLabel(3)).toBe("3 attempts");
  });

  it("names known platforms and passes unknown ones through", () => {
    expect(targetLabel("linkedin")).toBe("LinkedIn");
    expect(targetLabel("telegram")).toBe("Telegram");
    expect(targetLabel("threads")).toBe("threads");
  });

  it("tones each target status", () => {
    expect(targetTone("published")).toBe("published");
    expect(targetTone("processing")).toBe("processing");
    expect(targetTone("failed")).toBe("failed");
    expect(targetTone("pending")).toBe("pending");
  });
});

describe("publishedPostUrl", () => {
  it("builds the LinkedIn feed URL from a share URN", () => {
    expect(publishedPostUrl("linkedin", "urn:li:share:123")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:123/",
    );
    expect(publishedPostUrl("linkedin", "urn:li:ugcPost:456")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:ugcPost:456/",
    );
  });

  it("returns null when the id cannot give a reliable URL", () => {
    expect(publishedPostUrl("telegram", "42")).toBeNull();
    expect(publishedPostUrl("linkedin", null)).toBeNull();
    expect(publishedPostUrl("linkedin", "12345")).toBeNull();
    expect(publishedPostUrl("linkedin", "urn:li:share:abc")).toBeNull();
    expect(publishedPostUrl("linkedin", "urn:li:organization:1")).toBeNull();
  });

  it("ignores the target fixture when nothing was published", () => {
    expect(publishedPostUrl(TARGET.platform, TARGET.externalPostId)).toBeNull();
  });
});
