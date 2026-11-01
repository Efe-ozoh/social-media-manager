import { describe, expect, it } from "vitest";
import {
  automatedPlatforms,
  connectablePlatforms,
  isMetaEnabled,
  isMetaPlatform,
  manualExportPlatforms,
  platformMode,
  schedulablePlatforms,
} from "./platforms";

/**
 * The platform split is a scope decision, not a detail: Meta posting is off, so
 * these tests pin which platforms exist for each purpose and that the flag is
 * read conservatively.
 */

const OFF = { ENABLE_META: "false" } as const;
const ON = { ENABLE_META: "true" } as const;

describe("platform modes", () => {
  it("automates LinkedIn and Telegram", () => {
    expect(platformMode("linkedin")).toBe("automated");
    expect(platformMode("telegram")).toBe("automated");
  });

  it("treats Facebook and Instagram as manual export", () => {
    expect(platformMode("facebook")).toBe("manual_export");
    expect(platformMode("instagram")).toBe("manual_export");
    expect(isMetaPlatform("facebook")).toBe(true);
    expect(isMetaPlatform("instagram")).toBe(true);
    expect(isMetaPlatform("linkedin")).toBe(false);
  });

  it("lists automated and manual platforms separately", () => {
    expect(automatedPlatforms(OFF)).toEqual(["linkedin", "telegram"]);
    // Manual export is the fallback for the blocked account, so it survives
    // the Meta switch: these are the platforms the owner posts by hand.
    expect(manualExportPlatforms()).toEqual(["instagram", "facebook"]);
  });
});

describe("ENABLE_META", () => {
  it("is off unless explicitly enabled", () => {
    expect(isMetaEnabled({})).toBe(false);
    expect(isMetaEnabled({ ENABLE_META: "" })).toBe(false);
    expect(isMetaEnabled({ ENABLE_META: "false" })).toBe(false);
    expect(isMetaEnabled({ ENABLE_META: "0" })).toBe(false);
    expect(isMetaEnabled({ ENABLE_META: "no" })).toBe(false);
    expect(isMetaEnabled({ ENABLE_META: "maybe" })).toBe(false);
  });

  it("accepts the explicit yes forms", () => {
    expect(isMetaEnabled({ ENABLE_META: "true" })).toBe(true);
    expect(isMetaEnabled({ ENABLE_META: " TRUE " })).toBe(true);
    expect(isMetaEnabled({ ENABLE_META: "1" })).toBe(true);
    expect(isMetaEnabled({ ENABLE_META: "yes" })).toBe(true);
  });

  it("keeps Meta out of every connect list while it is off", () => {
    const connectable = connectablePlatforms(OFF);
    expect(connectable).toEqual(["linkedin"]);
    expect(connectable).not.toContain("facebook");
    expect(connectable).not.toContain("instagram");
  });

  it("offers Meta connections again when the flag is on", () => {
    expect(connectablePlatforms(ON)).toEqual([
      "linkedin",
      "instagram",
      "facebook",
    ]);
  });
});

describe("schedulable platforms", () => {
  it("never schedules a manual-export platform", () => {
    for (const env of [OFF, ON]) {
      const schedulable = schedulablePlatforms(env);
      expect(schedulable).toEqual(["linkedin", "telegram"]);
      expect(schedulable).not.toContain("facebook");
      expect(schedulable).not.toContain("instagram");
    }
  });
});
