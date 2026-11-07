"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { PlatformStatus } from "@/lib/platform-status";
import { formatLocalTime } from "@/lib/post-targets";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * Connection state for the two automated platforms.
 *
 * LinkedIn's state, expiry and warning come from GET /api/platforms/status,
 * whose `expiring` list is built by the token-expiry helper. Telegram's bot and
 * channel names come from GET /api/platforms/telegram, which only calls getMe
 * and getChat. Neither response can contain a token.
 *
 * Meta is deliberately absent: Facebook and Instagram are manual-export
 * platforms and the detail page would need Meta credentials we no longer use.
 */

type ExpiringAccount = {
  id: string;
  platform: string;
  displayName: string;
  expiresAt: string | null;
  daysUntilExpiry: number;
  expired: boolean;
  requiresReconnect: boolean;
};

type StatusPayload = {
  platforms?: PlatformStatus[];
  expiring?: ExpiringAccount[];
  error?: string;
};

type TelegramInfo = {
  configured: boolean;
  botName: string | null;
  botUsername: string | null;
  channelTitle: string | null;
  channelType: string | null;
  error: string | null;
};

const PRIMARY =
  "inline-flex items-center justify-center rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const SECONDARY =
  "inline-flex items-center justify-center rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

function Card({
  title,
  status,
  children,
}: {
  title: string;
  status: { label: string; tone: "ok" | "warn" | "off" };
  children: ReactNode;
}) {
  const tone =
    status.tone === "ok"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
      : status.tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        : "border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200";

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>
          {status.label}
        </span>
      </div>
      <div className="mt-3 space-y-2 text-sm">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="text-zinc-600 dark:text-zinc-400">
      <span className="font-medium text-zinc-900 dark:text-zinc-100">{label}:</span>{" "}
      {children}
    </p>
  );
}

