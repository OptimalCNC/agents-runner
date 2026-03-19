import { RunCard } from "../components/RunCard.js";
import type { WorkflowUI, FormFieldsProps, RunsGridProps } from "./types.js";

function RepeatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

function FormFields({ prompt, setPrompt }: FormFieldsProps) {
  return (
    <div className="form-section">
      <label className="form-label" htmlFor="prompt">Prompt</label>
      <textarea
        id="prompt"
        name="prompt"
        rows={8}
        value={prompt}
        placeholder="Describe the task to repeat across all runs."
        onChange={(e) => setPrompt(e.target.value)}
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

export const repeatedWorkflow: WorkflowUI = {
  mode: "repeated",
  label: "Repeated",
  Icon: RepeatIcon,
  getMaxConcurrency(runCount) { return runCount; },
  getConcurrencyHint(limit) { return `Max ${limit} parallel runs.`; },
  canSubmit({ prompt }) { return prompt.trim().length > 0; },
  FormFields,
  buildRunsSummaryLabel(batch) { return `${batch.runs.length} / ${batch.config.runCount}`; },
  RunsGrid,
  TasksSection: null,
  showReviewTab() { return true; },
  getRunCardExtras() { return null; },
};
