-- Phase 6: a database-backed daily counter for the AI routes.
-- A module-level counter is per serverless instance; this row is shared, so
-- GEN_DAILY_CAP cannot be multiplied by the number of warm instances.
CREATE TABLE "ai_daily_budgets" (
    "day" VARCHAR(10) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_daily_budgets_pkey" PRIMARY KEY ("day")
);
