import type { Batch, Run } from "../types.js";
import { isPendingRunStatus } from "./runStatus.js";

function canStopFailedRun(batch: Batch, run: Run): boolean {
  if (run.status !== "failed") {
    return false;
  }

  return (batch.mode === "ranked" || batch.mode === "validated") && batch.status === "blocked";
}

export function canStopRun(batch: Batch, run: Run): boolean {
  if (batch.cancelRequested) {
    return false;
  }

  return run.status === "queued" || isPendingRunStatus(run.status) || canStopFailedRun(batch, run);
}

export function canRerunRun(batch: Batch, run: Run): boolean {
  if (batch.cancelRequested) {
    return false;
  }

  return isPendingRunStatus(run.status) || run.status === "failed" || run.status === "cancelled";
}

export function canResumeRun(batch: Batch, run: Run): boolean {
  if (batch.cancelRequested) {
    return false;
  }

  return run.status === "failed" && Boolean(run.threadId && run.workingDirectory);
}
