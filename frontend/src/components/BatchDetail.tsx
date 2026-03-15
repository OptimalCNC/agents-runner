import { useAppStore, selectSelectedBatch } from "../state/store.js";
import { apiCancelBatch } from "../state/api.js";
import { StatusPill } from "./StatusPill.js";
import { RunCard } from "./RunCard.js";
import { RunDetail } from "./RunDetail.js";
import { ClockIcon, FolderIcon, GitIcon, XIcon, PlayIcon } from "../icons.js";
import { formatDate, formatRelative, formatModeLabel } from "../utils/format.js";
import { summarizeRunCounts } from "../utils/runStatus.js";

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
          <span className="meta-item-value">{batch.runs.length} / {batch.config.runCount}</span>
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
