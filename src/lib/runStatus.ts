import type { RunStatus } from "../types";

export const ACTIVE_RUN_STATUSES: RunStatus[] = ["preparing", "waiting_for_codex", "running"];

const activeRunStatusSet = new Set<RunStatus>(ACTIVE_RUN_STATUSES);
const pendingRunStatusSet = new Set<RunStatus>(["queued", ...ACTIVE_RUN_STATUSES]);
const terminalRunStatusSet = new Set<RunStatus>(["completed", "failed", "cancelled"]);

export function isRunActiveStatus(status: RunStatus | null | undefined): status is RunStatus {
  return Boolean(status && activeRunStatusSet.has(status));
}

export function isRunPendingStatus(status: RunStatus | null | undefined): status is RunStatus {
  return Boolean(status && pendingRunStatusSet.has(status));
}

export function isRunTerminalStatus(status: RunStatus | null | undefined): status is RunStatus {
  return Boolean(status && terminalRunStatusSet.has(status));
}
