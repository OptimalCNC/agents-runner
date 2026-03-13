import type { Run } from "../../types.js";
import { StreamItemView } from "../StreamItemView.js";

interface Props {
  run: Run;
}

export function HistoryTab({ run }: Props) {
  if (!run.items.length) {
    return (
      <div className="tab-panel is-active" data-tab="history">
        <div className="text-muted text-sm">No streamed history recorded yet.</div>
      </div>
    );
  }

  return (
    <div className="tab-panel is-active" data-tab="history">
      <div className="timeline">
        {run.items.map((item, i) => (
          <StreamItemView key={item.id ?? i} item={item} />
        ))}
      </div>
    </div>
  );
}
