import type { BatchMode, Run } from "../../types";

export function normalizeMode(value: unknown): BatchMode {
  if (value === "generated" || value === "task-generator") {
    return "generated";
  }

  if (value === "ranked" || value === "reviewed") {
    return "ranked";
  }

  return "repeated";
}

export function normalizeNumericScore(value: unknown): number | null {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.min(100, parsed));
}

export function extractReviewerScoreFromMcp(reviewRun: Run): number | null {
  for (let turnIndex = reviewRun.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = reviewRun.turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex] as Record<string, unknown>;
      if (item.type !== "mcp_tool_call") {
        continue;
      }

      if (String(item.server ?? "") !== "agents-runner-workflow" || String(item.tool ?? "") !== "submit_score") {
        continue;
      }

      if (String(item.status ?? "") !== "completed") {
        continue;
      }

      const result = item.result as Record<string, unknown> | undefined;
      const structured = (result?.structuredContent || result?.structured_content || result) as Record<string, unknown> | undefined;
      const score = normalizeNumericScore(structured?.score);
      if (score !== null) {
        return score;
      }
    }
  }

  return null;
}
