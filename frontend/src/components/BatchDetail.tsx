import { useAppStore, selectSelectedBatch } from "../state/store.js";
import { apiCancelBatch } from "../state/api.js";
import { StatusPill } from "./StatusPill.js";
import { RunDetail } from "./RunDetail.js";
import { ClockIcon, FolderIcon, GitIcon, XIcon, RefreshIcon } from "../icons.js";
import { formatDate, formatRelative, formatModeLabel } from "../utils/format.js";
import { hasManualFollowUpOverrides } from "../utils/followUps.js";
import { summarizeRunCounts } from "../utils/runStatus.js";
import { getWorkflowUI } from "../workflows/registry.js";
import type { Batch, NewBatchDraft } from "../types.js";

function buildNewBatchDraft(batch: Batch): NewBatchDraft {
  return {
    mode: batch.mode,
    config: { ...batch.config },
  };
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

  const selectedBatch = batch;
  const selectedRun = selectedBatch.runs.find((r) => r.id === selectedRunId) ?? null;
  const canCancel = selectedBatch.status === "running" || selectedBatch.status === "queued" || selectedBatch.status === "blocked";
  const baseRef = selectedBatch.config.baseRef || selectedBatch.projectContext?.branchName || selectedBatch.projectContext?.headSha || "Current HEAD";

  const completedRuns = selectedBatch.runs.filter((r) => r.status === "completed").length;
  const failedRuns = selectedBatch.runs.filter((r) => r.status === "failed").length;
  const cancelledRuns = selectedBatch.runs.filter((r) => r.status === "cancelled").length;
  const preparingRuns = selectedBatch.runs.filter((r) => r.status === "preparing").length;
  const waitingForCodexRuns = selectedBatch.runs.filter((r) => r.status === "waiting_for_codex").length;
  const runningRuns = selectedBatch.runs.filter((r) => r.status === "running").length;
  const queuedRuns = selectedBatch.runs.filter((r) => r.status === "queued").length;

  const workflow = getWorkflowUI(selectedBatch.mode);
  const hasFollowUpOverrides = hasManualFollowUpOverrides(selectedBatch);
  const followUpWarningCopy = selectedBatch.mode === "ranked"
    ? "Manual follow-ups were reopened on this batch. Existing reviewer scores and ranks may now be stale."
    : "Manual follow-ups were reopened on this batch. Existing validator output may now be stale.";

  async function handleCancel() {
    try {
      await apiCancelBatch(selectedBatch.id);
      useAppStore.getState().addToast("info", "Cancel requested", "The batch will stop after current runs finish.");
    } catch (err) {
      useAppStore.getState().addToast("error", "Cancel failed", (err as Error).message);
    }
  }

  function handleUseAsTemplate() {
    useAppStore.getState().openNewBatchDrawer(buildNewBatchDraft(selectedBatch));
    document.body.style.overflow = "hidden";
  }

  return (
    <div className="batch-detail">
      <div className="batch-detail-header">
        <div className="batch-detail-title-area">
          <h2>{batch.title}</h2>
          <div className="batch-detail-meta">
            <span className="meta-item"><ClockIcon /> Created {formatRelative(selectedBatch.createdAt)}</span>
            <span
              className="meta-item meta-item-project-base"
              title={`${selectedBatch.config.projectPath} · Base ref ${baseRef}`}
            >
              <FolderIcon />
              <span className="batch-detail-path">{selectedBatch.config.projectPath}</span>
              <span className="meta-item-separator">·</span>
              <GitIcon />
              <span className="mono">{baseRef}</span>
            </span>
          </div>
        </div>
        <div className="batch-detail-actions">
          <button className="btn btn-ghost btn-sm" type="button" onClick={handleUseAsTemplate}>
            <RefreshIcon /> Use as Template
          </button>
          <StatusPill status={selectedBatch.status} />
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
          <span className="meta-item-value">{formatModeLabel(selectedBatch.mode)}</span>
        </span>
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Runs</span>
          <span className="meta-item-value">{workflow.buildRunsSummaryLabel(selectedBatch)}</span>
        </span>
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Concurrency</span>
          <span className="meta-item-value">{selectedBatch.config.concurrency}</span>
        </span>
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Started</span>
          <span className="meta-item-value">{formatDate(selectedBatch.startedAt)}</span>
        </span>
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Completed</span>
          <span className="meta-item-value">{formatDate(selectedBatch.completedAt)}</span>
        </span>
        <span className="meta-item meta-item-summary">
          <span className="meta-item-prefix">Sandbox</span>
          <span className="meta-item-value">{selectedBatch.config.sandboxMode}</span>
        </span>
      </div>

      {selectedBatch.error && (
        <div style={{ padding: "10px 14px", background: "var(--danger-soft)", border: "1px solid rgba(239,68,68,0.25)", borderRadius: "var(--radius-sm)", color: "var(--danger)", fontSize: "13px", marginBottom: "24px" }}>
          {selectedBatch.error}
        </div>
      )}
      {hasFollowUpOverrides && (
        <div className="run-detail-alert run-detail-alert-warning">
          {followUpWarningCopy}
        </div>
      )}

      {workflow.TasksSection && <workflow.TasksSection batch={selectedBatch} />}

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
        {selectedBatch.runs.length === 0 ? (
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
        ) : (
          <workflow.RunsGrid batch={selectedBatch} selectedRunId={selectedRunId} />
        )}
      </div>

      <RunDetail run={selectedRun} />
    </div>
  );
}
