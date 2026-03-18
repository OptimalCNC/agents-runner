import { useAppStore } from "../state/store.js";
import { RunCard } from "../components/RunCard.js";
import { normalizeScore, formatRunStatusLabel } from "./shared.js";
import type { Run } from "../types.js";
import type { WorkflowUI, FormFieldsProps, RunsGridProps, RunCardExtras } from "./types.js";

interface ReviewerGlance {
  run: Run;
  score: number | null;
  reason: string;
}

function parseReviewerGlance(run: Run): ReviewerGlance {
  const fallbackScore = typeof run.score === "number" ? run.score : null;

  for (let turnIndex = run.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = run.turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex] as Record<string, unknown>;
      if (item.type !== "mcp_tool_call") continue;
      if (String(item.server ?? "") !== "agents-runner-workflow" || String(item.tool ?? "") !== "submit_score") continue;
      const result = item.result as Record<string, unknown> | undefined;
      const structured = (result?.structuredContent || result?.structured_content || result) as Record<string, unknown> | undefined;
      const score = normalizeScore(structured?.score) ?? fallbackScore;
      const reason = String(structured?.reason ?? "").trim();
      return { run, score, reason };
    }
  }

  if (!run.finalResponse) return { run, score: fallbackScore, reason: "" };
  return { run, score: fallbackScore, reason: run.finalResponse.trim() };
}

function buildReviewerGlanceMeta(entry: ReviewerGlance): string {
  const statusLabel = formatRunStatusLabel(entry.run.status);
  return entry.score === null ? statusLabel : `${statusLabel} · Score ${entry.score}`;
}

function buildReviewerGlanceReason(entry: ReviewerGlance): string {
  if (entry.reason) return entry.reason;
  if (entry.run.error) return entry.run.error;
  switch (entry.run.status) {
    case "queued": return "Starts after the candidate run is ready.";
    case "preparing": return "Preparing the reviewer workspace.";
    case "waiting_for_codex": return "Waiting for Codex to start.";
    case "running": return "Reviewer is still evaluating this run.";
    case "completed": return "Open the reviewer run for details.";
    case "failed": return "Reviewer run failed before submitting a score.";
    case "cancelled": return "Reviewer run was cancelled.";
    default: return "Open the reviewer run for details.";
  }
}

function RankedIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function FormFields({ prompt, setPrompt, reviewPrompt, setReviewPrompt, reviewCount, setReviewCount }: FormFieldsProps) {
  return (
    <>
      <div className="form-section">
        <label className="form-label" htmlFor="prompt">Task Prompt</label>
        <textarea
          id="prompt"
          name="prompt"
          rows={8}
          value={prompt}
          placeholder="Describe the coding task each candidate agent should execute."
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>
      <div className="form-grid-2">
        <div className="form-section">
          <label className="form-label" htmlFor="reviewCount">Review Runs</label>
          <input
            id="reviewCount"
            name="reviewCount"
            min="1"
            max="50"
            type="number"
            value={reviewCount}
            required
            onChange={(e) => setReviewCount(e.target.value)}
          />
        </div>
      </div>
      <div className="form-section">
        <label className="form-label" htmlFor="reviewPrompt">Review Prompt</label>
        <textarea
          id="reviewPrompt"
          name="reviewPrompt"
          rows={6}
          value={reviewPrompt}
          placeholder="Tell reviewer agents how to score candidate runs."
          onChange={(e) => setReviewPrompt(e.target.value)}
        />
        <span className="form-hint">XML branch metadata is added automatically.</span>
      </div>
    </>
  );
}

