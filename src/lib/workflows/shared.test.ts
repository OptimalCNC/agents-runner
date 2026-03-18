import { expect, test } from "bun:test";

import { buildMockReviewerRunWithScore, buildMockReviewerRunWithoutScore } from "./test-helpers";
import { extractReviewerScoreFromMcp, normalizeMode, normalizeNumericScore } from "./shared";

// --- normalizeMode ---

test("normalizeMode returns canonical mode strings", () => {
  expect(normalizeMode("repeated")).toBe("repeated");
  expect(normalizeMode("generated")).toBe("generated");
  expect(normalizeMode("ranked")).toBe("ranked");
});

test("normalizeMode handles legacy aliases", () => {
  expect(normalizeMode("task-generator")).toBe("generated");
  expect(normalizeMode("reviewed")).toBe("ranked");
});

test("normalizeMode defaults to repeated for unknown values", () => {
  expect(normalizeMode(undefined)).toBe("repeated");
  expect(normalizeMode(null)).toBe("repeated");
  expect(normalizeMode("unknown")).toBe("repeated");
  expect(normalizeMode("")).toBe("repeated");
});

// --- normalizeNumericScore ---

test("normalizeNumericScore returns the value for valid numbers in range", () => {
  expect(normalizeNumericScore(50)).toBe(50);
  expect(normalizeNumericScore(0)).toBe(0);
  expect(normalizeNumericScore(100)).toBe(100);
});

test("normalizeNumericScore clamps to 0-100 range", () => {
  expect(normalizeNumericScore(-10)).toBe(0);
  expect(normalizeNumericScore(200)).toBe(100);
});

test("normalizeNumericScore parses numeric strings", () => {
  expect(normalizeNumericScore("75")).toBe(75);
  expect(normalizeNumericScore("0")).toBe(0);
});

test("normalizeNumericScore returns null for non-numeric strings", () => {
  expect(normalizeNumericScore("abc")).toBeNull();
  expect(normalizeNumericScore(Number.NaN)).toBeNull();
});

test("normalizeNumericScore treats null/undefined as 0 (empty string -> 0)", () => {
  // null ?? "" → "" → Number("") = 0 → clamped to 0
  expect(normalizeNumericScore(null)).toBe(0);
  expect(normalizeNumericScore(undefined)).toBe(0);
});

// --- extractReviewerScoreFromMcp ---

test("extractReviewerScoreFromMcp extracts score from completed submit_score call", () => {
  const reviewRun = buildMockReviewerRunWithScore(85);
  expect(extractReviewerScoreFromMcp(reviewRun)).toBe(85);
});

test("extractReviewerScoreFromMcp returns null when no score was submitted", () => {
  const reviewRun = buildMockReviewerRunWithoutScore();
  expect(extractReviewerScoreFromMcp(reviewRun)).toBeNull();
});

test("extractReviewerScoreFromMcp returns null for runs with no turns", () => {
  const reviewRun = buildMockReviewerRunWithoutScore();
  reviewRun.turns = [];
  expect(extractReviewerScoreFromMcp(reviewRun)).toBeNull();
});
