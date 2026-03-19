import type { Batch, BatchMode, BatchStatus, Run } from "../types.js";
import { isTerminalRunStatus } from "./runStatus.js";

const DEFAULT_LOCKED_FOLLOW_UP_MODES = new Set<BatchMode>(["ranked", "validated"]);
const TERMINAL_BATCH_STATUSES = new Set<BatchStatus>(["completed", "failed", "cancelled"]);

export interface FollowUpState {
  allowed: boolean;
  lockedByPolicy: boolean;
  canReopen: boolean;
  reopenDisabledReason: string;
}

export function isFollowUpDefaultLockedMode(mode: BatchMode): boolean {
  return DEFAULT_LOCKED_FOLLOW_UP_MODES.has(mode);
}

export function isBatchTerminalStatus(status: BatchStatus | null | undefined): status is BatchStatus {
  return Boolean(status && TERMINAL_BATCH_STATUSES.has(status));
}

export function canRunAcceptFollowUps(batch: Pick<Batch, "mode">, run: Pick<Run, "followUpsReopened">): boolean {
  return !isFollowUpDefaultLockedMode(batch.mode) || run.followUpsReopened;
}

export function getReopenFollowUpsDisabledReason(
  batch: Pick<Batch, "mode" | "status" | "cancelRequested">,
  run: Pick<Run, "status" | "threadId" | "workingDirectory" | "followUpsReopened">,
): string {
  if (!isFollowUpDefaultLockedMode(batch.mode)) {
    return "This workflow already accepts follow-up turns by default.";
  }

  if (run.followUpsReopened) {
    return "Follow-up turns are already enabled for this run.";
  }

  if (batch.cancelRequested || batch.status === "cancelled") {
    return "Cancelled batches cannot reopen follow-up turns.";
  }

  if (!isBatchTerminalStatus(batch.status)) {
    return "Follow-up turns can be reopened only after the batch has finished.";
  }

  if (!isTerminalRunStatus(run.status)) {
    return "Follow-up turns can be reopened only after this run has finished.";
  }

  if (!run.threadId) {
    return "This run does not have a resumable Codex thread yet.";
  }

  if (!run.workingDirectory) {
    return "This run does not have a working directory yet.";
  }

  return "";
}

export function getFollowUpState(
  batch: Pick<Batch, "mode" | "status" | "cancelRequested">,
  run: Pick<Run, "status" | "threadId" | "workingDirectory" | "followUpsReopened">,
): FollowUpState {
  const allowed = canRunAcceptFollowUps(batch, run);
  const reopenDisabledReason = allowed ? "" : getReopenFollowUpsDisabledReason(batch, run);

  return {
    allowed,
    lockedByPolicy: !allowed,
    canReopen: !allowed && !reopenDisabledReason,
    reopenDisabledReason,
  };
}

export function hasManualFollowUpOverrides(batch: Pick<Batch, "mode" | "runs">): boolean {
  return isFollowUpDefaultLockedMode(batch.mode) && batch.runs.some((run) => run.followUpsReopened);
}
