import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { buildWorktreeBaseName, inspectBranchDeleteCandidate, removeBranch } from "./git";
import { runCommand } from "./process";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createTempRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join("/tmp", "agents-runner-workflow-test-"));
  tempDirectories.push(repoRoot);

  await runCommand("git", ["init", "-b", "main", repoRoot]);
  await runCommand("git", ["-C", repoRoot, "config", "user.name", "Agents Runner Tests"]);
  await runCommand("git", ["-C", repoRoot, "config", "user.email", "agents-runner-tests@example.com"]);

  await fs.writeFile(path.join(repoRoot, "README.md"), "initial\n");
  await runCommand("git", ["-C", repoRoot, "add", "README.md"]);
  await runCommand("git", ["-C", repoRoot, "commit", "-m", "initial commit"]);

  return repoRoot;
}

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

test("inspectBranchDeleteCandidate marks branches with no extra commits as safe", async () => {
  const repoRoot = await createTempRepo();

  await runCommand("git", ["-C", repoRoot, "switch", "-c", "batch/run-1"]);
  await runCommand("git", ["-C", repoRoot, "switch", "main"]);

  const preview = await inspectBranchDeleteCandidate({
    repoRoot,
    runId: "run-1",
    runIndex: 0,
    runTitle: "Run 1",
    branchName: "batch/run-1",
    comparisonRef: "main",
  });

  expect(preview.exists).toBe(true);
  expect(preview.safeToDelete).toBe(true);
  expect(preview.deleteByDefault).toBe(true);
  expect(preview.requiresForce).toBe(false);
  expect(preview.aheadCount).toBe(0);
});

test("inspectBranchDeleteCandidate leaves ahead branches unchecked by default", async () => {
  const repoRoot = await createTempRepo();

  await runCommand("git", ["-C", repoRoot, "switch", "-c", "batch/run-2"]);
  await fs.writeFile(path.join(repoRoot, "feature.txt"), "extra work\n");
  await runCommand("git", ["-C", repoRoot, "add", "feature.txt"]);
  await runCommand("git", ["-C", repoRoot, "commit", "-m", "extra commit"]);
  await runCommand("git", ["-C", repoRoot, "switch", "main"]);

  const preview = await inspectBranchDeleteCandidate({
    repoRoot,
    runId: "run-2",
    runIndex: 1,
    runTitle: "Run 2",
    branchName: "batch/run-2",
    comparisonRef: "main",
  });

  expect(preview.exists).toBe(true);
  expect(preview.safeToDelete).toBe(false);
  expect(preview.deleteByDefault).toBe(false);
  expect(preview.requiresForce).toBe(true);
  expect(preview.aheadCount).toBe(1);
});

test("removeBranch force deletes branches with extra commits when explicitly selected", async () => {
  const repoRoot = await createTempRepo();

  await runCommand("git", ["-C", repoRoot, "switch", "-c", "batch/run-3"]);
  await fs.writeFile(path.join(repoRoot, "feature.txt"), "extra work\n");
  await runCommand("git", ["-C", repoRoot, "add", "feature.txt"]);
  await runCommand("git", ["-C", repoRoot, "commit", "-m", "extra commit"]);
  await runCommand("git", ["-C", repoRoot, "switch", "main"]);

  const result = await removeBranch(repoRoot, "batch/run-3", { force: true });
  const verify = await runCommand(
    "git",
    ["-C", repoRoot, "show-ref", "--verify", "--quiet", "refs/heads/batch/run-3"],
    { allowFailure: true },
  );

  expect(result.removed).toBe(true);
  expect(result.forced).toBe(true);
  expect(verify.code).toBe(1);
});
