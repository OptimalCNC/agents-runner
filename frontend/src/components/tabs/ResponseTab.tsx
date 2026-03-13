import type { Run } from "../../types.js";
import { renderMarkdown } from "../../utils/markdown.js";

interface Props {
  run: Run;
}

export function ResponseTab({ run }: Props) {
  if (!run.finalResponse) {
    return (
      <div class="tab-panel is-active" data-tab="response">
        <div class="text-muted text-sm">No final response captured yet.</div>
      </div>
    );
  }

  return (
    <div class="tab-panel is-active" data-tab="response">
      <div
        class="markdown-body"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(run.finalResponse) }}
      />
    </div>
  );
}
