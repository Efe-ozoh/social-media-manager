import { NextResponse, type NextRequest } from "next/server";
import {
  cronSecretFromRequest,
  getCronSecret,
  isCronSecretValid,
} from "@/lib/cron-auth";
import { cronBatchLimit, dispatchDue } from "@/lib/dispatcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The 20s claim budget keeps normal runs short, but maxDuration is higher so a
// slow upload that started just before the budget can finish instead of being
// killed mid-publish.
export const maxDuration = 120;

/**
 * POST /api/cron/dispatch — called every minute by an external scheduler.
 *
 * Exempt from the login cookie (proxy.ts) but never from CRON_SECRET. The
 * secret may be sent as `x-cron-secret` or `Authorization: Bearer ...`.
 */
export async function POST(request: NextRequest) {
  const expected = getCronSecret();
  if (!expected) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured." },
      { status: 500 },
    );
  }

  if (!isCronSecretValid(cronSecretFromRequest(request), expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await dispatchDue({ limit: cronBatchLimit() });
    return NextResponse.json(
      { ok: true, ...summary },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Never echo the database error: it can contain the connection string.
    return NextResponse.json(
      { error: "Dispatch failed. Check the server logs." },
      { status: 500 },
    );
  }
}