export function AccountsList() {
  const [statuses, setStatuses] = useState<PlatformStatus[] | null>(null);
  const [expiring, setExpiring] = useState<ExpiringAccount[]>([]);
  const [telegram, setTelegram] = useState<TelegramInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setTelegramError(null);

    const [statusResponse, telegramResponse] = await Promise.all([
      fetch("/api/platforms/status", { cache: "no-store" }).catch(() => null),
      fetch("/api/platforms/telegram", { cache: "no-store" }).catch(() => null),
    ]);

    try {
      if (!statusResponse || !statusResponse.ok) {
        const data = (await statusResponse?.json().catch(() => null)) as
          | { error?: string }
          | null
          | undefined;
        throw new Error(data?.error ?? "Could not load the connection status.");
      }

      const data = (await statusResponse.json()) as StatusPayload;
      setStatuses(Array.isArray(data.platforms) ? data.platforms : []);
      setExpiring(Array.isArray(data.expiring) ? data.expiring : []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load the connection status.",
      );
    }

    try {
      const data = (await telegramResponse?.json().catch(() => null)) as
        | TelegramInfo
        | null
        | undefined;

      if (!data) throw new Error("Could not check Telegram.");
      setTelegram(data);
      if (data.error) setTelegramError(data.error);
    } catch (checkError) {
      setTelegramError(
        checkError instanceof Error ? checkError.message : "Could not check Telegram.",
      );
      setTelegram(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial check as a promise chain: state updates land in callbacks, not
  // synchronously inside the effect.
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch("/api/platforms/status", { cache: "no-store" }).catch(() => null),
      fetch("/api/platforms/telegram", { cache: "no-store" }).catch(() => null),
    ])
      .then(async ([statusResponse, telegramResponse]) => ({
        statusResponse,
        statusData: (await statusResponse?.json().catch(() => null)) as
          | StatusPayload
          | null
          | undefined,
        telegramData: (await telegramResponse?.json().catch(() => null)) as
          | TelegramInfo
          | null
          | undefined,
      }))
      .then(({ statusResponse, statusData, telegramData }) => {
        if (cancelled) return;

        if (!statusResponse || !statusResponse.ok) {
          setError(statusData?.error ?? "Could not load the connection status.");
        } else {
          setStatuses(Array.isArray(statusData?.platforms) ? statusData.platforms : []);
          setExpiring(Array.isArray(statusData?.expiring) ? statusData.expiring : []);
        }

        if (!telegramData) {
          setTelegramError("Could not check Telegram.");
        } else {
          setTelegram(telegramData);
          if (telegramData.error) setTelegramError(telegramData.error);
        }

        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Could not load the connection status.");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const linkedin = statuses?.find((platform) => platform.platform === "linkedin") ?? null;
  const linkedinWarning = expiring.find((account) => account.platform === "linkedin") ?? null;

  return (
    <div className="mt-5 space-y-4">
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          <p>{error}</p>
          <button type="button" onClick={() => void load()} className={`${SECONDARY} mt-3`}>
            Try again
          </button>
        </div>
      ) : null}

      {loading && !statuses ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Checking accounts…</p>
      ) : null}

      {linkedin || !statuses ? (
        <Card
          title="LinkedIn"
          status={
            linkedin?.expired
              ? { label: "Token expired", tone: "warn" }
              : linkedin?.connected
                ? { label: "Connected", tone: "ok" }
                : { label: "Not connected", tone: "off" }
          }
        >
          {linkedin ? (
            <>
              <Field label="Member">
                {linkedin.displayName ?? "Not known yet"}
              </Field>
              <Field label="Token expires">
                {linkedin.expiresAt ? (
                  <>
                    <LocalDate value={linkedin.expiresAt} />
                    {linkedin.daysUntilExpiry !== null ? (
                      linkedin.expired ? (
                        <> (expired)</>
                      ) : (
                        <> ({linkedin.daysUntilExpiry} day
                        {linkedin.daysUntilExpiry === 1 ? "" : "s"} left)</>
                      )
                    ) : null}
                  </>
                ) : (
                  "No expiry recorded"
                )}
              </Field>

              {linkedin.expired ? (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-relaxed text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                  The LinkedIn token has expired, so scheduled posts will fail
                  until the account is reconnected.
                </p>
              ) : linkedin.expiresSoon ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  The LinkedIn token expires
                  {linkedin.daysUntilExpiry !== null
                    ? ` in ${linkedin.daysUntilExpiry} day${
                        linkedin.daysUntilExpiry === 1 ? "" : "s"
                      }`
                    : " soon"}
                  . Reconnect before then; LinkedIn cannot refresh it for this
                  app type.
                </p>
              ) : linkedinWarning ? (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  Token expiry warning from the shared expiry check.
                </p>
              ) : null}

              {linkedin.disabledReason ? (
                <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {linkedin.disabledReason}
                </p>
              ) : null}

              <a href="/api/auth/linkedin/start" className={`${PRIMARY} mt-1`}>
                {linkedin.connected ? "Reconnect LinkedIn" : "Connect LinkedIn"}
              </a>
            </>
          ) : (
            <p className="text-zinc-600 dark:text-zinc-400">Loading LinkedIn…</p>
          )}
        </Card>
      ) : null}

      <Card
        title="Telegram"
        status={
          telegram?.configured
            ? { label: "Configured", tone: "ok" }
            : telegram
              ? { label: "Not configured", tone: "off" }
              : { label: "Unknown", tone: "warn" }
        }
      >
        {telegram?.configured ? (
          <>
            <Field label="Bot">
              {telegram.botName ?? "Unnamed bot"}
              {telegram.botUsername ? ` (@${telegram.botUsername})` : ""}
            </Field>
            <Field label="Channel">
              {telegram.channelTitle ?? "Title not returned"}
              {telegram.channelType ? ` (${telegram.channelType})` : ""}
            </Field>
            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              Read with getMe and getChat only. Nothing is sent to the channel to
              check it.
            </p>
          </>
        ) : telegram ? (
          <p className="text-zinc-600 dark:text-zinc-400">
            {telegram.error ??
              "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID in the server environment."}
          </p>
        ) : (
          <p className="text-zinc-600 dark:text-zinc-400">
            {telegramError ?? "Checking Telegram…"}
          </p>
        )}

        <button type="button" onClick={() => void load()} className={`${SECONDARY} mt-1`}>
          Check again
        </button>
      </Card>
    </div>
  );
}

/** Same post-mount rule as the posts list: never print the server's timezone. */
function LocalDate({ value }: { value: string }) {
  const hydrated = useHydrated();

  return (
    <time dateTime={value} suppressHydrationWarning>
      {hydrated ? formatLocalTime(value) : "…"}
    </time>
  );
}
