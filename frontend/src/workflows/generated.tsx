import { RunCard } from "../components/RunCard.js";
import { StatusPill } from "../components/StatusPill.js";
import { PlayIcon } from "../icons.js";
import type { Batch } from "../types.js";
import type { WorkflowUI, FormFieldsProps, RunsGridProps } from "./types.js";

function GeneratedIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function FormFields({ taskPrompt, setTaskPrompt }: FormFieldsProps) {
  return (
    <div className="form-section">
      <label className="form-label" htmlFor="taskPrompt">Task Generation Prompt</label>
      <textarea
        id="taskPrompt"
        name="taskPrompt"
        rows={8}
        value={taskPrompt}
        placeholder="Describe how Codex should split work into independent tasks."
        onChange={(e) => setTaskPrompt(e.target.value)}
      />
    </div>
  );
}

function RunsGrid({ batch }: RunsGridProps) {
  return (
    <div className="runs-grid">
      {batch.runs.map((run) => (
        <RunCard key={run.id} run={run} />
      ))}
    </div>
  );
}

function TasksSection({ batch }: { batch: Batch }) {
  if (!batch.generation) return null;
  return (
    <div className="tasks-section">
      <div className="section-header">
        <div className="section-title">
          <PlayIcon /> Generated Tasks <StatusPill status={batch.generation.status} />
        </div>
      </div>
      <div className="task-list">
        {batch.generation.tasks?.length ? (
          batch.generation.tasks.map((t, i) => (
            <div key={i} className="task-item">
              <div className="task-item-title">{i + 1}. {t.title}</div>
              <div className="task-item-prompt">{t.prompt}</div>
            </div>
          ))
        ) : (
          <div className="text-muted text-sm">No tasks generated yet.</div>
        )}
      </div>
    </div>
  );
}

export const generatedWorkflow: WorkflowUI = {
  mode: "generated",
  label: "Generated",
  Icon: GeneratedIcon,
  getMaxConcurrency(runCount) { return runCount; },
  getConcurrencyHint(limit) { return `Max ${limit} parallel runs.`; },
  canSubmit({ taskPrompt }) { return taskPrompt.trim().length > 0; },
  FormFields,
  buildRunsSummaryLabel(batch) { return `${batch.runs.length} / ${batch.config.runCount}`; },
  RunsGrid,
  TasksSection,
  isSessionReadOnly: false,
  showReviewTab() { return true; },
  getRunCardExtras() { return null; },
};
