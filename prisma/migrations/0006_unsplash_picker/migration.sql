-- Phase 5c: the Unsplash background picker needs three things the first
-- background migration did not store:
--   * use_photo_behind_code — the "Use photo behind code" toggle (off by
--     default, so code cards stay solid).
--   * bg_credit_caption — append "Photo by {name} on Unsplash" to the caption
--     of automated posts (on by default).
--   * the photo's download endpoint plus the id already tracked, so the
--     download is reported to Unsplash exactly once per photo, when the post
--     is first scheduled or published.
ALTER TABLE "posts"
  ADD COLUMN "use_photo_behind_code" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bg_credit_caption" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "bg_download_location" TEXT,
  ADD COLUMN "bg_download_tracked" VARCHAR(64);
