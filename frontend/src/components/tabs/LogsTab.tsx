import type { Run } from "../../types.js";
import { formatDate } from "../../utils/format.js";

interface Props {
  run: Run;
}

export function LogsTab({ run }: Props) {
  if (!run.logs.length) {
    return (
      <div class="tab-panel is-active" data-tab="logs">
        <div class="text-muted text-sm">No log entries yet.</div>
      </div>
    );
  }

  return (
    <div class="tab-panel is-active" data-tab="logs">
      {run.logs.map((entry, i) => (
        <div key={i} class="log-entry">
          <div class="log-entry-header">
            <span class={`log-level log-level-${entry.level}`}>{entry.level.toUpperCase()}</span>
            <span class="log-time">{formatDate(entry.at)}</span>
          </div>
          <div class="log-msg">{entry.message}</div>
        </div>
      ))}
    </div>
  );
}
