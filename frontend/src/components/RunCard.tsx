import type { Run } from "../types.js";
import { useAppStore } from "../state/store.js";
import { StatusPill } from "./StatusPill.js";

interface Props {
  run: Run;
}

export function RunCard({ run }: Props) {
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const isSelected = run.id === selectedRunId;
  const reviewSummary = run.review?.statusShort.split("\n")[0].trim();

  function handleClick() {
    useAppStore.setState({ selectedRunId: run.id, activeTab: "session" });
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
      {reviewSummary && (
        <div className="tag-row">
          <span className="tag">{reviewSummary}</span>
        </div>
      )}
    </div>
  );
}
