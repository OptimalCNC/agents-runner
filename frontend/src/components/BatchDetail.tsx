import { useAppStore, selectSelectedBatch } from "../state/store.js";
import { apiCancelBatch } from "../state/api.js";
import { StatusPill } from "./StatusPill.js";
import { RunCard } from "./RunCard.js";
import { RunDetail } from "./RunDetail.js";
import { ClockIcon, FolderIcon, GitIcon, XIcon, PlayIcon } from "../icons.js";
import { formatDate, formatRelative, formatModeLabel } from "../utils/format.js";
import { summarizeRunCounts } from "../utils/runStatus.js";
import type { Run } from "../types.js";

interface ReviewerGlance {
  run: Run;
  score: number | null;
  reason: string;
}

function normalizeScore(value: unknown): number | null {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.min(100, parsed));
}

function parseReviewerGlance(run: Run): ReviewerGlance {
  const fallbackScore = typeof run.score === "number" ? run.score : null;

  for (let turnIndex = run.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = run.turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex] as Record<string, unknown>;
      if (item.type !== "mcp_tool_call") {
        continue;
      }

      if (String(item.server ?? "") !== "agents-runner-workflow" || String(item.tool ?? "") !== "submit_score") {
        continue;
      }

      const result = item.result as Record<string, unknown> | undefined;
      const structured = (result?.structuredContent || result?.structured_content || result) as Record<string, unknown> | undefined;
      const score = normalizeScore(structured?.score) ?? fallbackScore;
      const reason = String(structured?.reason ?? "").trim();
      return { run, score, reason };
    }
  }

  if (!run.finalResponse) {
    return { run, score: fallbackScore, reason: "" };
  }

  return { run, score: fallbackScore, reason: run.finalResponse.trim() };
}

