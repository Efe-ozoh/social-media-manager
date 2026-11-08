import { describe, expect, it } from "vitest";
import { MAX_TEXT_CHARS } from "./preview-request";
import {
  changesRenderedContent,
  parsePostCreate,
  parsePostUpdate,
} from "./post-request";
import { LINKEDIN_MAX_CAPTION, TELEGRAM_MAX_TEXT } from "./publisher-limits";

const NOW = new Date("2026-06-01T12:00:00Z");
const FUTURE = "2026-06-01T12:05:00Z";
const ENV = {
  ENABLE_META: "true",
  TELEGRAM_BOT_TOKEN: "123456789:AAHtest-token-do-not-leak-0123456789ab",
  TELEGRAM_CHANNEL_ID: "-1001234567890",
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    text: "A plain text post about the scheduler.",
    content_type: "text",
    language: null,
    caption: "Scheduler post",
    carousel_mode: "auto",
    targets: ["telegram"],
    ...overrides,
  };
}

describe("parsePostCreate", () => {
  it("accepts a draft with the automated platforms", () => {
    const result = parsePostCreate(
      body({
        targets: [
          "telegram",
          { platform: "linkedin", caption_override: "LinkedIn only" },
        ],
      }),
      { now: NOW, env: ENV },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("draft");
    expect(result.value.scheduledAt).toBeNull();
    expect(result.value.targets).toEqual([
      { platform: "telegram", captionOverride: null },
      { platform: "linkedin", captionOverride: "LinkedIn only" },
    ]);
  });

  it("accepts a future scheduled post", () => {
    const result = parsePostCreate(
      body({ scheduled_at: FUTURE }),
      { now: NOW, env: ENV },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("scheduled");
    expect(result.value.scheduledAt?.toISOString()).toBe(new Date(FUTURE).toISOString());
  });

  it("rejects a scheduled time in the past or without an offset", () => {
    const past = parsePostCreate(
      body({ scheduled_at: "2026-06-01T11:59:00Z" }),
      { now: NOW, env: ENV },
    );
    expect(past).toMatchObject({ ok: false, status: 400 });

    const noZone = parsePostCreate(
      body({ scheduled_at: "2026-06-01T12:05:00" }),
      { now: NOW, env: ENV },
    );
    expect(noZone).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a draft that also carries a scheduled time", () => {
    const result = parsePostCreate(
      body({ status: "draft", scheduled_at: FUTURE }),
      { now: NOW, env: ENV },
    );

    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("enforces the preview text size limit", () => {
    const result = parsePostCreate(
      body({ text: "x".repeat(MAX_TEXT_CHARS + 1) }),
      { now: NOW, env: ENV },
    );

    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects Facebook and Instagram even when Meta is enabled", () => {
    for (const platform of ["instagram", "facebook"]) {
      const result = parsePostCreate(
        body({ targets: [platform] }),
        { now: NOW, env: ENV },
      );

      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.status).toBe(400);
      expect(result.error).toContain("manual-export");
    }
  });

  it("rejects duplicate and unknown platforms", () => {
    expect(
      parsePostCreate(body({ targets: ["telegram", "telegram"] }), {
        now: NOW,
        env: ENV,
      }),
    ).toMatchObject({ ok: false, status: 400 });

    expect(
      parsePostCreate(body({ targets: ["mastodon"] }), { now: NOW, env: ENV }),
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe("parsePostUpdate", () => {
  it("turns a scheduled post back into a draft when status is draft", () => {
    const result = parsePostUpdate(
      { status: "draft" },
      {
        now: NOW,
        env: ENV,
        currentContentType: "text",
        currentScheduledAt: new Date(FUTURE),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("draft");
    expect(result.value.scheduledAt).toBeNull();
  });

  it("rejects target changes to a manual-export platform", () => {
    const result = parsePostUpdate(
      { targets: ["instagram"] },
      { now: NOW, env: ENV, currentContentType: "text" },
    );

    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("requires at least one field", () => {
    expect(
      parsePostUpdate({}, { now: NOW, env: ENV, currentContentType: "text" }),
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe("text-only posts", () => {
  function textOnly(overrides: Record<string, unknown> = {}) {
    return {
      text_only: true,
      caption: "Just words, no slides.",
      targets: ["telegram"],
      ...overrides,
    };
  }

  it("accepts a post with no body text and pins it to one text card", () => {
    const result = parsePostCreate(textOnly({ carousel_mode: "on" }), {
      now: NOW,
      env: ENV,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.textOnly).toBe(true);
    expect(result.value.bodyText).toBe("");
    expect(result.value.contentType).toBe("text");
    expect(result.value.code).toBeNull();
    expect(result.value.language).toBeNull();
    expect(result.value.carouselMode).toBe("off");
  });

  it("still requires a caption", () => {
    const result = parsePostCreate(textOnly({ caption: "   " }), {
      now: NOW,
      env: ENV,
    });

    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("enforces LinkedIn's 3,000 character caption limit", () => {
    const atLimit = parsePostCreate(
      textOnly({ caption: "x".repeat(LINKEDIN_MAX_CAPTION), targets: ["linkedin"] }),
      { now: NOW, env: ENV },
    );
    expect(atLimit.ok).toBe(true);

    const tooLong = parsePostCreate(
      textOnly({
        caption: "x".repeat(LINKEDIN_MAX_CAPTION + 1),
        targets: ["linkedin"],
      }),
      { now: NOW, env: ENV },
    );
    expect(tooLong).toMatchObject({ ok: false, status: 413 });
    if (tooLong.ok) return;
    expect(tooLong.error).toContain("linkedin");
  });

  it("enforces Telegram's 4,096 character message limit", () => {
    const atLimit = parsePostCreate(
      textOnly({ caption: "x".repeat(TELEGRAM_MAX_TEXT) }),
      { now: NOW, env: ENV },
    );
    expect(atLimit.ok).toBe(true);

    const tooLong = parsePostCreate(
      textOnly({ caption: "x".repeat(TELEGRAM_MAX_TEXT + 1) }),
      { now: NOW, env: ENV },
    );
    expect(tooLong).toMatchObject({ ok: false, status: 413 });
  });

  it("checks each platform's caption override too", () => {
    const result = parsePostCreate(
      textOnly({
        caption: "Short shared caption",
        targets: [
          { platform: "linkedin", caption_override: "x".repeat(LINKEDIN_MAX_CAPTION + 1) },
        ],
      }),
      { now: NOW, env: ENV },
    );

    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects a code card and a non-boolean flag", () => {
    expect(
      parsePostCreate(textOnly({ content_type: "code" }), { now: NOW, env: ENV }),
    ).toMatchObject({ ok: false, status: 400 });

    expect(
      parsePostCreate(textOnly({ text_only: "yes" }), { now: NOW, env: ENV }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("still refuses Instagram and Facebook targets", () => {
    for (const platform of ["instagram", "facebook"]) {
      const result = parsePostCreate(textOnly({ targets: [platform] }), {
        now: NOW,
        env: ENV,
      });

      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toContain("manual-export");
    }
  });

  it("validates the stored caption when a PATCH turns a post text only", () => {
    const result = parsePostUpdate(
      { text_only: true },
      {
        now: NOW,
        env: ENV,
        currentTextOnly: false,
        currentCaption: "x".repeat(LINKEDIN_MAX_CAPTION + 1),
        currentTargets: [{ platform: "linkedin", captionOverride: null }],
      },
    );

    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it("lets a PATCH turn text-only off again", () => {
    const result = parsePostUpdate(
      { text_only: false },
      {
        now: NOW,
        env: ENV,
        currentContentType: "text",
        currentTextOnly: true,
        currentCaption: "Just words.",
        currentTargets: [{ platform: "linkedin", captionOverride: null }],
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.textOnly).toBe(false);
  });
});

describe("background photo options", () => {
  const PHOTO = {
    mode: "unsplash",
    query: "misty lake",
    unsplashId: "photo-1",
    url: "https://images.unsplash.com/photo-1?w=1080&h=1350",
    thumbUrl: "https://images.unsplash.com/photo-1?w=360&h=450",
    authorName: "Jane Doe",
    authorUrl: "https://unsplash.com/@jane?utm_source=codesync_hub",
    color: "#1a2b3c",
    downloadLocation: "https://api.unsplash.com/photos/photo-1/download?ixid=abc",
  };

  it("stores the photo, its download endpoint and both toggles", () => {
    const result = parsePostCreate(
      body({
        background: PHOTO,
        use_photo_behind_code: true,
        bg_credit_caption: false,
      }),
      { now: NOW, env: ENV },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.background.backgroundMode).toBe("unsplash");
    expect(result.value.background.bgUnsplashId).toBe("photo-1");
    expect(result.value.background.bgDownloadLocation).toBe(
      PHOTO.downloadLocation,
    );
    expect(result.value.usePhotoBehindCode).toBe(true);
    expect(result.value.creditCaption).toBe(false);
  });

  it("defaults to a solid background with the credit on", () => {
    const result = parsePostCreate(body(), { now: NOW, env: ENV });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.background).toEqual({
      backgroundMode: "solid",
      backgroundQuery: null,
      bgUnsplashId: null,
      bgUrl: null,
      bgThumbUrl: null,
      bgAuthorName: null,
      bgAuthorUrl: null,
      bgColor: null,
      bgDownloadLocation: null,
    });
    expect(result.value.usePhotoBehindCode).toBe(false);
    expect(result.value.creditCaption).toBe(true);
  });

  it("rejects a download endpoint that is not Unsplash's", () => {
    const result = parsePostCreate(
      body({
        background: { ...PHOTO, downloadLocation: "https://evil.example/download" },
      }),
      { now: NOW, env: ENV },
    );

    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects non-boolean toggles", () => {
    expect(
      parsePostCreate(body({ use_photo_behind_code: "yes" }), { now: NOW, env: ENV }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      parsePostCreate(body({ bg_credit_caption: 1 }), { now: NOW, env: ENV }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("accepts the same fields on a PATCH", () => {
    const result = parsePostUpdate(
      {
        background: PHOTO,
        use_photo_behind_code: true,
        bg_credit_caption: false,
      },
      { now: NOW, env: ENV },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.background?.bgDownloadLocation).toBe(
      PHOTO.downloadLocation,
    );
    expect(result.value.usePhotoBehindCode).toBe(true);
    expect(result.value.creditCaption).toBe(false);
  });

  it("renders again when the behind-code toggle changes", () => {
    expect(changesRenderedContent({ usePhotoBehindCode: true })).toBe(true);
    expect(changesRenderedContent({ creditCaption: false })).toBe(false);
  });
});
