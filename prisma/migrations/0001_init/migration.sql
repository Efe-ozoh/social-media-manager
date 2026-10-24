-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "platform" AS ENUM ('linkedin', 'facebook', 'instagram');

-- CreateEnum
CREATE TYPE "content_type" AS ENUM ('text', 'code');

-- CreateEnum
CREATE TYPE "carousel_mode" AS ENUM ('auto', 'on', 'off');

-- CreateEnum
CREATE TYPE "post_source" AS ENUM ('manual', 'ai');

-- CreateEnum
CREATE TYPE "post_status" AS ENUM ('draft', 'scheduled', 'processing', 'published', 'partial', 'failed');

-- CreateEnum
CREATE TYPE "target_status" AS ENUM ('pending', 'processing', 'published', 'failed');

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL,
    "platform" "platform" NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL,
    "title" VARCHAR(200),
    "body_text" TEXT NOT NULL,
    "content_type" "content_type" NOT NULL DEFAULT 'text',
    "code" TEXT,
    "language" VARCHAR(50),
    "theme" VARCHAR(50) NOT NULL,
    "caption" TEXT NOT NULL,
    "carousel_mode" "carousel_mode" NOT NULL DEFAULT 'auto',
    "source" "post_source" NOT NULL DEFAULT 'manual',
    "ai_prompt" TEXT,
    "status" "post_status" NOT NULL DEFAULT 'draft',
    "scheduled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_media" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "slide_index" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,

    CONSTRAINT "post_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_targets" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "platform" "platform" NOT NULL,
    "caption_override" TEXT,
    "status" "target_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "external_post_id" TEXT,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "post_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_platform_external_id_key" ON "social_accounts"("platform", "external_id");

-- CreateIndex
CREATE INDEX "posts_status_scheduled_at_idx" ON "posts"("status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "post_media_post_id_slide_index_key" ON "post_media"("post_id", "slide_index");

-- CreateIndex
CREATE INDEX "post_targets_status_idx" ON "post_targets"("status");

-- CreateIndex
CREATE INDEX "post_targets_post_id_idx" ON "post_targets"("post_id");

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
