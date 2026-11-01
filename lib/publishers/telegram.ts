/**
 * Telegram publisher — Telegram Bot API.
 *   https://core.telegram.org/bots/api
 *
 * Unlike LinkedIn and Meta, Telegram needs no OAuth: one bot token and one
 * chat id come from the environment (single-user app), which is why this
 * publisher reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID itself instead of
 * using `account.accessToken`. `account` is still carried so the publisher
 * fits the shared contract.
 *
 * Limits, from the official docs (checked against these pages):
 *   - text: 1-4096 characters, "after entities parsing"
 *     https://core.telegram.org/bots/api/methods/sendmessage
 *   - photo caption: 0-1024 characters, also after entities parsing
 *     https://core.telegram.org/bots/api/methods/sendphoto
 *   - media group: "must include 2-10 items"; each item carries its own
 *     caption, and the method returns an Array of Message objects
 *     https://core.telegram.org/bots/api/methods/sendmediagroup
 *   - photos sent by multipart upload: 10 MB max (5 MB when Telegram fetches
 *     the URL itself, which is why this publisher uploads the bytes)
 *     https://core.telegram.org/bots/api#sending-files
 *   - rate limits: about one message per second per chat, "not able to send
 *     more than 20 messages per minute" in a group, and about 30 per second
 *     overall; flood control answers 429 with `parameters.retry_after`
 *     https://core.telegram.org/bots/faq
 *     https://core.telegram.org/bots/api/types/responseparameters
 *
 * Because the 4096/1024 limits apply to the *parsed* text, lengths are checked
 * on the original caption and HTML escaping only happens on the way out: an
 * escaped `&` is `&amp;` on the wire but one character to Telegram.
 *
 * Parse mode is HTML, which needs three characters escaped (`&`, `<`, `>`), so
 * a stray `<` in the owner's text can never break a send. It is deliberately
 * not MarkdownV2, where eighteen characters need escaping.
 *   https://core.telegram.org/bots/api/formatting#html-style
 *
 * Captions over 1024 characters are not truncated: the images go first and the
 * full text follows as a separate message, which is recorded in `notes`.
 *
 * The bot token travels in the request URL (`/bot<token>/<method>`) — that is
 * the Bot API's design — so the URL is never put into an error, a log line or
 * an error's `cause`.
 */

import {
  PublishError,
  redactSecrets,
  validatePublishInput,
  type PublishInput,
  type PublishResult,
  type Publisher,
} from "./types";

export const TELEGRAM_API_ORIGIN = "https://api.telegram.org";

/** sendMessage: "Text of the message to be sent, 1-4096 characters". */
export const TELEGRAM_MAX_TEXT = 4_096;
/** sendPhoto / InputMediaPhoto: "0-1024 characters after entities parsing". */
export const TELEGRAM_MAX_CAPTION = 1_024;
/** sendMediaGroup: "must include 2-10 items". */
export const TELEGRAM_MIN_MEDIA_GROUP = 2;
export const TELEGRAM_MAX_MEDIA_GROUP = 10;
/** Photos uploaded as multipart: "10 MB max size for photos". */
export const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const REQUEST_TIMEOUT_MS = 30_000;

/** Consequences of a missing bot token, short of a crash. */
export class TelegramConfigError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      `Telegram is not configured. Set ${missing.join(" and ")} in .env.local ` +
        "(create the bot with @BotFather, then add it to the channel as an administrator).",
    );
    this.name = "TelegramConfigError";
    this.missing = missing;
  }
}

export type TelegramConfig = {
  botToken: string;
  chatId: string;
};

/**
 * Reads and validates the bot settings. Called on the publisher's first use
 * (never at import time, so importing this module cannot throw) and by the
 * publish-test script, which wants the missing-variable message up front.
 */
export function getTelegramConfig(
  env: Record<string, string | undefined> = process.env,
): TelegramConfig {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHANNEL_ID?.trim();

  const missing: string[] = [];
  if (!botToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!chatId) missing.push("TELEGRAM_CHANNEL_ID");
  if (missing.length > 0) throw new TelegramConfigError(missing);

  return { botToken: botToken as string, chatId: chatId as string };
}

