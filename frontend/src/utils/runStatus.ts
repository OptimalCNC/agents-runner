import type { RunStatus } from "../types.js";

const activeRunStatuses = new Set<RunStatus>(["preparing", "waiting_for_codex", "running"]);
const pendingRunStatuses = new Set<RunStatus>(["queued", "preparing", "waiting_for_codex", "running"]);

const statusLabels: Record<string, string> = {
  queued: "Queued",
  preparing: "Preparing",
  waiting_for_codex: "Waiting for Codex",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  pending: "Pending",
};

export function isActiveRunStatus(status: string | null | undefined): status is RunStatus {
  return Boolean(status && activeRunStatuses.has(status as RunStatus));
}

export function isPendingRunStatus(status: string | null | undefined): status is RunStatus {
  return Boolean(status && pendingRunStatuses.has(status as RunStatus));
}

export function formatStatusLabel(status: string | null | undefined): string {
  return statusLabels[status ?? ""] || (status ?? "").replace(/[_-]/g, " ");
}

export function getRunStatusDescription(status: RunStatus | null | undefined): string {
  switch (status) {
    case "queued":
      return "Waiting for an available local concurrency slot.";
    case "preparing":
      return "Preparing the worktree and starting the Codex thread.";
    case "waiting_for_codex":
      return "Local setup is done. Waiting for Codex to begin the turn.";
    case "running":
      return "Codex is actively executing the current turn.";
    case "completed":
      return "The latest turn finished successfully.";
    case "failed":
      return "The latest turn ended with an error.";
    case "cancelled":
      return "The run was cancelled before completion.";
    default:
      return "";
  }
}

export function summarizeRunCounts(counts: {
  queuedRuns?: number;
  preparingRuns?: number;
  waitingForCodexRuns?: number;
  runningRuns?: number;
  completedRuns?: number;
  failedRuns?: number;
  cancelledRuns?: number;
}): string {
  const parts = [
    (counts.queuedRuns ?? 0) > 0 ? `${counts.queuedRuns} in local queue` : "",
    (counts.preparingRuns ?? 0) > 0 ? `${counts.preparingRuns} preparing` : "",
    (counts.waitingForCodexRuns ?? 0) > 0 ? `${counts.waitingForCodexRuns} waiting for Codex` : "",
    (counts.runningRuns ?? 0) > 0 ? `${counts.runningRuns} running` : "",
    (counts.completedRuns ?? 0) > 0 ? `${counts.completedRuns} done` : "",
    (counts.failedRuns ?? 0) > 0 ? `${counts.failedRuns} failed` : "",
    (counts.cancelledRuns ?? 0) > 0 ? `${counts.cancelledRuns} cancelled` : "",
  ].filter(Boolean);

  return parts.join(", ") || "Waiting...";
}
