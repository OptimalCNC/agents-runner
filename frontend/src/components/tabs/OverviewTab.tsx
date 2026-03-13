import type { Run } from "../../types.js";
import { StatusPill } from "../StatusPill.js";
import { formatDate } from "../../utils/format.js";

interface Props {
  run: Run;
}

export function OverviewTab({ run }: Props) {
  const directory = run.workingDirectory || run.worktreePath || "Pending";

  return (
    <div className="tab-panel is-active" data-tab="overview">
      <div className="meta-group">
        <div className="meta-row">
          <span className="meta-row-label">Status</span>
          <StatusPill status={run.status} />
        </div>
        <div className="meta-row">
          <span className="meta-row-label">Directory</span>
          <span className="meta-row-value mono">{directory}</span>
        </div>
        <div className="meta-row">
          <span className="meta-row-label">Started</span>
          <span className="meta-row-value">{formatDate(run.startedAt)}</span>
        </div>
        <div className="meta-row">
          <span className="meta-row-label">Completed</span>
          <span className="meta-row-value">{formatDate(run.completedAt)}</span>
        </div>
        {run.usage && (
          <div className="meta-row">
            <span className="meta-row-label">Tokens</span>
            <span className="meta-row-value">
              {run.usage.input_tokens} in / {run.usage.output_tokens} out
              {run.usage.total_tokens != null ? ` / ${run.usage.total_tokens} total` : ""}
            </span>
          </div>
        )}
        {run.error && (
          <div className="meta-row">
            <span className="meta-row-label">Error</span>
            <span className="meta-row-value" style={{ color: "var(--danger)" }}>{run.error}</span>
          </div>
        )}
      </div>
      <div className="review-section">
        <div className="review-section-title">Prompt</div>
        <pre className="code-block">{run.prompt}</pre>
      </div>
    </div>
  );
}
