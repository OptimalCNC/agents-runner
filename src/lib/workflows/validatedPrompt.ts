import path from "node:path";

import type { Batch, Run } from "../../types";
import { listWorkerResultSubmissionsFromMcp } from "./shared";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildWorkerSummaryXml(run: Run): string {
  const submissions = listWorkerResultSubmissionsFromMcp(run);
  const latestSubmission = submissions.at(-1) ?? null;
  const submittedFilesXml = submissions.length === 0
    ? [
      '    <submittedFiles status="missing">',
      "      <note>No completed submit_result call was recorded.</note>",
      "    </submittedFiles>",
    ].join("\n")
    : [
      `    <submittedFiles status="${submissions.length === 1 ? "submitted" : "multiple"}">`,
      ...(submissions.length > 1
        ? [`      <note>Expected exactly one completed submit_result call but found ${submissions.length}.</note>`]
        : []),
      ...latestSubmission!.files.flatMap((file) => [
        `      <file path="${escapeXml(path.resolve(latestSubmission!.workingFolder, file.path))}">`,
        `        <explanation>${escapeXml(file.explanation)}</explanation>`,
        "      </file>",
      ]),
      "    </submittedFiles>",
    ].join("\n");

  return [
    `  <worker id="${escapeXml(run.id)}" title="${escapeXml(run.title)}" status="${escapeXml(run.status)}">`,
    `    <workingDirectory>${escapeXml(run.workingDirectory || "(unavailable)")}</workingDirectory>`,
    submittedFilesXml,
    `    <error>${escapeXml(run.error || "(none)")}</error>`,
    `    <finalResponse>${escapeXml(run.finalResponse.trim() || "(none)")}</finalResponse>`,
    "  </worker>",
  ].join("\n");
}

export function buildValidatorPrompt(batch: Batch, workerRuns: Run[]): string {
  const originalTask = batch.config.prompt.trim() || "(task unavailable)";
  const workerSummaries = workerRuns.length > 0
    ? ["<workers>", workerRuns.map((run) => buildWorkerSummaryXml(run)).join("\n"), "</workers>"].join("\n")
    : "<workers />";

  return [
    batch.config.reviewPrompt.trim(),
    "",
    "```xml",
    workerSummaries,
    "```",
    "",
    "Original Tasks:",
    "````markdown",
    originalTask,
    "````",
  ].join("\n");
}

export function collectValidatorDirectories(workerRuns: Run[]): string[] {
  return Array.from(new Set(
    workerRuns
      .map((run) => String(run.worktreePath ?? "").trim())
      .filter(Boolean),
  ));
}
