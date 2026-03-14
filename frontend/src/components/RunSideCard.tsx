import { useAppStore } from "../state/store.js";
import type { Run } from "../types.js";
import { OverviewTab } from "./tabs/OverviewTab.js";
import { ReviewTab } from "./tabs/ReviewTab.js";
import { LogsTab } from "./tabs/LogsTab.js";

interface Props {
  run: Run;
}

export function RunSideCard({ run }: Props) {
  const activePanel = useAppStore((state) => {
    const allowed = new Set(["overview", "review", "logs"]);
    return allowed.has(state.activeTab) ? state.activeTab : "overview";
  });

  const panels = [
    { key: "overview", label: "Overview" },
    { key: "review", label: "Review" },
    { key: "logs", label: `Logs (${run.logs.length})` },
  ];

  return (
    <aside className="run-sidecard">
      <div className="run-sidecard-header">
        <div className="run-sidecard-title">Run Details</div>
        <div className="run-sidecard-tabs">
          {panels.map((panel) => (
            <button
              key={panel.key}
              className={`sidecard-tab${activePanel === panel.key ? " is-active" : ""}`}
              type="button"
              onClick={() => useAppStore.setState({ activeTab: panel.key })}
            >
              {panel.label}
            </button>
          ))}
        </div>
      </div>

      <div className="run-sidecard-body">
        {activePanel === "overview" && <OverviewTab run={run} />}
        {activePanel === "review" && <ReviewTab run={run} />}
        {activePanel === "logs" && <LogsTab run={run} />}
      </div>
    </aside>
  );
}