function RunsGrid({ batch, selectedRunId }: RunsGridProps) {
  const candidateRuns = batch.runs
    .filter((run) => run.kind !== "reviewer")
    .sort((left, right) => {
      if (left.rank && right.rank) return left.rank - right.rank;
      if (left.rank) return -1;
      if (right.rank) return 1;
      return Number(right.score ?? -1) - Number(left.score ?? -1);
    });

  const reviewerByCandidate = new Map<string, ReviewerGlance[]>();
  for (const reviewRun of batch.runs.filter((run) => run.kind === "reviewer")) {
    const targetRunId = String(reviewRun.reviewedRunId ?? "").trim();
    if (!targetRunId) continue;
    if (!reviewerByCandidate.has(targetRunId)) reviewerByCandidate.set(targetRunId, []);
    reviewerByCandidate.get(targetRunId)!.push(parseReviewerGlance(reviewRun));
  }

  return (
    <div className="ranked-candidate-grid">
      {candidateRuns.map((candidateRun) => {
        const glanceEntries = (reviewerByCandidate.get(candidateRun.id) || [])
          .sort((left, right) => left.run.index - right.run.index);
        const scoredCount = glanceEntries.filter((entry) => entry.score !== null).length;
        const expectedReviewCount = Math.max(batch.config.reviewCount, glanceEntries.length);
        const scoreLabel = candidateRun.score == null ? "" : `Avg ${candidateRun.score}`;
        const rankLabel = candidateRun.rank ? `#${candidateRun.rank}` : "";
        const extras: RunCardExtras | null = (scoreLabel || rankLabel) ? { tags: [], scoreLabel, rankLabel } : null;

        return (
          <div key={candidateRun.id} className="ranked-candidate-item">
            <RunCard run={candidateRun} extras={extras} />
            <div className="ranked-review-glance">
              <div className="ranked-review-glance-header">
                <span className="ranked-review-glance-title">Reviewer glance</span>
                <span className="ranked-review-glance-count">{scoredCount}/{expectedReviewCount} scored</span>
              </div>
              {glanceEntries.length === 0 ? (
                <div className="ranked-review-empty">Reviewer runs will appear once the candidate run is ready.</div>
              ) : (
                <div className="ranked-review-glance-list">
                  {glanceEntries.map((entry, index) => (
                    <button
                      key={entry.run.id}
                      className={`ranked-review-glance-item${selectedRunId === entry.run.id ? " is-selected" : ""}`}
                      type="button"
                      onClick={() => useAppStore.getState().selectRun(entry.run.id)}
                    >
                      <span className="ranked-review-glance-item-top">
                        <span className="ranked-review-glance-item-label">Review {index + 1}</span>
                        <span className="ranked-review-glance-item-meta">{buildReviewerGlanceMeta(entry)}</span>
                      </span>
                      <span className="ranked-review-glance-item-reason">
                        {buildReviewerGlanceReason(entry)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const rankedWorkflow: WorkflowUI = {
  mode: "ranked",
  label: "Ranked",
  Icon: RankedIcon,
  getMaxConcurrency(runCount, reviewCount) { return runCount * reviewCount; },
  getConcurrencyHint(limit) { return `Max ${limit} shared across candidate and reviewer runs.`; },
  canSubmit({ prompt, reviewPrompt }) { return prompt.trim().length > 0 && reviewPrompt.trim().length > 0; },
  FormFields,
  buildRunsSummaryLabel(batch) {
    const candidateCount = batch.runs.filter((run) => run.kind !== "reviewer").length;
    const reviewerCount = batch.runs.filter((run) => run.kind === "reviewer").length;
    return `${candidateCount} candidates · ${reviewerCount} reviews`;
  },
  RunsGrid,
  TasksSection: null,
  isSessionReadOnly: true,
  showReviewTab(run) { return run.kind !== "reviewer"; },
  getRunCardExtras(run) {
    const scoreLabel = run.score == null
      ? ""
      : run.kind === "reviewer"
        ? `Score ${run.score}`
        : `Avg ${run.score}`;
    const rankLabel = run.rank ? `#${run.rank}` : "";
    const tags = run.kind === "reviewer" ? [{ label: "Reviewer" }] : [];
    if (!tags.length && !scoreLabel && !rankLabel) return null;
    return { tags, scoreLabel, rankLabel };
  },
};
