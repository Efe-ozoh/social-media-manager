/**
 * Publisher limits shared by the server-side publishers and the dashboard.
 *
 * The Compose page needs the real per-platform caption limits, but importing a
 * publisher module into a client component would drag in its network and
 * filesystem dependencies. Keep the numbers here, and let the publishers
 * re-export them so there is still one source of truth.
 */

/** Documented LinkedIn post text limit. */
export const LINKEDIN_MAX_CAPTION = 3_000;

/** sendMessage: "Text of the message to be sent, 1-4096 characters". */
export const TELEGRAM_MAX_TEXT = 4_096;

/** sendPhoto / InputMediaPhoto: "0-1024 characters after entities parsing". */
export const TELEGRAM_MAX_CAPTION = 1_024;
