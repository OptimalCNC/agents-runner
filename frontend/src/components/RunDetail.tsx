import { Suspense, lazy } from "react";
import { useState } from "react";
import type { Run } from "../types.js";
import { useAppStore } from "../state/store.js";
import { formatDate } from "../utils/format.js";
import { StatusPill } from "./StatusPill.js";
import { SessionPanel } from "./SessionPanel.js";

const ReviewTab = lazy(async () => {
  const mod = await import("./tabs/ReviewTab.js");
  return { default: mod.ReviewTab };
});

const LogsTab = lazy(async () => {
  const mod = await import("./tabs/LogsTab.js");
  return { default: mod.LogsTab };
});

interface Props {
  run: Run | null;
}

function formatUsageSummary(run: Run): string {
  if (!run.usage) {
    return "\u2014";
  }

  const parts = [
    `${run.usage.input_tokens.toLocaleString()} in`,
    `${run.usage.output_tokens.toLocaleString()} out`,
  ];

  if (run.usage.total_tokens != null) {
    parts.push(`${run.usage.total_tokens.toLocaleString()} total`);
  }

  return parts.join(" / ");
}

export function RunDetail({ run }: Props) {
  const [logsOpen, setLogsOpen] = useState(false);
  const selectedBatchId = useAppStore((state) => state.selectedBatchId);
  const activePanel = useAppStore((state) => {
    const allowed = new Set(["session", "review"]);
    return allowed.has(state.activeTab) ? state.activeTab : "session";
  });

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

  const directory = run.workingDirectory || run.worktreePath || "Pending";
  const usageSummary = formatUsageSummary(run);
  const panels = [
    { key: "session", label: "Session" },
    { key: "review", label: "Review" },
  ];

  return (
    <div className="run-detail">
      <div className="run-detail-header">
        <div className="run-detail-header-main">
          <div className="run-detail-title">{run.title}</div>
          <div className="run-detail-subtitle" title={run.id}>
            Run {run.id}
            {" · "}
            {run.turns.length} {run.turns.length === 1 ? "turn" : "turns"}
            {run.threadId ? ` · Thread ID ${run.threadId}` : ""}
          </div>
          <div className="run-detail-facts">
            <div className="run-detail-fact run-detail-fact-directory" title={directory}>
              <span className="run-detail-fact-value mono">
                {directory}
              </span>
            </div>
            <div className="run-detail-fact">
              <span className="run-detail-fact-label">Started</span>
              <span className="run-detail-fact-value">{formatDate(run.startedAt)}</span>
            </div>
            <div className="run-detail-fact">
              <span className="run-detail-fact-label">Completed</span>
              <span className="run-detail-fact-value">{formatDate(run.completedAt)}</span>
            </div>
            <div className="run-detail-fact">
              <span className="run-detail-fact-label">Tokens</span>
              <span className="run-detail-fact-value">{usageSummary}</span>
            </div>
          </div>
        </div>
        <div className="run-detail-header-actions">
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => setLogsOpen(true)}
          >
            Logs ({run.logs.length})
          </button>
          <StatusPill status={run.status} />
        </div>
      </div>

      {run.error && <div className="run-detail-alert run-detail-alert-danger">{run.error}</div>}

      <div className="run-detail-tabs">
        {panels.map((panel) => (
          <button
            key={panel.key}
            className={`run-detail-tab${activePanel === panel.key ? " is-active" : ""}`}
            type="button"
            onClick={() => useAppStore.setState({ activeTab: panel.key })}
          >
            {panel.label}
          </button>
        ))}
      </div>

      <div className="run-detail-content">
        {activePanel === "session" && selectedBatchId && (
          <SessionPanel batchId={selectedBatchId} run={run} />
        )}
        {activePanel === "review" && (
          <Suspense fallback={<div className="tab-panel text-muted text-sm">Loading review...</div>}>
            <ReviewTab run={run} />
          </Suspense>
        )}
      </div>

      {logsOpen && (
        <div
          className="run-logs-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Run logs"
          onClick={() => setLogsOpen(false)}
        >
          <div className="run-logs-panel" onClick={(event) => event.stopPropagation()}>
            <div className="run-logs-panel-header">
              <div className="run-logs-panel-title">Run Logs</div>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setLogsOpen(false)}>
                Close
              </button>
            </div>
            <Suspense fallback={<div className="tab-panel text-muted text-sm">Loading logs...</div>}>
              <LogsTab run={run} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  );
}
