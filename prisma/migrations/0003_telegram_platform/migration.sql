-- Phase 3c: Telegram joins LinkedIn as an automated publisher platform
-- (SPEC section 5: social_accounts.platform and post_targets.platform).
--
-- Appending a value to an existing enum needs no table rewrite. PostgreSQL 12+
-- allows this inside Prisma's migration transaction as long as the new value is
-- not used in the same transaction, which it is not here.
ALTER TYPE "platform" ADD VALUE IF NOT EXISTS 'telegram';
