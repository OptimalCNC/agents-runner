import { isRunTerminalStatus } from "./runStatus";

import type { Batch, BatchMode, BatchStatus, Run } from "../types";

const DEFAULT_LOCKED_FOLLOW_UP_MODES = new Set<BatchMode>(["ranked", "validated"]);
const TERMINAL_BATCH_STATUSES = new Set<BatchStatus>(["completed", "failed", "cancelled"]);

export function isFollowUpDefaultLockedMode(mode: BatchMode): boolean {
  return DEFAULT_LOCKED_FOLLOW_UP_MODES.has(mode);
}

export function isBatchTerminalStatus(status: BatchStatus | null | undefined): status is BatchStatus {
  return Boolean(status && TERMINAL_BATCH_STATUSES.has(status));
}

export function canRunAcceptFollowUps(
  batch: Pick<Batch, "mode">,
  run: Pick<Run, "followUpsReopened">,
): boolean {
  return !isFollowUpDefaultLockedMode(batch.mode) || run.followUpsReopened;
}

export function getContinueRunBlockedReason(
  batch: Pick<Batch, "mode">,
  run: Pick<Run, "followUpsReopened">,
): string {
  if (canRunAcceptFollowUps(batch, run)) {
    return "";
  }

  return "Follow-up turns are locked for this run until you enable them manually from the session view.";
}

export function getReopenFollowUpsError(
  batch: Pick<Batch, "mode" | "status" | "cancelRequested">,
  run: Pick<Run, "status" | "threadId" | "workingDirectory" | "followUpsReopened">,
): string {
  if (!isFollowUpDefaultLockedMode(batch.mode)) {
    return "This run already accepts follow-up turns without reopening.";
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

  if (!isRunTerminalStatus(run.status)) {
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

export function canReopenRunFollowUps(
  batch: Pick<Batch, "mode" | "status" | "cancelRequested">,
  run: Pick<Run, "status" | "threadId" | "workingDirectory" | "followUpsReopened">,
): boolean {
  return getReopenFollowUpsError(batch, run) === "";
}
