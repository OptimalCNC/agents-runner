import type { Run } from "../types.js";
import { useAppStore } from "../state/store.js";
import { StatusPill } from "./StatusPill.js";
import { TranscriptPanel } from "./TranscriptPanel.js";
import { RunSideCard } from "./RunSideCard.js";

interface Props {
  run: Run | null;
}

export function RunDetail({ run }: Props) {
  const selectedBatchId = useAppStore((state) => state.selectedBatchId);

  if (!run) {
    return (
      <div className="run-detail">
        <div className="empty-state">
          <div className="empty-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <p className="empty-title">No run selected</p>
          <p className="empty-desc">Select a run card above to inspect details.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="run-detail">
      <div className="run-detail-header">
        <div>
          <div className="run-detail-title">{run.title}</div>
          <div className="run-detail-subtitle">
            {run.turns.length} {run.turns.length === 1 ? "turn" : "turns"}
            {run.threadId ? ` · ${run.threadId}` : ""}
          </div>
        </div>
        <div className="run-detail-header-actions">
          <StatusPill status={run.status} />
        </div>
      </div>

      <div className="run-detail-layout">
        {selectedBatchId && (
          <TranscriptPanel batchId={selectedBatchId} run={run} />
        )}
        <RunSideCard run={run} />
      </div>
    </div>
  );
}
