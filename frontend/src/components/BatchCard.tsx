import type { BatchSummary } from "../types.js";
import { selectedBatchId, selectedRunId, activeTab, batchDetails } from "../state/store.js";
import { apiLoadBatch } from "../state/api.js";
import { openDeleteBatchDialog } from "../dialogs/DeleteBatchDialog.js";
import { StatusPill } from "./StatusPill.js";
import { FolderIcon, XIcon } from "../icons.js";
import { formatRelative, formatModeLabel } from "../utils/format.js";
import { getPathLeaf, getProjectPath } from "../utils/paths.js";
import { setBatchDetail, syncSelectedBatch } from "../state/store.js";

interface Props {
  summary: BatchSummary;
}

export function BatchCard({ summary }: Props) {
  const isSelected = summary.id === selectedBatchId.value;
  const totalDone = summary.completedRuns + summary.failedRuns + summary.cancelledRuns;
  const progress = summary.totalRuns ? Math.round((totalDone / summary.totalRuns) * 100) : 0;
  const hasFail = summary.failedRuns > 0;
  const projectPath = getProjectPath(summary);
  const projectFolder = getPathLeaf(projectPath);

  async function handleClick() {
    selectedBatchId.value = summary.id;
    selectedRunId.value = null;
    activeTab.value = "overview";

    if (!batchDetails.value.has(summary.id)) {
      try {
        const payload = await apiLoadBatch(summary.id);
        setBatchDetail(payload.batch);
        syncSelectedBatch();
      } catch {
        // ignore
      }
    } else {
      syncSelectedBatch();
    }
  }

  function handleDelete(e: MouseEvent) {
    e.stopPropagation();
    void openDeleteBatchDialog(summary.id);
  }

  return (
    <div
      class={`batch-card${isSelected ? " is-selected" : ""}`}
      data-batch-id={summary.id}
      onClick={handleClick}
    >
      <div class="batch-card-top">
        <div class="batch-card-info">
          <div class="batch-card-title">{summary.title}</div>
          <div class="batch-card-meta">
            {formatModeLabel(summary.mode)} &middot; {formatRelative(summary.createdAt)}
          </div>
          {projectFolder && (
            <div class="batch-card-project" title={projectPath}>
              <FolderIcon /><span>{projectFolder}</span>
            </div>
          )}
        </div>
        <div class="batch-card-actions">
          <StatusPill status={summary.status} />
          <button
            class="btn-icon batch-card-delete"
            type="button"
            title="Remove batch"
            aria-label="Remove batch"
            onClick={handleDelete}
          >
            <XIcon />
          </button>
        </div>
      </div>
      <div class="batch-card-progress">
        <div class="progress-bar">
          <div class={`progress-bar-fill${hasFail ? " has-failures" : ""}`} style={`width:${progress}%`} />
        </div>
        <div class="progress-label">
          {totalDone === 0 && summary.runningRuns === 0
            ? "Waiting\u2026"
            : [
                summary.completedRuns > 0 ? `${summary.completedRuns} done` : "",
                summary.failedRuns > 0 ? `${summary.failedRuns} failed` : "",
                summary.cancelledRuns > 0 ? `${summary.cancelledRuns} cancelled` : "",
              ]
                .filter(Boolean)
                .join(", ") || "Waiting\u2026"}
          {" "}({totalDone}/{summary.totalRuns})
        </div>
      </div>
    </div>
  );
}
