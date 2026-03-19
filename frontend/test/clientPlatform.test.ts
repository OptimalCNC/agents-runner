import { expect, test } from "bun:test";

import { detectClientPlatform } from "../src/utils/clientPlatform.js";

test("detectClientPlatform prefers userAgentData when present", () => {
  expect(detectClientPlatform({
    userAgentData: {
      platform: "Windows",
    },
    platform: "MacIntel",
  })).toBe("windows");
});

test("detectClientPlatform recognizes navigator.platform fallbacks", () => {
  expect(detectClientPlatform({ platform: "MacIntel" })).toBe("macos");
  expect(detectClientPlatform({ platform: "Linux x86_64" })).toBe("linux");
});

test("detectClientPlatform falls back to userAgent and returns unknown for missing data", () => {
  expect(detectClientPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe("windows");
  expect(detectClientPlatform({})).toBe("unknown");
});
