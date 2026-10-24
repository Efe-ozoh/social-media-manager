# CodeSync Hub

Self-hosted, single-user tool to write or AI-generate a post once, then publish or schedule it
to LinkedIn, Facebook and Instagram. See `SPEC.md` for the full specification.

**Status: Phase 1 (foundation) only.** Next.js + TypeScript + Tailwind, the Postgres schema from
SPEC section 5 (Prisma), and single-user login. Compose, renderer, publishers, scheduler and AI
generation are not built yet.

## Stack

- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS 4
- Postgres via Prisma 7 (driver adapter `@prisma/adapter-pg`)
- Single-password login: scrypt hash in env + HMAC-signed session cookie

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create the env file:

   ```bash
   cp .env.example .env.local
   ```

   Fill in:
   - `DATABASE_URL` — a Postgres connection string (Neon, Supabase, or any Postgres).
   - `AUTH_SECRET` — 32+ random characters, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   - `ALLOWED_LOGIN` — the scrypt hash of your password: `npm run hash-password -- "your password"`.
   - `APP_URL` — `http://localhost:3000` in development.

3. Apply the schema:

   ```bash
   npm run db:migrate     # prisma migrate deploy (existing migration)
   ```

   `prisma migrate dev` is not used here because it needs a shadow database; if you want to
   iterate on the schema locally, `npm run db:migrate:dev` works when your Postgres user can
   create databases.

4. Run it:

   ```bash
   npm run dev      # http://localhost:3000
   ```

   `npm run build && npm start` for a production build.

## Checking Phase 1 acceptance

Phase 1 is done when "you can log in and the schema is migrated".

1. `npm run dev`, open `http://localhost:3000` — you are redirected to `/login`.
2. Enter the password you hashed into `ALLOWED_LOGIN`. You land on the status page, which shows
   **Login: authenticated** and **Database: connected — all 4 tables migrated**.
3. `npx prisma migrate status` should report the migration as applied and "Database schema is up to date".
4. `npm run db:studio` opens the tables: `social_accounts`, `posts`, `post_media`, `post_targets`.

## Notes

- All routes except `/login` and `/api/auth/login` require the session cookie; API routes return
  401, pages redirect to `/login?next=...`.
- Login is rate limited to 10 attempts per 10 minutes per IP (in-memory, per instance).
- The Prisma client is generated into `lib/generated/prisma` (gitignored) by `postinstall`,
  `npm run db:generate`, or any build.
