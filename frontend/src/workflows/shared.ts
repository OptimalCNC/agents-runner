import type { Run } from "../types.js";

export function normalizeScore(value: unknown): number | null {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(100, parsed));
}

export function formatRunStatusLabel(status: Run["status"]): string {
  switch (status) {
    case "queued": return "Queued";
    case "preparing": return "Preparing";
    case "waiting_for_codex": return "Waiting";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}
