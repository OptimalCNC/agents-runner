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
  const scoreLabel = run.score === null || run.score === undefined
    ? ""
    : run.kind === "reviewer"
      ? `Score ${run.score}`
      : `Avg ${run.score}`;
  const rankLabel = run.rank ? `#${run.rank}` : "";

  function handleClick() {
    useAppStore.getState().selectRun(run.id);
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
      {(reviewSummary || run.kind === "reviewer" || scoreLabel || rankLabel) && (
        <div className="tag-row">
          {run.kind === "reviewer" && <span className="tag">Reviewer</span>}
          {rankLabel && <span className="tag">{rankLabel}</span>}
          {scoreLabel && <span className="tag">{scoreLabel}</span>}
          {reviewSummary && <span className="tag">{reviewSummary}</span>}
        </div>
      )}
    </div>
  );
}
