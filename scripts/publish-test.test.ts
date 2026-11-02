import { describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: vi.fn() }));

import { shouldCheckSlideReachability } from "./publish-test";

describe("publish-test slide reachability", () => {
  it("skips the check only for a Telegram-only run", () => {
    expect(shouldCheckSlideReachability(["telegram"])).toBe(false);
  });

  it("checks when any selected platform fetches slides from a URL", () => {
    expect(shouldCheckSlideReachability(["linkedin"])).toBe(true);
    expect(shouldCheckSlideReachability(["facebook"])).toBe(true);
    expect(shouldCheckSlideReachability(["instagram"])).toBe(true);
    expect(shouldCheckSlideReachability(["telegram", "linkedin"])).toBe(true);
    expect(shouldCheckSlideReachability([])).toBe(true);
  });
});
