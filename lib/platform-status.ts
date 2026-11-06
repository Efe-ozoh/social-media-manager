/**
 * Safe platform connection status for the dashboard (SPEC section 11).
 *
 * The Compose page must know which automated targets can publish without ever
 * receiving a token or other secret. This module is pure: the route supplies
 * the environment and the social_accounts rows, and this turns them into
 * display-only data.
 *
 * Telegram reads its credentials from the environment, not social_accounts, so
 * "connected" there means "configured". We deliberately do not call the Bot API
 * just to learn the channel title: status must render without an extra network
 * request. LinkedIn's member name comes from the stored account row.
 */

import { automatedPlatforms, type PlatformName } from "./platforms";

/** Mirrors lib/token-expiry.ts; kept here so the client can import this safely. */
export const EXPIRY_WARNING_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PlatformStatusName = Extract<PlatformName, "linkedin" | "telegram">;

export type StatusAccountRow = {
  platform: PlatformName;
  displayName: string;
  expiresAt: Date | null;
};

export type PlatformStatus = {
  platform: PlatformStatusName;
  label: string;
  configured: boolean;
  connected: boolean;
  canPublish: boolean;
  /** Safe display name only; never an external id or token. */
  displayName: string | null;
  expiresAt: string | null;
  daysUntilExpiry: number | null;
  expired: boolean;
  expiresSoon: boolean;
  /** Why the platform cannot be selected as a target, if it cannot. */
  disabledReason: string | null;
};

export type BuildPlatformStatusInput = {
  env?: Record<string, string | undefined>;
  accounts?: StatusAccountRow[];
  now?: Date;
};

const LINKEDIN_ENV_NAMES = [
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "APP_URL",
] as const;

const TELEGRAM_ENV_NAMES = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"] as const;

function missingEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string[] {
  return names.filter((name) => !env[name]?.trim());
}

function claimedEnv(names: readonly string[]): string {
  return names.length === 1
    ? `${names[0]} is not set.`
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are not set.`;
}

function telegramLabel(platform: PlatformName): string {
  return platform === "telegram" ? "Telegram" : platform;
}

/**
 * Builds the status list in stable registry order. Only automated platforms are
 * included; manual-export targets have no connection to show and cannot be
 * scheduled from Compose.
 */
export function buildPlatformStatus(
  input: BuildPlatformStatusInput = {},
): PlatformStatus[] {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const accounts = new Map(
    (input.accounts ?? [])
      .filter((account) => account.platform === "linkedin")
      .map((account) => [account.platform, account]),
  );

  return automatedPlatforms(env)
    .filter(
      (platform): platform is PlatformStatusName =>
        platform === "linkedin" || platform === "telegram",
    )
    .map((platform) => {
      if (platform === "linkedin") {
        const account = accounts.get("linkedin");
        const missing = missingEnv(env, LINKEDIN_ENV_NAMES);
        const configured = missing.length === 0;
        const connected = Boolean(account);
        const expiresAt = account?.expiresAt ?? null;
        const msLeft = expiresAt ? expiresAt.getTime() - now.getTime() : null;
        const expired = msLeft !== null && msLeft <= 0;
        const expiresSoon =
          msLeft !== null && msLeft > 0 && msLeft <= EXPIRY_WARNING_DAYS * DAY_MS;
        const canPublish = configured && connected && !expired;

        let disabledReason: string | null = null;
        if (!configured) disabledReason = `LinkedIn is not configured: ${claimedEnv(missing)}`;
        else if (!connected) disabledReason = "Connect LinkedIn before selecting it.";
        else if (expired) {
          disabledReason = "The LinkedIn token has expired. Reconnect the account.";
        }

        return {
          platform,
          label: "LinkedIn",
          configured,
          connected,
          canPublish,
          displayName: account?.displayName.trim() || null,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          daysUntilExpiry: msLeft === null ? null : Math.floor(msLeft / DAY_MS),
          expired,
          expiresSoon,
          disabledReason,
        };
      }

      const missing = missingEnv(env, TELEGRAM_ENV_NAMES);
      const configured = missing.length === 0;
      return {
        platform,
        label: telegramLabel(platform),
        configured,
        connected: configured,
        canPublish: configured,
        // A channel title would require a Bot API request; omit it for now.
        displayName: null,
        expiresAt: null,
        daysUntilExpiry: null,
        expired: false,
        expiresSoon: false,
        disabledReason: configured
          ? null
          : `Telegram is not configured: ${claimedEnv(missing)}`,
      };
    });
}