function formatRunStatusLabel(status: Run["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "preparing":
      return "Preparing";
    case "waiting_for_codex":
      return "Waiting";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function buildReviewerGlanceMeta(entry: ReviewerGlance): string {
  const statusLabel = formatRunStatusLabel(entry.run.status);
  return entry.score === null ? statusLabel : `${statusLabel} · Score ${entry.score}`;
}

function buildReviewerGlanceReason(entry: ReviewerGlance): string {
  if (entry.reason) {
    return entry.reason;
  }

  if (entry.run.error) {
    return entry.run.error;
  }

  switch (entry.run.status) {
    case "queued":
      return "Starts after the candidate run is ready.";
    case "preparing":
      return "Preparing the reviewer workspace.";
    case "waiting_for_codex":
      return "Waiting for Codex to start.";
    case "running":
      return "Reviewer is still evaluating this run.";
    case "completed":
      return "Open the reviewer run for details.";
    case "failed":
      return "Reviewer run failed before submitting a score.";
    case "cancelled":
      return "Reviewer run was cancelled.";
    default:
      return "Open the reviewer run for details.";
  }
}

function buildRunsSummaryLabel(batch: { mode: string; runs: Run[]; config: { runCount: number } }): string {
  if (batch.mode !== "ranked") {
    return `${batch.runs.length} / ${batch.config.runCount}`;
  }

  const candidateCount = batch.runs.filter((run) => run.kind !== "reviewer").length;
  const reviewerCount = batch.runs.filter((run) => run.kind === "reviewer").length;
  return `${candidateCount} candidates · ${reviewerCount} reviews`;
}

export function BatchDetail() {
  const batch = useAppStore(selectSelectedBatch);
  const selectedRunId = useAppStore((s) => s.selectedRunId);

  if (!batch) {
    return (
      <div className="empty-state main-empty">
        <div className="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        </div>
        <p className="empty-title">No batch selected</p>
        <p className="empty-desc">Launch a batch or select one from the sidebar to inspect run output.</p>
      </div>
    );
  }

  const selectedRun = batch.runs.find((r) => r.id === selectedRunId) ?? null;
  const canCancel = batch.status === "running" || batch.status === "queued";
  const baseRef = batch.config.baseRef || batch.projectContext?.branchName || batch.projectContext?.headSha || "Current HEAD";

  const completedRuns = batch.runs.filter((r) => r.status === "completed").length;
  const failedRuns = batch.runs.filter((r) => r.status === "failed").length;
  const cancelledRuns = batch.runs.filter((r) => r.status === "cancelled").length;
  const preparingRuns = batch.runs.filter((r) => r.status === "preparing").length;
  const waitingForCodexRuns = batch.runs.filter((r) => r.status === "waiting_for_codex").length;
  const runningRuns = batch.runs.filter((r) => r.status === "running").length;
  const queuedRuns = batch.runs.filter((r) => r.status === "queued").length;

  const candidateRuns = batch.runs
    .filter((run) => run.kind !== "reviewer")
    .sort((left, right) => {
      if (left.rank && right.rank) {
        return left.rank - right.rank;
      }

      if (left.rank) {
        return -1;
      }

      if (right.rank) {
        return 1;
      }

      return Number(right.score ?? -1) - Number(left.score ?? -1);
    });

  const reviewerByCandidate = new Map<string, ReviewerGlance[]>();
  for (const reviewRun of batch.runs.filter((run) => run.kind === "reviewer")) {
    const targetRunId = String(reviewRun.reviewedRunId ?? "").trim();
    if (!targetRunId) {
      continue;
    }

    if (!reviewerByCandidate.has(targetRunId)) {
      reviewerByCandidate.set(targetRunId, []);
    }

    reviewerByCandidate.get(targetRunId)!.push(parseReviewerGlance(reviewRun));
  }

  async function handleCancel() {
    try {
      await apiCancelBatch(batch!.id);
      useAppStore.getState().addToast("info", "Cancel requested", "The batch will stop after current runs finish.");
    } catch (err) {
      useAppStore.getState().addToast("error", "Cancel failed", (err as Error).message);
    }
  }

  return (
    <div className="batch-detail">
      <div className="batch-detail-header">
        <div className="batch-detail-title-area">
          <h2>{batch.title}</h2>
          <div className="batch-detail-meta">
            <span className="meta-item"><ClockIcon /> Created {formatRelative(batch.createdAt)}</span>
            <span
              className="meta-item meta-item-project-base"
              title={`${batch.config.projectPath} · Base ref ${baseRef}`}
            >
              <FolderIcon />
              <span className="batch-detail-path">{batch.config.projectPath}</span>
              <span className="meta-item-separator">·</span>
              <GitIcon />
              <span className="mono">{baseRef}</span>
            </span>
          </div>
        </div>
        <div className="batch-detail-actions">
          <StatusPill status={batch.status} />
          {canCancel && (
            <button className="btn btn-danger btn-sm" type="button" onClick={handleCancel}>
              <XIcon /> Cancel
            </button>
          )}
        </div>
      </div>

      <div className="batch-detail-summary">
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Mode</span>
          <span className="meta-item-value">{formatModeLabel(batch.mode)}</span>
        </span>
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Runs</span>
          <span className="meta-item-value">{buildRunsSummaryLabel(batch)}</span>
        </span>
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Concurrency</span>
          <span className="meta-item-value">{batch.config.concurrency}</span>
        </span>
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Started</span>
          <span className="meta-item-value">{formatDate(batch.startedAt)}</span>
        </span>
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Completed</span>
          <span className="meta-item-value">{formatDate(batch.completedAt)}</span>
        </span>
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Sandbox</span>
          <span className="meta-item-value">{batch.config.sandboxMode}</span>
        </span>
      </div>

      {batch.error && (
        <div style={{ padding: "10px 14px", background: "var(--danger-soft)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: "var(--radius-sm)", color: "var(--danger)", fontSize: "13px", marginBottom: "24px" }}>
          {batch.error}
        </div>
      )}

      {batch.generation && (
        <div className="tasks-section">
          <div className="section-header">
            <div className="section-title">
              <PlayIcon /> Generated Tasks <StatusPill status={batch.generation.status} />
            </div>
          </div>
          <div className="task-list">
            {batch.generation.tasks?.length ? (
              batch.generation.tasks.map((t, i) => (
                <div key={i} className="task-item">
                  <div className="task-item-title">{i + 1}. {t.title}</div>
                  <div className="task-item-prompt">{t.prompt}</div>
                </div>
              ))
            ) : (
              <div className="text-muted text-sm">No tasks generated yet.</div>
            )}
          </div>
        </div>
      )}

      <div className="runs-section">
        <div className="section-header">
          <div className="section-title">Runs</div>
          <span className="text-muted text-sm">
            {summarizeRunCounts({
              completedRuns,
              failedRuns,
              cancelledRuns,
              preparingRuns,
              waitingForCodexRuns,
              runningRuns,
              queuedRuns,
            })}
          </span>
        </div>
        {batch.runs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </div>
            <p className="empty-title">Waiting for runs</p>
            <p className="empty-desc">Work items appear once the batch creates them.</p>
          </div>
        ) : batch.mode === "ranked" ? (
          <>
            <div className="ranked-candidate-grid">
              {candidateRuns.map((candidateRun) => {
                const glanceEntries = (reviewerByCandidate.get(candidateRun.id) || [])
                  .sort((left, right) => left.run.index - right.run.index);
                const scoredCount = glanceEntries.filter((entry) => entry.score !== null).length;
                const expectedReviewCount = Math.max(batch.config.reviewCount, glanceEntries.length);

                return (
                  <div key={candidateRun.id} className="ranked-candidate-item">
                    <RunCard run={candidateRun} />
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

          </>
        ) : (
          <div className="runs-grid">
            {batch.runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </div>

      <RunDetail run={selectedRun} />
    </div>
  );
}
