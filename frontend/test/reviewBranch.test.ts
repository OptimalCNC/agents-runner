import { expect, test } from "bun:test";

import { buildDefaultReviewBranchName } from "../src/utils/reviewBranch.js";

test("buildDefaultReviewBranchName uses batch id and 1-based run index", () => {
  expect(buildDefaultReviewBranchName("abc12", 0)).toBe("batch/abc12/1");
  expect(buildDefaultReviewBranchName("abc12", 4)).toBe("batch/abc12/5");
});

test("buildDefaultReviewBranchName falls back when the batch id is unavailable", () => {
  expect(buildDefaultReviewBranchName("", 1)).toBe("batch/pending/2");
});
