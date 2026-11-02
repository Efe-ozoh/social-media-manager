import { describe, expect, it } from "vitest";
import { MAX_TEXT_CHARS } from "./preview-request";
import { parsePostCreate, parsePostUpdate } from "./post-request";

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
