import { describe, expect, it } from "vitest";
import {
  buildComposePayload,
  captionLimit,
  captionUsage,
  contentLimit,
  draftFingerprint,
  emptyComposeDraft,
  formatScheduleLabel,
  selectedPlatforms,
  sharedCaptionLimit,
  utcToLocalDateTime,
  usesBackgroundPhoto,
  validateComposeDraft,
  zonedDateTimeToUtc,
  type ComposeDraft,
} from "./compose-logic";
import {
  LINKEDIN_MAX_CAPTION,
  TELEGRAM_MAX_CAPTION,
  TELEGRAM_MAX_TEXT,
} from "./publisher-limits";
import type { PlatformStatus } from "./platform-status";

const NOW = new Date("2026-06-01T12:00:00Z");

const STATUSES: PlatformStatus[] = [
  {
    platform: "linkedin",
    label: "LinkedIn",
    configured: true,
    connected: true,
    canPublish: true,
    displayName: "Ada Lovelace",
    expiresAt: "2026-07-01T12:00:00.000Z",
    daysUntilExpiry: 30,
    expired: false,
    expiresSoon: false,
    disabledReason: null,
  },
  {
    platform: "telegram",
    label: "Telegram",
    configured: true,
    connected: true,
    canPublish: true,
    displayName: null,
    expiresAt: null,
    daysUntilExpiry: null,
    expired: false,
    expiresSoon: false,
    disabledReason: null,
  },
];

function draft(overrides: Partial<ComposeDraft> = {}): ComposeDraft {
  return {
    ...emptyComposeDraft(),
    text: "A useful tip",
    caption: "A useful tip",
    targets: { linkedin: true, telegram: false },
    ...overrides,
  };
}

describe("compose limits", () => {
  it("uses the API editor limits", () => {
    expect(contentLimit("text")).toBe(12_000);
    expect(contentLimit("code")).toBe(20_000);
  });

  it("uses the publishers' real caption limits", () => {
    expect(captionLimit("linkedin")).toBe(LINKEDIN_MAX_CAPTION);
    expect(captionLimit("telegram")).toBe(TELEGRAM_MAX_TEXT);
    expect(TELEGRAM_MAX_TEXT).toBe(4_096);
    expect(TELEGRAM_MAX_CAPTION).toBe(1_024);
  });

  it("counts an override only when it is non-blank", () => {
    expect(captionUsage(draft(), "linkedin").length).toBe(12);
    expect(
      captionUsage(draft({ captionOverrides: { linkedin: "Short", telegram: "" } }), "linkedin")
        .length,
    ).toBe(5);

    const inherited = captionUsage(
      draft({ captionOverrides: { linkedin: "   ", telegram: "" } }),
      "linkedin",
    );
    expect(inherited.length).toBe(12);
    expect(inherited.overLimit).toBe(false);
  });
});

describe("zonedDateTimeToUtc", () => {
  it("converts UTC and a DST-aware timezone", () => {
    expect(zonedDateTimeToUtc("2026-01-15T12:00", "UTC")?.toISOString()).toBe(
      "2026-01-15T12:00:00.000Z",
    );
    expect(
      zonedDateTimeToUtc("2026-01-15T12:00", "America/New_York")?.toISOString(),
    ).toBe("2026-01-15T17:00:00.000Z");
    expect(
      zonedDateTimeToUtc("2026-07-15T12:00", "America/New_York")?.toISOString(),
    ).toBe("2026-07-15T16:00:00.000Z");
  });

  it("rejects malformed and nonexistent local times", () => {
    expect(zonedDateTimeToUtc("not-a-date", "UTC")).toBeNull();
    expect(zonedDateTimeToUtc("2026-02-30T12:00", "UTC")).toBeNull();
    expect(
      zonedDateTimeToUtc("2026-03-08T02:30", "America/New_York"),
    ).toBeNull();
  });

  it("round-trips a UTC instant for editing", () => {
    expect(
      utcToLocalDateTime("2026-01-15T17:00:00.000Z", "America/New_York"),
    ).toBe("2026-01-15T12:00");
    expect(utcToLocalDateTime(null, "UTC")).toBe("");
  });

  it("labels both local and UTC time", () => {
    const label = formatScheduleLabel(
      new Date("2026-06-01T17:00:00.000Z"),
      "America/New_York",
    );
    expect(label).toContain("Jun 1, 2026");
    expect(label).toContain("UTC");
  });
});

