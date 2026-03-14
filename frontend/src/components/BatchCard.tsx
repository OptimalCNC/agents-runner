import type { BatchSummary } from "../types.js";
import { useAppStore } from "../state/store.js";
import { apiLoadBatch } from "../state/api.js";
import { openDeleteBatchDialog } from "../dialogs/DeleteBatchDialog.js";
import { StatusPill } from "./StatusPill.js";
import { FolderIcon, XIcon } from "../icons.js";
import { formatRelative, formatModeLabel } from "../utils/format.js";
import { getPathLeaf, getProjectPath } from "../utils/paths.js";
import { summarizeRunCounts } from "../utils/runStatus.js";

interface Props {
  summary: BatchSummary;
}

export function BatchCard({ summary }: Props) {
  const selectedBatchId = useAppStore((s) => s.selectedBatchId);
  const isSelected = summary.id === selectedBatchId;
  const totalDone = summary.completedRuns + summary.failedRuns + summary.cancelledRuns;
  const progress = summary.totalRuns ? Math.round((totalDone / summary.totalRuns) * 100) : 0;
  const hasFail = summary.failedRuns > 0;
  const projectPath = getProjectPath(summary);
  const projectFolder = getPathLeaf(projectPath);

  async function handleClick() {
    useAppStore.setState({ selectedBatchId: summary.id, selectedRunId: null, activeTab: "session" });

    const { batchDetails, setBatchDetail, syncSelectedBatch } = useAppStore.getState();
    if (!batchDetails.has(summary.id)) {
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

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    openDeleteBatchDialog(summary.id);
  }

  return (
    <div
      className={`batch-card${isSelected ? " is-selected" : ""}`}
      data-batch-id={summary.id}
      onClick={handleClick}
    >
      <div className="batch-card-top">
        <div className="batch-card-info">
          <div className="batch-card-title">{summary.title}</div>
          <div className="batch-card-meta">
            {formatModeLabel(summary.mode)} &middot; {formatRelative(summary.createdAt)}
          </div>
          {projectFolder && (
            <div className="batch-card-project" title={projectPath}>
              <FolderIcon /><span>{projectFolder}</span>
            </div>
          )}
        </div>
        <div className="batch-card-actions">
          <StatusPill status={summary.status} />
          <button
            className="btn-icon batch-card-delete"
            type="button"
            title="Remove batch"
            aria-label="Remove batch"
            onClick={handleDelete}
          >
            <XIcon />
          </button>
        </div>
      </div>
      <div className="batch-card-progress">
        <div className="progress-bar">
          <div className={`progress-bar-fill${hasFail ? " has-failures" : ""}`} style={{ width: `${progress}%` }} />
        </div>
        <div className="progress-label">
          {summarizeRunCounts(summary)}
          {" "}({totalDone}/{summary.totalRuns})
        </div>
      </div>
    </div>
  );
}
