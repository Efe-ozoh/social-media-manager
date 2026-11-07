-- Phase 5c: text-only posts.
--
-- A text-only post is published as plain text: nothing is rendered, no
-- post_media rows are written, and the dispatcher hands the publisher an empty
-- image list. The default keeps every existing post exactly as it was.

ALTER TABLE "posts"
    ADD COLUMN "text_only" BOOLEAN NOT NULL DEFAULT false;
