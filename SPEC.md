CodeSync Hub – Build Specification
Handoff document for a coding agent. Self-hosted tool to write or AI-generate a code post once, then publish or schedule it to LinkedIn, Facebook and Instagram.
1. Overview
CodeSync Hub is a single-user, self-hosted web app. The owner writes plain text (or has it AI-generated), picks target platforms, and either publishes immediately or schedules for later. The app converts the text to code only when the content calls for it, and long content is automatically split into multiple images so it can be posted as an Instagram carousel.
Target platforms (v1): LinkedIn, Facebook (Page), Instagram (Business or Creator account). No other networks in scope.
Out of scope for v1: X/Twitter, Dev.to, Discord, multi-user accounts, analytics, comment management.
2. Core Features
1. Dashboard to compose a post: plain-text input, a Convert to code setting (Auto, Always, Never), language and theme pickers, caption, platform toggles, schedule picker.
2. Two creation modes: manual (type it yourself) or AI-generate (topic or prompt sent to an LLM from the backend, result loads into the same editor for review).
3. Text-to-image rendering: content is rendered as styled PNG slides (plain-text cards, or syntax-highlighted "code card" look).
4. Carousel splitting: if the content does not fit on one slide, it is paginated into multiple slides (Instagram carousel; the same images are reused on Facebook and LinkedIn where supported).
5. Scheduler: posts are stored in a database with a scheduled time and dispatched reliably, with status tracking and retries.
6. Post history: list of posts with per-platform status (pending, processing, published, failed) and error messages.
3. Tech Stack
Concern
Choice
Framework
Next.js (App Router), TypeScript
Styling
TailwindCSS
Database
Postgres (Neon or Supabase free tier) with Prisma or Drizzle
Image rendering
Satori + resvg (JSX to SVG to PNG); Shiki for syntax tokens
Image hosting
Vercel Blob or Cloudinary (public HTTPS URLs required by Instagram)
Scheduler trigger
Protected cron endpoint called by an external pinger (see section 9)
Auth
NextAuth (single allowed account) or a single password
LLM
Provider-agnostic LLMProvider interface; API key in server env only
Hosting
Vercel (app); free-tier services elsewhere
The agent should verify current free-tier limits and API requirements for every external service before relying on them. Numbers in this document are indicative.
4. Architecture
Browser (Dashboard)
   |
   v
