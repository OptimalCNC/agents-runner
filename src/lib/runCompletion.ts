import { normalizeNumericScore } from "./workflows/shared";

import type { Run, RunTurn } from "../types";

const TRANSIENT_STREAM_WARNING_PREFIXES = [
  "Reconnecting...",
  "Falling back from WebSockets to HTTPS transport",
] as const;

function isCompletionLogMessage(message: unknown): boolean {
  const text = String(message ?? "");
  return text.startsWith("Turn completed.")
    || text === "Run completed."
    || text === "Follow-up turn completed.";
}

function getLatestTurn(run: Pick<Run, "turns">): RunTurn | null {
  return run.turns.at(-1) ?? null;
}

function getLatestTurnLogBoundary(turn: RunTurn): string {
  return turn.startedAt || turn.submittedAt || "";
}

function hasLatestTurnCompletionLog(
  run: Pick<Run, "turns" | "logs">,
  turn: RunTurn,
): boolean {
  const boundary = getLatestTurnLogBoundary(turn);
  return run.logs.some((entry) => entry.at >= boundary && isCompletionLogMessage(entry.message));
}

function extractLatestTurnReviewerScore(turn: RunTurn): number | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index] as Record<string, unknown>;
    if (item.type !== "mcp_tool_call") {
      continue;
    }

    if (
      String(item.server ?? "") !== "agents-runner-workflow"
      || String(item.tool ?? "") !== "submit_score"
      || String(item.status ?? "") !== "completed"
    ) {
      continue;
    }

    const result = item.result as Record<string, unknown> | undefined;
    const structured = (result?.structuredContent || result?.structured_content || result) as Record<string, unknown> | undefined;
    return normalizeNumericScore(structured?.score);
  }

  return null;
}

export function isTransientStreamWarningMessage(message: unknown): boolean {
  const text = String(message ?? "").trim();
  return TRANSIENT_STREAM_WARNING_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function hasStrongLatestTurnCompletionEvidence(run: Pick<Run, "turns" | "logs">): boolean {
  const latestTurn = getLatestTurn(run);
  if (!latestTurn) {
    return false;
  }

  if (latestTurn.status === "completed") {
    return true;
  }

  if (latestTurn.usage) {
    return true;
  }

  if (extractLatestTurnReviewerScore(latestTurn) !== null) {
    return true;
  }

  return hasLatestTurnCompletionLog(run, latestTurn);
}