describe("validateComposeDraft", () => {
  it("accepts a complete draft", () => {
    expect(
      validateComposeDraft({ draft: draft(), statuses: STATUSES, timeZone: "UTC", now: NOW }),
    ).toEqual({ ok: true });
  });

  it("requires text, caption and at least one target", () => {
    const result = validateComposeDraft({
      draft: draft({
        text: "",
        caption: "",
        targets: { linkedin: false, telegram: false },
      }),
      statuses: STATUSES,
      timeZone: "UTC",
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(3);
      expect(result.error).toContain("text");
    }
  });

  it("rejects disabled and expired platforms with their reason", () => {
    const disabled = STATUSES.map((status) =>
      status.platform === "linkedin"
        ? {
            ...status,
            canPublish: false,
            disabledReason: "The LinkedIn token has expired. Reconnect the account.",
          }
        : status,
    );
    const result = validateComposeDraft({
      draft: draft(),
      statuses: disabled,
      timeZone: "UTC",
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Reconnect");
  });

  it("enforces each selected platform's caption limit", () => {
    const result = validateComposeDraft({
      draft: draft({
        caption: "x".repeat(LINKEDIN_MAX_CAPTION + 1),
        targets: { linkedin: true, telegram: true },
      }),
      statuses: STATUSES,
      timeZone: "UTC",
      now: NOW,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("LinkedIn");
  });

  it("requires a future, valid schedule when asked", () => {
    const past = validateComposeDraft({
      draft: draft({ scheduleLocal: "2026-05-01T12:00" }),
      statuses: STATUSES,
      timeZone: "UTC",
      now: NOW,
      requireSchedule: true,
    });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error).toContain("future");

    const missing = validateComposeDraft({
      draft: draft(),
      statuses: STATUSES,
      timeZone: "UTC",
      now: NOW,
      requireSchedule: true,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("Choose a date");
  });
});

describe("buildComposePayload", () => {
  it("builds a scheduled payload with the local time converted to UTC", () => {
    const payload = buildComposePayload({
      draft: draft({
        contentType: "code",
        language: "typescript",
        scheduleLocal: "2026-06-02T09:30",
        targets: { linkedin: true, telegram: true },
        captionOverrides: { linkedin: "LinkedIn only", telegram: "" },
      }),
      intent: "schedule",
      timeZone: "America/New_York",
    });

    expect(payload).toMatchObject({
      text: "A useful tip",
      content_type: "code",
      code: "A useful tip",
      language: "typescript",
      caption: "A useful tip",
      carousel_mode: "auto",
      status: "scheduled",
      scheduled_at: "2026-06-02T13:30:00.000Z",
      targets: [
        { platform: "linkedin", caption_override: "LinkedIn only" },
        { platform: "telegram", caption_override: null },
      ],
    });
  });

  it("keeps the current status for a pre-publish PATCH", () => {
    const payload = buildComposePayload({
      draft: draft(),
      intent: "publish-now",
      timeZone: "UTC",
      includeStatus: false,
    });

    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("scheduled_at");
    expect(payload.code).toBeNull();
  });

  it("creates publish-now posts as drafts and clears a schedule", () => {
    const payload = buildComposePayload({
      draft: draft({ scheduleLocal: "2026-06-02T09:30" }),
      intent: "publish-now",
      timeZone: "UTC",
    });

    expect(payload.status).toBe("draft");
    expect(payload.scheduled_at).toBeNull();
  });

  it("fingerprints target toggles and overrides", () => {
    expect(draftFingerprint(draft())).not.toBe(
      draftFingerprint(draft({ targets: { linkedin: false, telegram: true } })),
    );
    expect(selectedPlatforms(draft({ targets: { linkedin: true, telegram: true } }))).toEqual([
      "linkedin",
      "telegram",
    ]);
  });
});

describe("text-only compose drafts", () => {
  it("sends text_only and drops the slide fields", () => {
    const payload = buildComposePayload({
      draft: draft({
        textOnly: true,
        text: "body that must not be published",
        caption: "Just words.",
        contentType: "code",
        language: "typescript",
        carouselMode: "on",
      }),
      intent: "draft",
      timeZone: "UTC",
    });

    expect(payload).toMatchObject({
      text_only: true,
      text: "",
      code: null,
      language: null,
      carousel_mode: "off",
      caption: "Just words.",
    });
  });

  it("does not need body text but still needs a caption", () => {
    const ok = validateComposeDraft({
      draft: draft({ textOnly: true, text: "", caption: "Just words." }),
      statuses: STATUSES,
      timeZone: "UTC",
      now: NOW,
    });
    expect(ok.ok).toBe(true);

    const missing = validateComposeDraft({
      draft: draft({ textOnly: true, text: "", caption: "   " }),
      statuses: STATUSES,
      timeZone: "UTC",
      now: NOW,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.errors.join(" ")).toContain("text-only");
  });

  it("uses the tightest selected platform for the shared counter", () => {
    expect(
      sharedCaptionLimit(
        draft({ textOnly: true, targets: { linkedin: true, telegram: true } }),
      ),
    ).toBe(LINKEDIN_MAX_CAPTION);
    expect(
      sharedCaptionLimit(
        draft({ textOnly: true, targets: { linkedin: false, telegram: true } }),
      ),
    ).toBe(TELEGRAM_MAX_TEXT);
    expect(
      sharedCaptionLimit(
        draft({ textOnly: true, targets: { linkedin: false, telegram: false } }),
      ),
    ).toBe(4_096);
  });

  it("refuses a caption over the selected limit before saving", () => {
    const result = validateComposeDraft({
      draft: draft({
        textOnly: true,
        caption: "x".repeat(LINKEDIN_MAX_CAPTION + 1),
        targets: { linkedin: true, telegram: false },
      }),
      statuses: STATUSES,
      timeZone: "UTC",
      now: NOW,
    });

    expect(result.ok).toBe(false);
  });

  it("fingerprints the format toggle", () => {
    expect(draftFingerprint(draft({ textOnly: true }))).not.toBe(
      draftFingerprint(draft({ textOnly: false })),
    );
  });
});

describe("background picker drafts", () => {
  const PHOTO = {
    id: "photo-1",
    url: "https://images.unsplash.com/photo-1?w=1080",
    thumbUrl: "https://images.unsplash.com/photo-1?w=360",
    authorName: "Jane Doe",
    authorUrl: "https://unsplash.com/@jane?utm_source=codesync_hub",
    color: "#1a2b3c",
    downloadLocation: "https://api.unsplash.com/photos/photo-1/download?ixid=abc",
  };

  it("sends the chosen photo, query and both toggles", () => {
    const payload = buildComposePayload({
      draft: draft({
        backgroundMode: "pick",
        backgroundQuery: " misty lake ",
        backgroundPhoto: PHOTO,
        usePhotoBehindCode: true,
      }),
      intent: "draft",
      timeZone: "UTC",
    });

    expect(payload.background).toEqual({
      mode: "unsplash",
      query: "misty lake",
      unsplashId: "photo-1",
      url: PHOTO.url,
      thumbUrl: PHOTO.thumbUrl,
      authorName: "Jane Doe",
      authorUrl: PHOTO.authorUrl,
      color: "#1a2b3c",
      downloadLocation: PHOTO.downloadLocation,
    });
    expect(payload.use_photo_behind_code).toBe(true);
    expect(payload.bg_credit_caption).toBe(true);
  });

  it("falls back to a solid background when no photo was chosen", () => {
    const payload = buildComposePayload({
      draft: draft({ backgroundMode: "auto", backgroundQuery: "misty lake" }),
      intent: "draft",
      timeZone: "UTC",
    });

    expect(payload.background).toEqual({ mode: "solid" });
    expect(payload.use_photo_behind_code).toBe(false);
    expect(payload.bg_credit_caption).toBe(true);
  });

  it("never sends a photo for a text-only post", () => {
    const payload = buildComposePayload({
      draft: draft({
        textOnly: true,
        caption: "Plain words",
        backgroundMode: "pick",
        backgroundPhoto: PHOTO,
      }),
      intent: "draft",
      timeZone: "UTC",
    });

    expect(payload.background).toEqual({ mode: "solid" });
    expect(payload.bg_credit_caption).toBe(true);
  });

  it("only counts a photo that will actually be used", () => {
    expect(
      usesBackgroundPhoto(draft({ backgroundMode: "pick", backgroundPhoto: PHOTO })),
    ).toBe(true);
    expect(
      usesBackgroundPhoto(draft({ backgroundMode: "off", backgroundPhoto: PHOTO })),
    ).toBe(false);
    expect(usesBackgroundPhoto(draft({ backgroundMode: "auto" }))).toBe(false);
    expect(
      usesBackgroundPhoto(
        draft({ textOnly: true, backgroundMode: "pick", backgroundPhoto: PHOTO }),
      ),
    ).toBe(false);
  });

  it("fingerprints the photo and the behind-code toggle", () => {
    expect(
      draftFingerprint(draft({ backgroundMode: "pick", backgroundPhoto: PHOTO })),
    ).not.toBe(draftFingerprint(draft({ backgroundMode: "pick" })));
    expect(draftFingerprint(draft({ usePhotoBehindCode: true }))).not.toBe(
      draftFingerprint(draft({ usePhotoBehindCode: false })),
    );
  });
});
