import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import {
  normalizeSubmitResultToolArgs,
  submitManagedWorkerResult,
} from "./mcpWorkerResult";

import type { ManagedWorktreeRecord } from "./mcpGit";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createManagedWorktree(): Promise<{
  managedWorktrees: Map<string, ManagedWorktreeRecord>;
  worktreePath: string;
}> {
  const worktreePath = await fs.mkdtemp(path.join("/tmp", "agents-runner-submit-result-"));
  tempDirectories.push(worktreePath);

  const managedWorktrees = new Map<string, ManagedWorktreeRecord>([[
    worktreePath,
    {
      batchId: "batch-1",
      runId: "run-1",
      runTitle: "Worker 1",
      worktreePath,
      workingDirectory: worktreePath,
    },
  ]]);

  return { managedWorktrees, worktreePath };
}

test("normalizeSubmitResultToolArgs requires a working folder and file list", async () => {
  await expect(normalizeSubmitResultToolArgs({})).rejects.toThrow("working_folder is required.");
  await expect(normalizeSubmitResultToolArgs({
    working_folder: "/tmp/example",
    files: [],
  })).rejects.toThrow("files must contain at least one submitted file.");
});

test("submitManagedWorkerResult normalizes file paths and returns explanations", async () => {
  const { managedWorktrees, worktreePath } = await createManagedWorktree();
  await fs.mkdir(path.join(worktreePath, "src"), { recursive: true });
  await fs.writeFile(path.join(worktreePath, "src", "index.ts"), "export const value = 1;\n");

  const result = await submitManagedWorkerResult(managedWorktrees, {
    working_folder: worktreePath,
    files: [
      {
        path: "./src/index.ts",
        explanation: "Primary implementation entry point.",
      },
    ],
  });

  expect(result).toEqual({
    workingFolder: worktreePath,
    runId: "run-1",
    files: [
      {
        path: "src/index.ts",
        explanation: "Primary implementation entry point.",
      },
    ],
  });
});

test("submitManagedWorkerResult rejects files outside the worktree or missing on disk", async () => {
  const { managedWorktrees, worktreePath } = await createManagedWorktree();

  await expect(submitManagedWorkerResult(managedWorktrees, {
    working_folder: worktreePath,
    files: [
      {
        path: "../outside.ts",
        explanation: "Invalid path.",
      },
    ],
  })).rejects.toThrow("must stay inside the requested working folder");

  await expect(submitManagedWorkerResult(managedWorktrees, {
    working_folder: worktreePath,
    files: [
      {
        path: "missing.ts",
        explanation: "Missing file.",
      },
    ],
  })).rejects.toThrow("does not exist as a file");
});
