import type { Run } from "../types.js";
import { useAppStore } from "../state/store.js";
import { StatusPill } from "./StatusPill.js";

interface Props {
  run: Run;
}

export function RunCard({ run }: Props) {
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const isSelected = run.id === selectedRunId;

  function handleClick() {
    useAppStore.setState({ selectedRunId: run.id, activeTab: "overview" });
  }

  return (
    <div
      className={`run-card${isSelected ? " is-selected" : ""}`}
      data-run-id={run.id}
      onClick={handleClick}
    >
      <div className="run-card-top">
        <div className="run-card-title">{run.title}</div>
        <StatusPill status={run.status} />
      </div>
      <div className="run-card-meta">Run {run.index + 1}</div>
      <div className="tag-row">
        {run.threadId && <span className="tag">Thread {run.threadId}</span>}
        {run.review?.statusShort && (
          <span className="tag">{run.review.statusShort.split("\n")[0]}</span>
        )}
      </div>
    </div>
  );
}
