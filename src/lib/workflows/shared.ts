import type { BatchMode, Run, SubmitResultToolFile, SubmitResultToolResult } from "../../types";

export function normalizeMode(value: unknown): BatchMode {
  if (value === "generated" || value === "task-generator") {
    return "generated";
  }

  if (value === "ranked" || value === "reviewed") {
    return "ranked";
  }

  if (value === "validated") {
    return "validated";
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

function extractStructuredMcpResult(item: Record<string, unknown>): Record<string, unknown> | null {
  const result = item.result as Record<string, unknown> | undefined;
  const structured = (result?.structuredContent || result?.structured_content || result) as Record<string, unknown> | undefined;
  return structured && typeof structured === "object" ? structured : null;
}

function listCompletedWorkflowToolResults(run: Run, toolName: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];

  for (const turn of run.turns) {
    for (const rawItem of turn.items) {
      const item = rawItem as Record<string, unknown>;
      if (item.type !== "mcp_tool_call") {
        continue;
      }

      if (String(item.server ?? "") !== "agents-runner-workflow" || String(item.tool ?? "") !== toolName) {
        continue;
      }

      if (String(item.status ?? "") !== "completed") {
        continue;
      }

      const structured = extractStructuredMcpResult(item);
      if (structured) {
        results.push(structured);
      }
    }
  }

  return results;
}

function normalizeSubmittedFiles(value: unknown): SubmitResultToolFile[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const files: SubmitResultToolFile[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }

    const filePath = String((entry as Record<string, unknown>).path ?? "").trim();
    const explanation = String((entry as Record<string, unknown>).explanation ?? "").trim();
    if (!filePath || !explanation) {
      return null;
    }

    files.push({ path: filePath, explanation });
  }

  return files;
}

export function extractReviewerScoreFromMcp(reviewRun: Run): number | null {
  const result = listCompletedWorkflowToolResults(reviewRun, "submit_score").at(-1);
  return result ? normalizeNumericScore(result.score) : null;
}

export function listWorkerResultSubmissionsFromMcp(workerRun: Run): SubmitResultToolResult[] {
  const results = listCompletedWorkflowToolResults(workerRun, "submit_result");
  const submissions: SubmitResultToolResult[] = [];

  for (const result of results) {
    const workingFolder = String(result.workingFolder ?? "").trim();
    const runId = String(result.runId ?? "").trim();
    const files = normalizeSubmittedFiles(result.files);
    if (!workingFolder || !runId || !files || files.length === 0) {
      continue;
    }

    submissions.push({
      workingFolder,
      runId,
      files,
    });
  }

  return submissions;
}

export function extractLatestWorkerResultSubmissionFromMcp(workerRun: Run): SubmitResultToolResult | null {
  return listWorkerResultSubmissionsFromMcp(workerRun).at(-1) ?? null;
}
