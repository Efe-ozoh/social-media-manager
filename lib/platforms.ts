/**
 * Platform registry — SPEC sections 5 and 6, after the v1 scope change.
 *
 * Two kinds of platform exist now:
 *
 *   automated      LinkedIn and Telegram. The app owns the post: it renders
 *                  the slides, uploads them and calls the platform's API.
 *   manual_export  Instagram and Facebook. Meta automated posting is switched
 *                  off, so these are export targets: the dashboard will hand
 *                  the owner the images and the caption to post by hand.
 *
 * This module is the single place that decides which platform is which, so the
 * scheduler, the dashboard and the publishers cannot drift apart. Nothing else
 * should hard-code a platform list.
 *
 * ENABLE_META gates Meta automated posting. It defaults to false: the Meta
 * OAuth routes answer "disabled", and Facebook/Instagram are never connectable
 * or schedulable. Manual export deliberately ignores the flag — handing the
 * owner the images and caption to post by hand is what replaced the blocked
 * account, so those targets stay available either way. The Meta publisher and
 * OAuth code is kept, and stays tested, so the switch can be turned back on
 * without rewriting anything.
 */

/** Every platform the data model knows about (Prisma enum `platform`). */
export type PlatformName = "linkedin" | "telegram" | "instagram" | "facebook";

/** Who does the publishing. */
export type PlatformMode = "automated" | "manual_export";

export type PlatformInfo = {
  name: PlatformName;
  label: string;
  mode: PlatformMode;
  /** Connected through an OAuth flow (Telegram uses env config instead). */
  oauth: boolean;
};

export const PLATFORMS: Record<PlatformName, PlatformInfo> = {
  linkedin: { name: "linkedin", label: "LinkedIn", mode: "automated", oauth: true },
  telegram: { name: "telegram", label: "Telegram", mode: "automated", oauth: false },
  instagram: { name: "instagram", label: "Instagram", mode: "manual_export", oauth: true },
  facebook: { name: "facebook", label: "Facebook Page", mode: "manual_export", oauth: true },
};

/** Stable order for lists in the UI and in logs. */
export const PLATFORM_NAMES: PlatformName[] = [
  "linkedin",
  "telegram",
  "instagram",
  "facebook",
];

const META_PLATFORMS: readonly PlatformName[] = ["facebook", "instagram"];

export function platformMode(platform: PlatformName): PlatformMode {
  return PLATFORMS[platform].mode;
}

export function platformLabel(platform: PlatformName): string {
  return PLATFORMS[platform].label;
}

/** Facebook and Instagram share one Meta app and one switch. */
export function isMetaPlatform(platform: PlatformName): boolean {
  return META_PLATFORMS.includes(platform);
}

/**
 * Reads ENABLE_META. Anything but an explicit yes is off, so a typo or a
 * missing variable leaves Meta disabled rather than half-enabled.
 */
export function isMetaEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.ENABLE_META?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

/** Platforms the app is allowed to show at all, Meta included only if enabled. */
function enabledPlatforms(env: Record<string, string | undefined>): PlatformName[] {
  return PLATFORM_NAMES.filter(
    (platform) => !isMetaPlatform(platform) || isMetaEnabled(env),
  );
}

/** Platforms the app publishes to itself. */
export function automatedPlatforms(
  env: Record<string, string | undefined> = process.env,
): PlatformName[] {
  return enabledPlatforms(env).filter((platform) => platformMode(platform) === "automated");
}

/**
 * Platforms the owner posts by hand from an export.
 *
 * This is the fallback for a blocked or switched-off automated account, so it
 * does not consult ENABLE_META: exporting slides for Instagram and Facebook is
 * exactly what keeps working while automated Meta posting is off. Only the
 * connect and schedule lists obey the flag.
 */
export function manualExportPlatforms(): PlatformName[] {
  return PLATFORM_NAMES.filter((platform) => platformMode(platform) === "manual_export");
}

/**
 * Platforms a post can be scheduled to. Manual-export platforms are never
 * schedulable, so the scheduler can only ever see automated ones.
 */
export function schedulablePlatforms(
  env: Record<string, string | undefined> = process.env,
): PlatformName[] {
  return automatedPlatforms(env);
}

/** Platforms with an OAuth connect flow worth offering right now. */
export function connectablePlatforms(
  env: Record<string, string | undefined> = process.env,
): PlatformName[] {
  return enabledPlatforms(env).filter((platform) => PLATFORMS[platform].oauth);
}
