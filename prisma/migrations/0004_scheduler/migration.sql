-- Phase 4: scheduler state on post_targets.
--
-- next_attempt_at gates retries (pending targets are due once it is NULL or
-- reached), processing_started_at lets a crashed dispatch be recovered after
-- ten minutes, notes carries non-fatal publisher remarks to the dashboard, and
-- requires_reconnect flags an account the owner has to reconnect.

ALTER TABLE "post_targets"
    ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3),
    ADD COLUMN "processing_started_at" TIMESTAMPTZ(3),
    ADD COLUMN "notes" TEXT,
    ADD COLUMN "requires_reconnect" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "post_targets_status_next_attempt_at_idx"
    ON "post_targets"("status", "next_attempt_at");
