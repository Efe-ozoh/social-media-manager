import { describe, expect, it } from "vitest";
import { parseJsonObject, stripJsonFence } from "./json";
import { LlmError } from "./types";

describe("stripJsonFence", () => {
  it("removes a json fence", () => {
    expect(stripJsonFence('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
  });

  it("leaves unwrapped text alone", () => {
    expect(stripJsonFence('{"ok":true}')).toBe('{"ok":true}');
  });
});

describe("parseJsonObject", () => {
  it("parses a plain object", () => {
    expect(parseJsonObject('{"ok":true}')).toEqual({ ok: true });
  });

  it("parses a fenced object", () => {
    expect(parseJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it("recovers an object surrounded by prose", () => {
    expect(parseJsonObject('Here you go: {"ok":true} Enjoy.')).toEqual({
      ok: true,
    });
  });

  it("rejects arrays and invalid JSON as malformed output", () => {
    for (const value of ["[]", "not json", ""]) {
      expect(() => parseJsonObject(value)).toThrow(LlmError);
      try {
        parseJsonObject(value);
      } catch (error) {
        expect(error).toMatchObject({ code: "malformed_output" });
      }
    }
  });
});
