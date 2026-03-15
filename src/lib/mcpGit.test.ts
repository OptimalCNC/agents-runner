import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import {
  createManagedWorktreeCommit,
  negotiateMcpProtocolVersion,
} from "./mcpGit";
import { runCommand } from "./process";

import type { ManagedWorktreeRecord } from "./mcpGit";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createTempRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join("/tmp", "agents-runner-mcp-git-test-"));
  tempDirectories.push(repoRoot);

  await runCommand("git", ["init", "-b", "main", repoRoot]);
  await runCommand("git", ["-C", repoRoot, "config", "user.name", "Agents Runner Tests"]);
  await runCommand("git", ["-C", repoRoot, "config", "user.email", "agents-runner-tests@example.com"]);

  await fs.writeFile(path.join(repoRoot, "README.md"), "initial\n");
  await runCommand("git", ["-C", repoRoot, "add", "README.md"]);
  await runCommand("git", ["-C", repoRoot, "commit", "-m", "initial commit"]);

  return repoRoot;
}

async function createManagedWorktreeMap(worktreePath: string): Promise<Map<string, ManagedWorktreeRecord>> {
  const normalized = await fs.realpath(worktreePath);
  return new Map([
    [normalized, {
      batchId: "batch-1",
      runId: "run-1",
      runTitle: "Run 1",
      worktreePath: normalized,
      workingDirectory: normalized,
    }],
  ]);
}

test("negotiateMcpProtocolVersion falls back to the latest supported version", () => {
  expect(negotiateMcpProtocolVersion("2025-03-26")).toBe("2025-03-26");
  expect(negotiateMcpProtocolVersion("not-supported")).toBe("2025-06-18");
});

test("createManagedWorktreeCommit stages the selected files and creates one commit", async () => {
  const repoRoot = await createTempRepo();
  await fs.writeFile(path.join(repoRoot, "README.md"), "updated\n");

  const result = await createManagedWorktreeCommit(
    await createManagedWorktreeMap(repoRoot),
    {
      working_folder: repoRoot,
      files: ["README.md"],
      message: "Update readme",
    },
  );

  const headSubject = await runCommand("git", ["-C", repoRoot, "show", "--format=%s", "--no-patch", "HEAD"]);

  expect(result.branch).toBe("main");
  expect(result.message).toBe("Update readme");
  expect(result.stagedFiles).toEqual(["README.md"]);
  expect(headSubject.stdout.trim()).toBe("Update readme");
});

test("createManagedWorktreeCommit rejects worktrees that are not managed by Agents Runner", async () => {
  const repoRoot = await createTempRepo();
  await fs.writeFile(path.join(repoRoot, "README.md"), "updated\n");

  await expect(
    createManagedWorktreeCommit(new Map(), {
      working_folder: repoRoot,
      files: ["README.md"],
      message: "Update readme",
    }),
  ).rejects.toThrow("active run worktrees");
});

test("createManagedWorktreeCommit rejects staged changes outside the selected file set", async () => {
  const repoRoot = await createTempRepo();
  await fs.writeFile(path.join(repoRoot, "README.md"), "updated\n");
  await fs.writeFile(path.join(repoRoot, "extra.txt"), "extra\n");
  await runCommand("git", ["-C", repoRoot, "add", "extra.txt"]);

  await expect(
    createManagedWorktreeCommit(
      await createManagedWorktreeMap(repoRoot),
      {
        working_folder: repoRoot,
        files: ["README.md"],
        message: "Update readme",
      },
    ),
  ).rejects.toThrow("staged changes outside");
});
