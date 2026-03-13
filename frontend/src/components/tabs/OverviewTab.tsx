import type { Run } from "../../types.js";
import { StatusPill } from "../StatusPill.js";
import { formatDate } from "../../utils/format.js";

interface Props {
  run: Run;
}

export function OverviewTab({ run }: Props) {
  const directory = run.workingDirectory || run.worktreePath || "Pending";

  return (
    <div class="tab-panel is-active" data-tab="overview">
      <div class="meta-group">
        <div class="meta-row">
          <span class="meta-row-label">Status</span>
          <StatusPill status={run.status} />
        </div>
        <div class="meta-row">
          <span class="meta-row-label">Directory</span>
          <span class="meta-row-value mono">{directory}</span>
        </div>
        <div class="meta-row">
          <span class="meta-row-label">Started</span>
          <span class="meta-row-value">{formatDate(run.startedAt)}</span>
        </div>
        <div class="meta-row">
          <span class="meta-row-label">Completed</span>
          <span class="meta-row-value">{formatDate(run.completedAt)}</span>
        </div>
        {run.usage && (
          <div class="meta-row">
            <span class="meta-row-label">Tokens</span>
            <span class="meta-row-value">
              {run.usage.input_tokens} in / {run.usage.output_tokens} out
              {run.usage.total_tokens != null ? ` / ${run.usage.total_tokens} total` : ""}
            </span>
          </div>
        )}
        {run.error && (
          <div class="meta-row">
            <span class="meta-row-label">Error</span>
            <span class="meta-row-value" style="color:var(--danger)">{run.error}</span>
          </div>
        )}
      </div>
      <div class="review-section">
        <div class="review-section-title">Prompt</div>
        <pre class="code-block">{run.prompt}</pre>
      </div>
    </div>
  );
}
