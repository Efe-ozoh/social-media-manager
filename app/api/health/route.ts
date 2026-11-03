import { NextResponse } from "next/server";
import { buildHealthReport } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const report = await buildHealthReport();
  return NextResponse.json(report, {
    headers: { "Cache-Control": "no-store" },
  });
}
