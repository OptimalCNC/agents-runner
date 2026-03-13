import type { Run } from "../types.js";
import { selectedRunId, activeTab } from "../state/store.js";
import { StatusPill } from "./StatusPill.js";

interface Props {
  run: Run;
}

export function RunCard({ run }: Props) {
  const isSelected = run.id === selectedRunId.value;

  function handleClick() {
    selectedRunId.value = run.id;
    activeTab.value = "overview";
  }

  return (
    <div
      class={`run-card${isSelected ? " is-selected" : ""}`}
      data-run-id={run.id}
      onClick={handleClick}
    >
      <div class="run-card-top">
        <div class="run-card-title">{run.title}</div>
        <StatusPill status={run.status} />
      </div>
      <div class="run-card-meta">Run {run.index + 1}</div>
      <div class="tag-row">
        {run.threadId && <span class="tag">Thread {run.threadId}</span>}
        {run.review?.statusShort && (
          <span class="tag">{run.review.statusShort.split("\n")[0]}</span>
        )}
      </div>
    </div>
  );
}