/**
 * Escapes text for parse_mode "HTML": the docs require `<`, `>` and `&` to be
 * replaced, and `&` must go first or the entities would be escaped twice.
 * Quotes need no escaping in text content.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type FetchImpl = typeof fetch;

type TelegramResponse = {
  ok?: unknown;
  result?: unknown;
  description?: unknown;
  error_code?: unknown;
  parameters?: unknown;
};

export type TelegramPublisherOptions = {
  fetchImpl?: FetchImpl;
  /** Overrides the env config; used by tests and by scripted runs. */
  config?: Partial<TelegramConfig>;
  /** api.telegram.org, or a self-hosted Bot API server. */
  apiOrigin?: string;
  timeoutMs?: number;
};

function messageId(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "object" || first === null) return undefined;
  const id = (first as { message_id?: unknown }).message_id;
  return typeof id === "number" ? String(id) : undefined;
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : "";
}

/** Mime type from the file's first bytes, for the multipart part. */
function imageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  return "application/octet-stream";
}

/** `parameters.retry_after` first, then the Retry-After header. */
function retryAfterFrom(payload: TelegramResponse | null, response: Response): number | undefined {
  const parameters = payload?.parameters;
  if (typeof parameters === "object" && parameters !== null) {
    const retryAfter = (parameters as { retry_after?: unknown }).retry_after;
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.ceil(retryAfter);
    }
  }

  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined;
}

/** Descriptions that mean the bot is not allowed to post in that chat. */
const NO_RIGHTS_FRAGMENTS = [
  "not enough rights",
  "have no rights",
  "not a member of the chat",
  "bot is not a member",
  "bot was kicked",
  "chat_write_forbidden",
  "chat_admin_required",
  "not enough rights to send",
  "need administrator rights",
];

export class TelegramPublisher implements Publisher {
  readonly platform = "telegram" as const;
  /** A media group holds at most 10 photos. */
  readonly maxImages = TELEGRAM_MAX_MEDIA_GROUP;
  /** The text message limit; a longer caption is sent as a second message. */
  readonly maxCaptionLength = TELEGRAM_MAX_TEXT;

  private readonly options: TelegramPublisherOptions;

  constructor(options: TelegramPublisherOptions = {}) {
    this.options = options;
  }

  /** Env config, unless both values were injected. */
  config(): TelegramConfig {
    const botToken = this.options.config?.botToken?.trim();
    const chatId = this.options.config?.chatId?.trim();
    if (botToken && chatId) return { botToken, chatId };
    return getTelegramConfig();
  }