Next.js route handlers
   |-- /api/posts            create, list, update, delete posts
   |-- /api/generate         LLM draft generation
   |-- /api/render           code -> slides preview
   |-- /api/publish/[id]     publish now
   |-- /api/cron/dispatch    called every minute by external scheduler
   |-- /api/auth/*           login + platform OAuth callbacks
   v
Postgres  <---->  Publishers (linkedin / facebook / instagram)
   |
   v
Image store (public URLs)
5. Data Model
Use snake_case columns. All timestamps in UTC.
social_accounts
• id, platform (linkedin | facebook | instagram), external_id (member URN, Page ID or IG user ID), display_name
• access_token_enc, refresh_token_enc (nullable), expires_at
• created_at, updated_at
Tokens must be encrypted at rest (AES-256-GCM, key from env TOKEN_ENCRYPTION_KEY).
posts
• id, title (optional), body_text (the plain text the user wrote), content_type (text or code), code (nullable; the converted version when content_type is code), language (nullable), theme, caption
• carousel_mode (auto | on | off)
• source (manual | ai), ai_prompt (nullable)
• status (draft | scheduled | processing | published | partial | failed)
• scheduled_at (nullable), created_at, updated_at
post_media
• id, post_id, slide_index, url, width, height
post_targets
• id, post_id, platform
• caption_override (nullable)
• status (pending | processing | published | failed)
• attempts, last_error, external_post_id, published_at
A post is published when all targets are published, partial when some failed, and failed when all failed.
6. Publisher Interface
Every platform lives in one file under lib/publishers/ and implements:
interface Publisher {
  platform: 'linkedin' | 'facebook' | 'instagram';
  maxImages: number;
  maxCaptionLength: number;
  publish(input: {
    caption: string;
    imageUrls: string[];   // public HTTPS URLs, in slide order
    account: SocialAccount;
  }): Promise<{ externalPostId: string }>;
  refreshToken?(account: SocialAccount): Promise<SocialAccount>;
}
The dispatcher only talks to this interface. Adding a platform later means adding one file.
7. Platform Specifics
The agent must read each platform's current official documentation before implementing. Points below are the known constraints to design around.
LinkedIn
• OAuth 2.0 with the "Share on LinkedIn" product and the w_member_social scope.
• Posts via the Posts API; images are uploaded through the Images API, then referenced in the post. Multi-image posts are supported; confirm current format and limits.
• Access tokens are short-lived (around 60 days). Refresh tokens may not be available for this app type, so the UI must show a "Reconnect" prompt before expiry.
• Code is plain text on LinkedIn, so rendered images are the main way to preserve formatting.
Facebook
• Posting is to a Page, not a personal profile. The user must administer a Page.
• Uses a Meta developer app and a Page access token (derived from a long-lived user token).
• Multi-photo posts: upload each photo as unpublished, then create one feed post attaching all photo IDs. Scheduled publishing can be handled by our own scheduler (do not rely on Facebook-side scheduling).
Instagram
• Requires an Instagram Business or Creator account linked to the Facebook Page, accessed through the same Meta app.
• No text-only posts. Every post needs at least one image.
• Images must be reachable by a public HTTPS URL; the API fetches them.
• Single image: create media container, poll status_code until FINISHED, then publish.
• Carousel: create one child container per image (is_carousel_item=true), create a parent carousel container with the child IDs, poll until FINISHED, then publish.
• All carousel slides are cropped to the first slide's aspect ratio, so every slide must use the same size.
• Carousel item limit and caption/hashtag limits apply; read current docs (roughly 10 items, around 2,200 characters of caption, around 30 hashtags at the time of writing).
Meta app notes
• One Meta app covers Facebook and Instagram.
• In development mode, the app owner can post to their own accounts without app review. App review is only needed if other people will use the tool.
• Long-lived tokens last about 60 days. Implement a daily job that refreshes tokens expiring within 10 days, and flag accounts needing reconnection in the UI.
8. Content-to-Image Renderer and Carousel Splitter
Plain text input and code conversion
The user never has to write code. The editor takes plain text, and the app decides whether to turn it into code. A Convert to code setting controls this:
• Never: render the text as it is, on text cards (proportional font, larger size).
• Always: send the text to the LLM to convert it into a code snippet. For example, "a function that reverses a string" becomes working code.
• Auto (default): ask the LLM to classify the text as prose or as needing code, and convert only when it needs code.
• If the text already contains code (fenced or clearly code), use it as it is and detect the language instead of converting.
Implementation:
• Route POST /api/convert takes { text, mode } and returns JSON { content_type, code, language, explanation }. It uses the same LLMProvider and the same cost controls as section 10.
• The original text stays in body_text; converted code goes in code, and content_type is set to code.
• The converted code appears in the editor as a preview. The user can accept it, edit it, regenerate it, or switch back to plain text before scheduling. Nothing converted is published without that step.
• Converted code can be wrong. The preview must show a notice that generated code should be checked before posting.
• AI generation (section 10) follows the same rule: for a non-code topic, code is null and the post stays plain text.
Slide format
• Fixed size 1080 × 1350 px (4:5) for all slides.
• Monospace font for code cards and a proportional font for text cards (bundle the font files; do not depend on system fonts), fixed font size and line height.
• Themed background, window-style header optional, line numbers on the left, footer slide indicator such as 2 / 5.
Capacity
linesPerSlide = floor((slideHeight - verticalPadding) / lineHeight)
Splitter algorithm (lib/splitter.ts)
Input: text (plain or converted code), content type, language, config. Output: array of slides, each with its lines and starting line number.
1. Normalize tabs and line endings. Wrap lines wider than the slide's character capacity; wrapped lines count toward capacity and are marked as continuations (no new line number).
2. Fill each slide greedily up to linesPerSlide.
3. When a slide is full, look back at most 8 lines for a preferred break: a blank line, or a line that closes a block at indentation level 0 (for example } or the end of a function). Break there if found; otherwise hard-split.
4. Line numbers continue across slides.
5. If the result exceeds the carousel item cap (default 10), return a tooLong flag with the slide count so the UI can warn and offer to trim.
6. If everything fits on one slide, return a single slide (no indicator).
7. For plain text (the default input), split on paragraph, then sentence boundaries, using a proportional font and a larger size.
Tests required
• Empty input; one-line input; exactly linesPerSlide lines; one more than that.
• Very long single line (wrapping).
• Nested blocks where the preferred break is far from the limit.
• One giant function with no blank lines.
• Mixed tabs and spaces.
• More than the slide cap.
Rendering and storage
• Render each slide to PNG with Satori and resvg; tokenize with Shiki.
• Upload each PNG to the image store and save the URL in post_media.
• A preview endpoint renders slides without uploading, so the dashboard can show them before scheduling.
• Render once per post when it is created or edited, not on every publish attempt.
9. Scheduler
Vercel's free plan limits cron jobs to very infrequent runs, so do not depend on per-minute Vercel Cron. Instead:
• Expose POST /api/cron/dispatch, protected by a shared secret header (CRON_SECRET).
• Trigger it every minute (or every few minutes) from a free external scheduler such as cron-job.org, or a GitHub Actions scheduled workflow. Alternatively use Upstash QStash to deliver a message at each post's exact scheduled time. The agent should pick one and verify its current free limits.
• Posts may therefore publish up to one trigger interval late. Show this in the UI ("publishes within about 1 minute of the chosen time").
Dispatch logic
1. Select targets where the parent post is scheduled, scheduled_at <= now(), and target status is pending, using FOR UPDATE SKIP LOCKED so overlapping runs never double-post.
2. Mark each target processing and increment attempts.
3. Call the platform publisher. On success, store external_post_id and mark published.
4. On failure, store last_error. Retry with backoff (for example 1, 5, 15 minutes) up to 3 attempts, then mark failed.
5. Recompute the parent post status after each target finishes.
6. Treat token-expired and permission errors as non-retryable and surface a "Reconnect account" message.
7. Recover stuck jobs: targets in processing for more than 10 minutes are reset to pending.
"Publish now" uses the same code path with the target forced due immediately.
10. AI Post Generation
• Route: POST /api/generate with { prompt, language, tone, platforms[] }.
• Backend calls the configured LLM through LLMProvider.generate(); the API key never reaches the client.
• Prompt the model to return only JSON:
  {
    "code": "...",
    "language": "javascript",
    "caption": "...",
    "hashtags": ["..."],
    "variants": { "linkedin": "...", "instagram": "...", "facebook": "..." }
  }
• Strip any code fences, parse in try/catch, validate fields, retry once on failure, then return a clear error.
• Enforce platform caption limits after generation (truncate or ask the model to shorten).
• Generated content never publishes automatically. The result is placed in the editor as a draft with source = 'ai'. The user can edit, regenerate or discard it.
• UI affordances: "Regenerate", "Rewrite for platform", and saved prompt templates (optional, later).
• Cost controls: rate limit the route, cap max output tokens, and rely on a spending limit set in the provider's dashboard.
11. Dashboard UI
Minimal and clean, mobile-friendly.
• Compose page: mode switch (Manual / Generate); prompt box and "Generate" button in Generate mode; plain-text editor (a simple textarea), a Convert to code setting (Auto, Always, Never) with an editable code preview, language and theme selectors; caption field with per-platform character counters; platform toggles that are disabled when the account is not connected; carousel mode (Auto / On / Off); date-time picker with timezone display; "Save draft", "Schedule" and "Publish now" buttons.
• Slide preview: live carousel preview with next and previous controls; warning if the slide cap is exceeded.
• Posts page: table with status badges per platform, retry button for failed targets, edit and delete for unpublished posts, and error details.
• Accounts page: connect, reconnect and disconnect each platform; show token expiry dates and warn when close.
12. Auth and Security
• The entire app, including all API routes except OAuth callbacks and the cron endpoint, requires login.
• Cron endpoint requires CRON_SECRET; compare using a constant-time check.
• Encrypt stored tokens; never log tokens or full API responses containing them.
• Validate and sanitize all inputs (caption length, code size limit, language allowlist).
• OAuth: use the state parameter to prevent CSRF.
• Rate limit /api/generate and /api/render.
13. Environment Variables
DATABASE_URL=
AUTH_SECRET=
ALLOWED_LOGIN=            # the one permitted account or password hash
TOKEN_ENCRYPTION_KEY=
CRON_SECRET=
META_APP_ID=
META_APP_SECRET=
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
BLOB_READ_WRITE_TOKEN=    # or Cloudinary credentials
LLM_PROVIDER=
LLM_API_KEY=
LLM_MODEL=
APP_URL=
14. Build Phases and Acceptance Criteria
Phase 1: Foundation. Next.js project, Tailwind, database schema and migrations, login. Done when: you can log in and the schema is migrated.
Phase 2: Splitter and renderer. lib/splitter.ts with all listed tests passing; Satori rendering; image upload. Done when: pasting plain text or code in a test page yields correct, uploaded slides, including multi-slide output.
Phase 3: Publishers. OAuth connect flows plus the LinkedIn, Facebook and Instagram modules behind the Publisher interface. Done when: each platform can publish a single image post and a multi-image post to the owner's own account from a script.
Phase 4: Scheduler. Dispatch endpoint, locking, retries, status recomputation, stuck-job recovery, token refresh job. Done when: a post scheduled two minutes ahead publishes on its own, a forced failure retries then marks failed, and two simultaneous dispatch calls never double-post.
Phase 5: Dashboard. Compose, preview, posts and accounts pages wired to the APIs. Done when: the full manual flow works from the browser.
Phase 6: AI generation. LLMProvider, /api/generate, Generate mode in the editor, plus the Convert to code step (/api/convert). Done when: a prompt produces a valid draft in the editor, malformed model output is handled gracefully, and nothing publishes without the user pressing Schedule or Publish.
15. Things the Agent Must Verify Before Building
1. Current rate limits, carousel caps and caption limits for each platform API.
2. Current free-tier limits of the database, image host and scheduler trigger chosen.
3. LinkedIn multi-image post format and token lifetime for the app type.
4. Meta development-mode rules for posting to your own accounts.
5. Instagram image requirements (format, size, aspect ratio) so the renderer output is accepted.
Where documentation conflicts with this spec, follow the documentation and note the difference.