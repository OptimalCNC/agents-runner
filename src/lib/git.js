import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./process.js";

const MAX_UNTRACKED_PREVIEW_BYTES = 20_000;

function sanitizeSegment(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run";
}

function isTextBuffer(buffer) {
  return !buffer.includes(0);
}

function truncateText(value, limit = MAX_UNTRACKED_PREVIEW_BYTES) {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}\n\n...truncated...`;
}

function isCommitLikeRef(value) {
  return /^[0-9a-f]{5,40}$/i.test(String(value).trim());
}

function normalizeRefName(value) {
  const ref = String(value).trim();

  if (ref.startsWith("refs/heads/")) {
    return ref.slice("refs/heads/".length);
  }

  if (ref.startsWith("refs/remotes/")) {
    return ref.slice("refs/remotes/".length);
  }

  if (ref.startsWith("refs/tags/")) {
    return ref.slice("refs/tags/".length);
  }

  return ref;
}

function deriveWorktreeRefSegment({ baseRef, branchName, headSha }) {
  if (baseRef) {
    return isCommitLikeRef(baseRef)
      ? baseRef.slice(0, 5).toLowerCase()
      : sanitizeSegment(normalizeRefName(baseRef));
  }

  if (branchName) {
    return sanitizeSegment(branchName);
  }

  return headSha.slice(0, 5).toLowerCase();
}

function deriveWorktreeProjectSegment(projectPath) {
  return sanitizeSegment(path.basename(projectPath));
}

export async function inspectProject(projectPath) {
  const requestedPath = await fs.realpath(projectPath);
  const repoRoot = (
    await runCommand("git", ["-C", requestedPath, "rev-parse", "--show-toplevel"])
  ).stdout.trim();
  const repoRootPath = await fs.realpath(repoRoot);
  const relativeProjectPath = path.relative(repoRootPath, requestedPath) || ".";
  const headSha = (
    await runCommand("git", ["-C", requestedPath, "rev-parse", "HEAD"])
  ).stdout.trim();
  const branchName = (
    await runCommand("git", ["-C", requestedPath, "branch", "--show-current"], {
      allowFailure: true,
    })
  ).stdout.trim();

  return {
    projectPath: requestedPath,
    repoRoot: repoRootPath,
    relativeProjectPath,
    headSha,
    branchName,
  };
}

export async function ensureDirectory(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
  return fs.realpath(targetPath).catch(() => path.resolve(targetPath));
}

export async function createWorktree({
  repoRoot,
  projectPath,
  worktreeRoot,
  baseRef,
  branchName,
  headSha,
  runIndex,
}) {
  const resolvedRoot = await ensureDirectory(worktreeRoot);
  const projectSegment = deriveWorktreeProjectSegment(projectPath);
  const refSegment = deriveWorktreeRefSegment({ baseRef, branchName, headSha });
  const baseName = `${projectSegment}-${refSegment}-${String(runIndex + 1).padStart(2, "0")}`;

  let attempt = 0;
  let candidate = path.join(resolvedRoot, baseName);

  while (true) {
    try {
      await fs.access(candidate);
      attempt += 1;
      candidate = path.join(resolvedRoot, `${baseName}-${attempt}`);
    } catch {
      break;
    }
  }

  await runCommand("git", ["-C", repoRoot, "worktree", "add", "--detach", candidate, baseRef]);
  return candidate;
}

export async function collectWorktreeReview(worktreePath) {
  const [statusShort, diffStat, trackedDiff, untracked] = await Promise.all([
    runCommand("git", ["-C", worktreePath, "status", "--short"], { allowFailure: true }),
    runCommand("git", ["-C", worktreePath, "diff", "--stat"], { allowFailure: true }),
    runCommand("git", ["-C", worktreePath, "diff", "--no-ext-diff", "--submodule=diff"], {
      allowFailure: true,
    }),
    runCommand("git", ["-C", worktreePath, "ls-files", "--others", "--exclude-standard"], {
      allowFailure: true,
    }),
  ]);

  const untrackedFiles = [];
  const untrackedNames = untracked.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  for (const relativeFile of untrackedNames) {
    const absoluteFile = path.join(worktreePath, relativeFile);

    try {
      const buffer = await fs.readFile(absoluteFile);
      untrackedFiles.push({
        path: relativeFile,
        preview: isTextBuffer(buffer)
          ? truncateText(buffer.toString("utf8"))
          : "Binary file preview unavailable.",
      });
    } catch (error) {
      untrackedFiles.push({
        path: relativeFile,
        preview: `Unable to read file: ${error.message}`,
      });
    }
  }

  return {
    statusShort: statusShort.stdout.trim(),
    diffStat: diffStat.stdout.trim(),
    trackedDiff: trackedDiff.stdout.trim(),
    untrackedFiles,
  };
}

export async function listDirectories(targetPath) {
  const initialPath = targetPath ? path.resolve(targetPath) : os.homedir();
  const resolvedPath = await fs.realpath(initialPath).catch(() => path.resolve(initialPath));
  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(resolvedPath, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const parentPath = path.dirname(resolvedPath);

  return {
    path: resolvedPath,
    parentPath: parentPath === resolvedPath ? null : parentPath,
    directories,
  };
}
