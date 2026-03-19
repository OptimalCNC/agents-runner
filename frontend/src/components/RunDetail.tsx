import { Suspense, lazy } from "react";
import { useEffect, useState } from "react";
import type { Run } from "../types.js";
import { TerminalIcon } from "../icons.js";
import { apiLaunchTerminal } from "../state/api.js";
import { useAppStore, selectSelectedBatch } from "../state/store.js";
import type { RunDetailTab } from "../state/navigation.js";
import { getWorkflowUI } from "../workflows/registry.js";
import { detectClientPlatform } from "../utils/clientPlatform.js";
import { formatDate } from "../utils/format.js";
import { getRunTerminalPath, resolveTerminalLaunchState } from "../utils/terminalLaunch.js";
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

const ConfigsTab = lazy(async () => {
  const mod = await import("./tabs/ConfigsTab.js");
  return { default: mod.ConfigsTab };
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
  const [configsOpen, setConfigsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [launchingTerminal, setLaunchingTerminal] = useState(false);
  const selectedBatchId = useAppStore((state) => state.selectedBatchId);
  const selectedBatch = useAppStore(selectSelectedBatch);
  const activePanel = useAppStore((state) => state.activeTab);
  const config = useAppStore((state) => state.config);
  const clientPlatform = detectClientPlatform();

  const workflow = selectedBatch ? getWorkflowUI(selectedBatch.mode) : null;
  const showReviewPanel = run ? (workflow?.showReviewTab(run) ?? true) : true;

  useEffect(() => {
    if (activePanel === "review" && !showReviewPanel) {
      useAppStore.getState().selectTab("session");
    }
  }, [activePanel, showReviewPanel]);

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

  const terminalPath = getRunTerminalPath(run);
  const directory = terminalPath || "Pending";
  const usageSummary = formatUsageSummary(run);
  const configCount = run.turns.filter((turn) => Boolean(turn.codexConfig)).length;
  const terminalLaunchState = resolveTerminalLaunchState(config, clientPlatform, terminalPath);
  const panels: { key: RunDetailTab; label: string }[] = [
    { key: "session", label: "Session" },
    ...(showReviewPanel ? [{ key: "review", label: "Review" } as const] : []),
  ];

  async function handleOpenTerminal(): Promise<void> {
    if (!terminalLaunchState.canLaunch || launchingTerminal || !terminalPath) {
      return;
    }

    setLaunchingTerminal(true);
    try {
      await apiLaunchTerminal({
        path: terminalPath,
        clientPlatform,
      });
    } catch (error) {
      useAppStore.getState().addToast("error", "Failed to open terminal", (error as Error).message);
    } finally {
      setLaunchingTerminal(false);
    }
  }

  return (
    <div className="run-detail">
      <div className="run-detail-header">
        <div className="run-detail-header-main">
          <div className="run-detail-title">{run.title}</div>
          <div className="run-detail-subtitle">
            Run {run.index + 1}
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
            className="btn btn-primary btn-sm"
            type="button"
            disabled={!terminalLaunchState.canLaunch || launchingTerminal}
            title={terminalLaunchState.canLaunch ? `Open in ${terminalLaunchState.effectiveLauncherLabel}` : terminalLaunchState.disabledReason}
            onClick={() => void handleOpenTerminal()}
          >
            <TerminalIcon size={13} />
            {launchingTerminal ? "Opening..." : "Open in Terminal"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={configCount === 0}
            onClick={() => {
              setLogsOpen(false);
              setConfigsOpen(true);
            }}
          >
            Configs ({configCount})
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => {
              setConfigsOpen(false);
              setLogsOpen(true);
            }}
          >
            Logs ({run.logs.length})
          </button>
          <StatusPill status={run.status} />
        </div>
      </div>

      {run.error && <div className="run-detail-alert run-detail-alert-danger">{run.error}</div>}
      {!terminalLaunchState.canLaunch && terminalLaunchState.disabledReason && (
        <div className="run-detail-note text-muted text-sm">{terminalLaunchState.disabledReason}</div>
      )}
      {run.followUpsReopened && (
        <div className="run-detail-alert run-detail-alert-info">
          Follow-ups were reopened manually
          {run.followUpsReopenedAt ? ` on ${formatDate(run.followUpsReopenedAt)}` : ""}.
          Review results shown for this run may now be stale.
        </div>
      )}

      <div className="run-detail-tabs">
        {panels.map((panel) => (
          <button
            key={panel.key}
            className={`run-detail-tab${activePanel === panel.key ? " is-active" : ""}`}
            type="button"
            onClick={() => useAppStore.getState().selectTab(panel.key)}
          >
            {panel.label}
          </button>
        ))}
      </div>

      <div className="run-detail-content">
        {activePanel === "session" && selectedBatchId && selectedBatch && (
          <SessionPanel batchId={selectedBatchId} batch={selectedBatch} run={run} />
        )}
        {activePanel === "review" && showReviewPanel && (
          <Suspense fallback={<div className="tab-panel text-muted text-sm">Loading review...</div>}>
            <ReviewTab run={run} />
          </Suspense>
        )}
      </div>

      {configsOpen && (
        <div
          className="run-logs-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Run configs"
          onClick={() => setConfigsOpen(false)}
        >
          <div className="run-logs-panel" onClick={(event) => event.stopPropagation()}>
            <div className="run-logs-panel-header">
              <div className="run-logs-panel-title">Turn Configs</div>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setConfigsOpen(false)}>
                Close
              </button>
            </div>
            <div className="run-logs-panel-body">
              <Suspense fallback={<div className="tab-panel text-muted text-sm">Loading configs...</div>}>
                <ConfigsTab key={run.id} run={run} />
              </Suspense>
            </div>
          </div>
        </div>
      )}

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
            <div className="run-logs-panel-body">
              <Suspense fallback={<div className="tab-panel text-muted text-sm">Loading logs...</div>}>
                <LogsTab key={run.id} run={run} />
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
