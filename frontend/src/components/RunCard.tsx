import type { Run } from "../types.js";
import { useAppStore } from "../state/store.js";
import { StatusPill } from "./StatusPill.js";
import type { RunCardExtras } from "../workflows/types.js";

interface Props {
  run: Run;
  extras?: RunCardExtras | null;
}

export function RunCard({ run, extras }: Props) {
  const selectedRunId = useAppStore((s) => s.selectedRunId);
  const isSelected = run.id === selectedRunId;
  const reviewSummary = run.review?.statusShort.split("\n")[0].trim();
  const tags = extras?.tags ?? [];
  const scoreLabel = extras?.scoreLabel ?? "";
  const rankLabel = extras?.rankLabel ?? "";

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
      {(reviewSummary || tags.length > 0 || scoreLabel || rankLabel) && (
        <div className="tag-row">
          {tags.map((tag, i) => (
            <span key={i} className={tag.className ? `tag ${tag.className}` : "tag"}>{tag.label}</span>
          ))}
          {rankLabel && <span className="tag">{rankLabel}</span>}
          {scoreLabel && <span className="tag">{scoreLabel}</span>}
          {reviewSummary && <span className="tag">{reviewSummary}</span>}
        </div>
      )}
    </div>
  );
}
