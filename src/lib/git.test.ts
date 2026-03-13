import { expect, test } from "bun:test";

import { buildWorktreeBaseName } from "./git";

test("buildWorktreeBaseName uses project, branch, batch id, and 1-based run index", () => {
  const name = buildWorktreeBaseName({
    projectPath: "/tmp/My Project",
    branchName: "main",
    headSha: "abcdef1234567890",
    batchId: "batch-123",
    runIndex: 0,
  });

  expect(name).toBe("my-project-main-batch-123-1");
});

test("buildWorktreeBaseName sanitizes branch names containing slashes", () => {
  const name = buildWorktreeBaseName({
    projectPath: "/tmp/repo",
    branchName: "feature/api/v2",
    headSha: "abcdef1234567890",
    batchId: "batch-123",
    runIndex: 3,
  });

  expect(name).toBe("repo-feature-api-v2-batch-123-4");
});

test("buildWorktreeBaseName falls back to detached-short-sha when branch is unavailable", () => {
  const name = buildWorktreeBaseName({
    projectPath: "/tmp/repo",
    branchName: "",
    headSha: "A1B2C3D4E5F6",
    batchId: "batch-123",
    runIndex: 1,
  });

  expect(name).toBe("repo-detached-a1b2c3d-batch-123-2");
});

test("buildWorktreeBaseName keeps run index unpadded while still 1-based", () => {
  const name = buildWorktreeBaseName({
    projectPath: "/tmp/repo",
    branchName: "main",
    headSha: "abcdef1234567890",
    batchId: "batch-123",
    runIndex: 9,
  });

  expect(name).toBe("repo-main-batch-123-10");
});
