import type { Run } from "../../types.js";
import { renderMarkdown } from "../../utils/markdown.js";

interface Props {
  run: Run;
}

export function ResponseTab({ run }: Props) {
  if (!run.finalResponse) {
    return (
      <div className="tab-panel is-active" data-tab="response">
        <div className="text-muted text-sm">No final response captured yet.</div>
      </div>
    );
  }

  return (
    <div className="tab-panel is-active" data-tab="response">
      <div
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(run.finalResponse) }}
      />
    </div>
  );
}
