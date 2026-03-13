import type { Run } from "../../types.js";
import { formatDate } from "../../utils/format.js";

interface Props {
  run: Run;
}

export function LogsTab({ run }: Props) {
  if (!run.logs.length) {
    return (
      <div className="tab-panel is-active" data-tab="logs">
        <div className="text-muted text-sm">No log entries yet.</div>
      </div>
    );
  }

  return (
    <div className="tab-panel is-active" data-tab="logs">
      {run.logs.map((entry, i) => (
        <div key={i} className="log-entry">
          <div className="log-entry-header">
            <span className={`log-level log-level-${entry.level}`}>{entry.level.toUpperCase()}</span>
            <span className="log-time">{formatDate(entry.at)}</span>
          </div>
          <div className="log-msg">{entry.message}</div>
        </div>
      ))}
    </div>
  );
}
