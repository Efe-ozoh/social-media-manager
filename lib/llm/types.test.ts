import { describe, expect, it } from "vitest";
import { LlmError, llmErrorToHttp } from "./types";

describe("llmErrorToHttp", () => {
  it("maps known failures to safe statuses", () => {
    expect(llmErrorToHttp(new LlmError("missing_key")).status).toBe(503);
    expect(llmErrorToHttp(new LlmError("quota")).status).toBe(429);
    expect(llmErrorToHttp(new LlmError("safety")).status).toBe(422);
    expect(llmErrorToHttp(new LlmError("timeout")).status).toBe(504);
    expect(llmErrorToHttp(new LlmError("network")).status).toBe(502);
  });

  it("never exposes an unknown error message", () => {
    const mapped = llmErrorToHttp(new Error("secret raw provider body"));
    expect(mapped.status).toBe(502);
    expect(mapped.body.code).toBe("unknown");
    expect(mapped.body.error).not.toContain("secret");
  });

  it("includes retry guidance only when present", () => {
    const mapped = llmErrorToHttp(
      new LlmError("quota", { retryAfterSeconds: 60 }),
    );
    expect(mapped.body.retryAfterSeconds).toBe(60);
    expect(llmErrorToHttp(new LlmError("timeout")).body).not.toHaveProperty(
      "retryAfterSeconds",
    );
  });
});
