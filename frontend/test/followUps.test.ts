import { expect, test } from "bun:test";

import type { Batch, Run } from "../src/types.js";
import {
  canRunAcceptFollowUps,
  getFollowUpState,
  hasManualFollowUpOverrides,
  isFollowUpDefaultLockedMode,
} from "../src/utils/followUps.js";

function buildRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? "run-1",
    index: overrides.index ?? 0,
    title: overrides.title ?? "Run 1",
    prompt: overrides.prompt ?? "Do work.",
    status: overrides.status ?? "completed",
    startedAt: overrides.startedAt ?? "2026-01-01T00:00:01.000Z",
    completedAt: overrides.completedAt ?? "2026-01-01T00:00:05.000Z",
    threadId: overrides.threadId ?? "thread-1",
    worktreePath: overrides.worktreePath ?? "/repo/worktrees/run-1",
    workingDirectory: overrides.workingDirectory ?? "/repo/worktrees/run-1/project",
    baseRef: overrides.baseRef ?? "main",
    finalResponse: overrides.finalResponse ?? "",
    error: overrides.error ?? null,
    usage: overrides.usage ?? null,
    logs: overrides.logs ?? [],
    turns: overrides.turns ?? [],
    items: overrides.items ?? [],
    review: overrides.review ?? null,
    followUpsReopened: overrides.followUpsReopened ?? false,
    followUpsReopenedAt: overrides.followUpsReopenedAt ?? null,
    kind: overrides.kind ?? "candidate",
    score: overrides.score ?? null,
    rank: overrides.rank ?? null,
    reviewedRunId: overrides.reviewedRunId ?? null,
  };
}

function buildBatch(mode: Batch["mode"], runs: Run[], status: Batch["status"] = "completed"): Batch {
  return {
    id: "batch-1",
    mode,
    title: "Batch",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: status === "completed" ? "2026-01-01T00:00:10.000Z" : null,
    cancelRequested: false,
    error: null,
    config: {
      runCount: 1,
      concurrency: 1,
      reviewCount: 1,
      projectPath: "/repo/project",
      worktreeRoot: "/repo",
      prompt: "Do work.",
      taskPrompt: "",
      reviewPrompt: "Review it.",
      baseRef: "main",
      model: "",
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      reasoningEffort: "",
    },
    generation: null,
    projectContext: undefined,
    runs,
  };
}

test("follow-up policy keeps repeated mode open by default", () => {
  const batch = buildBatch("repeated", [buildRun()]);

  expect(isFollowUpDefaultLockedMode(batch.mode)).toBe(false);
  expect(canRunAcceptFollowUps(batch, batch.runs[0])).toBe(true);
  expect(getFollowUpState(batch, batch.runs[0]).lockedByPolicy).toBe(false);
});

test("follow-up policy keeps ranked mode locked until a run is reopened", () => {
  const batch = buildBatch("ranked", [buildRun()]);

  expect(isFollowUpDefaultLockedMode(batch.mode)).toBe(true);
  expect(canRunAcceptFollowUps(batch, batch.runs[0])).toBe(false);
  expect(getFollowUpState(batch, batch.runs[0])).toEqual({
    allowed: false,
    lockedByPolicy: true,
    canReopen: true,
    reopenDisabledReason: "",
  });
});

test("follow-up policy reports why reopen is blocked before the batch finishes", () => {
  const batch = buildBatch("validated", [buildRun()], "running");

  expect(getFollowUpState(batch, batch.runs[0]).reopenDisabledReason).toBe(
    "Follow-up turns can be reopened only after the batch has finished.",
  );
});

test("manual overrides are surfaced only for locked workflows", () => {
  const reopenedRanked = buildBatch("ranked", [buildRun({ followUpsReopened: true })]);
  const reopenedRepeated = buildBatch("repeated", [buildRun({ followUpsReopened: true })]);

  expect(hasManualFollowUpOverrides(reopenedRanked)).toBe(true);
  expect(hasManualFollowUpOverrides(reopenedRepeated)).toBe(false);
});
