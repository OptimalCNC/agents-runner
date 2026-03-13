import type { Run } from "../types.js";
import { useAppStore } from "../state/store.js";
import { StatusPill } from "./StatusPill.js";
import { OverviewTab } from "./tabs/OverviewTab.js";
import { ResponseTab } from "./tabs/ResponseTab.js";
import { ReviewTab } from "./tabs/ReviewTab.js";
import { HistoryTab } from "./tabs/HistoryTab.js";
import { LogsTab } from "./tabs/LogsTab.js";

interface Props {
  run: Run | null;
}

export function RunDetail({ run }: Props) {
  const activeTabRaw = useAppStore((s) => s.activeTab);

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

  const tab = activeTabRaw === "items" ? "history" : (activeTabRaw || "overview");

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "response", label: "Response" },
    { key: "review", label: "Review" },
    { key: "history", label: `History (${run.items.length})` },
    { key: "logs", label: `Logs (${run.logs.length})` },
  ];

  return (
    <div className="run-detail">
      <div className="run-detail-header">
        <div className="run-detail-title">{run.title}</div>
        <div className="run-detail-header-actions">
          <StatusPill status={run.status} />
        </div>
      </div>
      <div className="tab-bar">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`tab-btn${tab === t.key ? " is-active" : ""}`}
            data-tab-key={t.key}
            type="button"
            onClick={() => { useAppStore.setState({ activeTab: t.key }); }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" && <OverviewTab run={run} />}
      {tab === "response" && <ResponseTab run={run} />}
      {tab === "review" && <ReviewTab run={run} />}
      {tab === "history" && <HistoryTab run={run} />}
      {tab === "logs" && <LogsTab run={run} />}
    </div>
  );
}
