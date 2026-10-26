-- Phase 2b: Unsplash background photos on posts.
-- Purely additive: the 0001_init tables and data are untouched.

-- CreateEnum
CREATE TYPE "background_mode" AS ENUM ('solid', 'unsplash');

-- AlterTable
ALTER TABLE "posts"
    ADD COLUMN "background_mode" "background_mode" NOT NULL DEFAULT 'solid',
    ADD COLUMN "background_query" VARCHAR(120),
    ADD COLUMN "bg_unsplash_id" VARCHAR(64),
    ADD COLUMN "bg_url" TEXT,
    ADD COLUMN "bg_thumb_url" TEXT,
    ADD COLUMN "bg_author_name" VARCHAR(120),
    ADD COLUMN "bg_author_url" TEXT,
    ADD COLUMN "bg_color" VARCHAR(16);
