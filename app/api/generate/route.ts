import { NextResponse, type NextRequest } from "next/server";
import { checkAiBudget } from "@/lib/ai-budget";
import { parseGenerateRequest } from "@/lib/ai-request";
import { generatePost } from "@/lib/ai-service";
import { readJsonBody } from "@/lib/api-body";
import { createGeminiProvider } from "@/lib/llm/gemini";
import { llmErrorToHttp } from "@/lib/llm/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

/**
 * POST /api/generate
 *
 * Body: { prompt, contentType?, language?, tone?, platforms? }
 * Returns the validated draft only. Nothing is saved or published here; the
 * Compose page places it in the editor, and the owner must still save,
 * schedule or press Publish now. Login is enforced by proxy.ts.
 */
export async function POST(request: NextRequest) {
  const budget = await checkAiBudget(clientIp(request));
  if (!budget.ok) {
    return NextResponse.json(
      {
        error:
          budget.reason === "unavailable"
            ? "The AI request budget is temporarily unavailable. Try again shortly."
            : budget.reason === "daily"
              ? "The daily AI request limit has been reached. Try again after midnight UTC."
              : "Too many AI requests. Try again shortly.",
        code: budget.reason,
      },
      {
        status: budget.reason === "unavailable" ? 503 : 429,
        headers: { "Retry-After": String(budget.retryAfterSeconds) },
      },
    );
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const parsed = parseGenerateRequest(body.value);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  try {
    const result = await generatePost(parsed.value, createGeminiProvider());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const mapped = llmErrorToHttp(error);
    return NextResponse.json(mapped.body, {
      status: mapped.status,
      headers: {
        "Cache-Control": "no-store",
        ...(mapped.body.retryAfterSeconds !== undefined
          ? { "Retry-After": String(mapped.body.retryAfterSeconds) }
          : {}),
      },
    });
  }
}
