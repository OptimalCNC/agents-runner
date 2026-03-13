import { selectedBatch, selectedRunId, addToast } from "../state/store.js";
import { apiCancelBatch } from "../state/api.js";
import { StatusPill } from "./StatusPill.js";
import { RunCard } from "./RunCard.js";
import { RunDetail } from "./RunDetail.js";
import { ClockIcon, FolderIcon, XIcon, PlayIcon } from "../icons.js";
import { formatDate, formatRelative, formatModeLabel } from "../utils/format.js";

function summarizeProgress(batch: { completedRuns?: number; failedRuns?: number; cancelledRuns?: number }) {
  const c = batch.completedRuns ?? 0;
  const f = batch.failedRuns ?? 0;
  const k = batch.cancelledRuns ?? 0;
  const parts: string[] = [];
  if (c) parts.push(`${c} done`);
  if (f) parts.push(`${f} failed`);
  if (k) parts.push(`${k} cancelled`);
  return parts.join(", ") || "Waiting\u2026";
}

export function BatchDetail() {
  const batch = selectedBatch.value;

  if (!batch) {
    return (
      <div class="empty-state main-empty">
        <div class="empty-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        </div>
        <p class="empty-title">No batch selected</p>
        <p class="empty-desc">Launch a batch or select one from the sidebar to inspect run output.</p>
      </div>
    );
  }

  // Ensure selectedRunId is valid
  const validRunId = batch.runs.find((r) => r.id === selectedRunId.value)
    ? selectedRunId.value
    : (batch.runs[0]?.id ?? null);
  if (validRunId !== selectedRunId.value) {
    selectedRunId.value = validRunId;
  }

  const selectedRun = batch.runs.find((r) => r.id === validRunId) ?? null;
  const canCancel = batch.status === "running" || batch.status === "queued";
  const baseRef = batch.config.baseRef || batch.projectContext?.branchName || batch.projectContext?.headSha || "Current HEAD";

  const completedRuns = batch.runs.filter((r) => r.status === "completed").length;
  const failedRuns = batch.runs.filter((r) => r.status === "failed").length;
  const cancelledRuns = batch.runs.filter((r) => r.status === "cancelled").length;

  async function handleCancel() {
    try {
      await apiCancelBatch(batch!.id);
      addToast("info", "Cancel requested", "The batch will stop after current runs finish.");
    } catch (err) {
      addToast("error", "Cancel failed", (err as Error).message);
    }
  }

  return (
    <div class="batch-detail">
      <div class="batch-detail-header">
        <div class="batch-detail-title-area">
          <h2>{batch.title}</h2>
          <div class="batch-detail-meta">
            <span class="meta-item"><ClockIcon /> Created {formatRelative(batch.createdAt)}</span>
            <span class="meta-item"><FolderIcon /> {batch.config.projectPath}</span>
          </div>
        </div>
        <div class="batch-detail-actions">
          <StatusPill status={batch.status} />
          {canCancel && (
            <button class="btn btn-danger btn-sm" type="button" onClick={handleCancel}>
              <XIcon /> Cancel
            </button>
          )}
        </div>
      </div>

      <div class="info-cards">
        <div class="info-card">
          <div class="info-card-label">Mode</div>
          <div class="info-card-value">{formatModeLabel(batch.mode)}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Runs</div>
          <div class="info-card-value">{batch.runs.length} / {batch.config.runCount}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Concurrency</div>
          <div class="info-card-value">{batch.config.concurrency}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Base Ref</div>
          <div class="info-card-value">{baseRef}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Started</div>
          <div class="info-card-value">{formatDate(batch.startedAt)}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Completed</div>
          <div class="info-card-value">{formatDate(batch.completedAt)}</div>
        </div>
        <div class="info-card">
          <div class="info-card-label">Sandbox</div>
          <div class="info-card-value">{batch.config.sandboxMode}</div>
        </div>
      </div>

      {batch.error && (
        <div style="padding:10px 14px;background:var(--danger-soft);border:1px solid rgba(239,68,68,0.25);border-radius:var(--radius-sm);color:var(--danger);font-size:13px;margin-bottom:24px;">
          {batch.error}
        </div>
      )}

      {batch.generation && (
        <div class="tasks-section">
          <div class="section-header">
            <div class="section-title">
              <PlayIcon /> Generated Tasks <StatusPill status={batch.generation.status} />
            </div>
          </div>
          <div class="task-list">
            {batch.generation.tasks?.length ? (
              batch.generation.tasks.map((t, i) => (
                <div key={i} class="task-item">
                  <div class="task-item-title">{i + 1}. {t.title}</div>
                  <div class="task-item-prompt">{t.prompt}</div>
                </div>
              ))
            ) : (
              <div class="text-muted text-sm">No tasks generated yet.</div>
            )}
          </div>
        </div>
      )}

      <div class="runs-section">
        <div class="section-header">
          <div class="section-title">Runs</div>
          <span class="text-muted text-sm">
            {summarizeProgress({ completedRuns, failedRuns, cancelledRuns })}
          </span>
        </div>
        {batch.runs.length === 0 ? (
          <div class="empty-state">
            <div class="empty-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </div>
            <p class="empty-title">Waiting for runs</p>
            <p class="empty-desc">Work items appear once the batch creates them.</p>
          </div>
        ) : (
          <div class="runs-grid">
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