  /**
   * Checks the token against getMe and the channel against getChat, without
   * sending anything. Used by the publish-test script, which prints only the
   * bot username and the channel title.
   */
  async describeTarget(): Promise<{
    botUsername: string;
    botName: string;
    chatTitle: string;
    chatType: string;
  }> {
    const config = this.config();

    const me = await this.call(config, "getMe", {}, "Reading the bot account");
    const chat = await this.call(
      config,
      "getChat",
      { chat_id: config.chatId },
      "Reading the channel",
    );

    const name = [stringField(me, "first_name"), stringField(me, "last_name")]
      .filter(Boolean)
      .join(" ");

    return {
      botUsername: stringField(me, "username"),
      botName: name,
      chatTitle: stringField(chat, "title"),
      chatType: stringField(chat, "type"),
    };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    // Fails with a clear message before anything else when the env is missing.
    let config: TelegramConfig;
    try {
      config = this.config();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Telegram is not configured.";
      throw PublishError.validation("telegram", message);
    }

    validatePublishInput(this, input);

    const { account } = input;
    if (account.platform !== "telegram") {
      throw PublishError.validation(
        "telegram",
        `This publisher only handles Telegram accounts, not ${account.platform}.`,
      );
    }

    const caption = input.caption.trim();
    const notes: string[] = [];

    if (input.imageUrls.length === 0) {
      const id = await this.sendText(config, caption, "Publishing the message");
      return { externalPostId: id, publishedAt: new Date() };
    }

    const photos = await this.download(input.imageUrls);

    // Telegram caps a photo caption at 1024 characters, so a longer one goes
    // out as its own message rather than being truncated.
    const withCaption = caption.length <= TELEGRAM_MAX_CAPTION;
    if (!withCaption) {
      notes.push(
        `The caption is ${caption.length} characters, over Telegram's ${TELEGRAM_MAX_CAPTION}-character ` +
          "photo caption limit, so the images were sent first and the full text as a separate message.",
      );
    }

    const id =
      photos.length === 1
        ? await this.sendPhoto(config, photos[0], withCaption ? caption : null)
        : await this.sendMediaGroup(config, photos, withCaption ? caption : null);

    if (!withCaption) {
      await this.sendText(config, caption, "Sending the text");
    }

    return {
      externalPostId: id,
      publishedAt: new Date(),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  /** Fetches the slides, so local disk and Vercel Blob both work. */
  private async download(urls: string[]): Promise<Uint8Array[]> {
    return Promise.all(
      urls.map(async (url, index) => {
        const label = `Slide ${index + 1}`;

        let response: Response;
        try {
          response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        } catch {
          throw PublishError.network(
            "telegram",
            `${label} could not be downloaded from the image store. This will be retried.`,
          );
        }

        if (!response.ok) {
          throw PublishError.fromStatus(
            response.status,
            `${label} could not be downloaded from the image store (HTTP ${response.status}).`,
            { platform: "telegram" },
          );
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0) {
          throw new PublishError({
            code: "provider_error",
            platform: "telegram",
            message: `${label} downloaded as an empty file. This will be retried.`,
          });
        }
        if (bytes.byteLength > TELEGRAM_MAX_PHOTO_BYTES) {
          throw PublishError.validation(
            "telegram",
            `${label} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, but Telegram accepts at most ` +
              "10 MB per uploaded photo.",
          );
        }

        return bytes;
      }),
    );
  }

  private async sendText(
    config: TelegramConfig,
    text: string,
    label: string,
  ): Promise<string> {
    const result = await this.call(
      config,
      "sendMessage",
      { chat_id: config.chatId, text: escapeHtml(text), parse_mode: "HTML" },
      label,
    );
    return this.requireMessageId(result, label);
  }

  private async sendPhoto(
    config: TelegramConfig,
    photo: Uint8Array,
    caption: string | null,
  ): Promise<string> {
    const label = "Publishing the photo";
    const form = new FormData();
    form.set("chat_id", config.chatId);
    form.set("photo", photoPart(photo));
    if (caption !== null) {
      form.set("caption", escapeHtml(caption));
      form.set("parse_mode", "HTML");
    }

    const result = await this.callForm(config, "sendPhoto", form, label);
    return this.requireMessageId(result, label);
  }

  /** 2-10 photos as an album; the caption belongs to the first item. */
  private async sendMediaGroup(
    config: TelegramConfig,
    photos: Uint8Array[],
    caption: string | null,
  ): Promise<string> {
    const label = "Publishing the album";
    const form = new FormData();
    form.set("chat_id", config.chatId);

    const media = photos.map((_, index) => {
      const item: Record<string, string> = {
        type: "photo",
        media: `attach://photo${index}`,
      };
      if (index === 0 && caption !== null) {
        item.caption = escapeHtml(caption);
        item.parse_mode = "HTML";
      }
      return item;
    });

    form.set("media", JSON.stringify(media));
    photos.forEach((photo, index) => form.set(`photo${index}`, photoPart(photo)));

    const result = await this.callForm(config, "sendMediaGroup", form, label);

    // A media group answers with an Array of Message objects; the first one is
    // what this post is identified by.
    const id = messageId(result);
    if (!id) {
      throw new PublishError({
        code: "provider_error",
        platform: "telegram",
        message: `${label} returned no message id, so the post may not exist. Check the channel before retrying.`,
        retryable: false,
      });
    }
    return id;
  }

  private requireMessageId(result: unknown, label: string): string {
    const id = messageId(result);
    if (!id) {
      throw new PublishError({
        code: "provider_error",
        platform: "telegram",
        message: `${label} returned no message id, so the post may not exist. Check the channel before retrying.`,
        retryable: false,
      });
    }
    return id;
  }

  private get fetchImpl(): FetchImpl {
    return this.options.fetchImpl ?? fetch;
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private get apiOrigin(): string {
    return (this.options.apiOrigin ?? TELEGRAM_API_ORIGIN).replace(/\/+$/, "");
  }

  /** JSON call, used for everything that sends no file. */
  private call(
    config: TelegramConfig,
    method: string,
    params: Record<string, string>,
    label: string,
  ): Promise<unknown> {
    return this.request(config, method, JSON.stringify(params), "application/json", label);
  }

  /** Multipart call, used for photos and albums. */
  private callForm(
    config: TelegramConfig,
    method: string,
    form: FormData,
    label: string,
  ): Promise<unknown> {
    // No content-type here: fetch adds the multipart boundary itself.
    return this.request(config, method, form, null, label);
  }

  private async request(
    config: TelegramConfig,
    method: string,
    body: BodyInit,
    contentType: string | null,
    label: string,
  ): Promise<unknown> {
    // The bot token is part of the path, so this URL is never logged and never
    // attached to an error.
    const url = `${this.apiOrigin}/bot${config.botToken}/${method}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        ...(contentType ? { headers: { "content-type": contentType } } : {}),
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Deliberately no `cause`: a fetch error can carry the tokenised URL.
      throw PublishError.network(
        "telegram",
        `${label} could not reach Telegram. This will be retried.`,
      );
    }

    const payload = (await response.json().catch(() => null)) as TelegramResponse | null;
    if (!response.ok || payload?.ok !== true) {
      throw this.error(response, payload, config, label);
    }
    return payload.result;
  }

  /**
   * Maps a failed Bot API response. Telegram documents `error_code` as
   * "subject to change", so the branch is on the documented `ok` flag plus the
   * human-readable description, with the status as a fallback.
   */
  private error(
    response: Response,
    payload: TelegramResponse | null,
    config: TelegramConfig,
    label: string,
  ): PublishError {
    const status = response.status;
    const raw = typeof payload?.description === "string" ? payload.description.trim() : "";
    const detail = this.redact(raw || `HTTP ${status}`, config.botToken);
    const lower = detail.toLowerCase();
    const retryAfter = retryAfterFrom(payload, response);
    const common = { platform: "telegram" as const, status, detail };

    if (status === 401 || lower.includes("unauthorized")) {
      return new PublishError({
        ...common,
        code: "token_invalid",
        message:
          `${label} failed: Telegram rejected the bot token (HTTP ${status}). Check ` +
          "TELEGRAM_BOT_TOKEN in .env.local; if it was revoked in @BotFather, create a new one.",
      });
    }

    if (status === 429 || retryAfter !== undefined) {
      return new PublishError({
        ...common,
        code: "rate_limited",
        message:
          `${label} failed: Telegram is rate limiting this bot (HTTP ${status})` +
          (retryAfter !== undefined ? `; retry after ${retryAfter}s.` : "."),
        retryAfterSeconds: retryAfter,
      });
    }

    if (lower.includes("chat not found")) {
      return new PublishError({
        ...common,
        code: "validation",
        message:
          `${label} failed: Telegram could not find that chat (HTTP ${status}). Check ` +
          "TELEGRAM_CHANNEL_ID (the numeric -100… id, or @channelusername), and make sure the bot is a member.",
      });
    }

    if (NO_RIGHTS_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
      return new PublishError({
        ...common,
        code: "permission_denied",
        message:
          `${label} failed: the bot is not allowed to post there (HTTP ${status}). Add the bot to ` +
          'the channel as an administrator with "Post messages", or re-add it to the group.',
      });
    }

    if (status >= 500) {
      return new PublishError({
        ...common,
        code: "provider_error",
        message: `${label} failed: Telegram had a server error (HTTP ${status}). This will be retried.`,
      });
    }

    if (status >= 400) {
      return new PublishError({
        ...common,
        code: "validation",
        message: `${label} failed (HTTP ${status}). Telegram refused the request.`,
      });
    }

    return PublishError.fromStatus(status, `${label} failed (HTTP ${status}).`, {
      platform: "telegram",
      retryAfterSeconds: retryAfter,
      detail,
    });
  }

  /** Removes the bot token and anything token-shaped from provider text. */
  private redact(text: string, botToken: string): string {
    let out = text;
    if (botToken) out = out.split(botToken).join("[redacted token]");
    return redactSecrets(out);
  }
}

function photoPart(photo: Uint8Array): Blob {
  return new Blob([new Uint8Array(photo)], { type: imageMime(photo) });
}

/** The publisher the dispatcher uses by default. */
export const telegramPublisher = new TelegramPublisher();
