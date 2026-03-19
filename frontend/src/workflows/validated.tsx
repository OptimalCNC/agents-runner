import { RunCard } from "../components/RunCard.js";
import type { Run } from "../types.js";
import type { WorkflowUI, FormFieldsProps, RunsGridProps } from "./types.js";

function ValidatedIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function FormFields({ prompt, setPrompt, reviewPrompt, setReviewPrompt }: FormFieldsProps) {
  return (
    <>
      <div className="form-section">
        <label className="form-label" htmlFor="prompt">Prompt</label>
        <textarea
          id="prompt"
          name="prompt"
          rows={8}
          value={prompt}
          placeholder="Describe the task each worker should execute."
          onChange={(event) => setPrompt(event.target.value)}
        />
      </div>
      <div className="form-section">
        <label className="form-label" htmlFor="reviewPrompt">Checker Prompt</label>
        <textarea
          id="reviewPrompt"
          name="reviewPrompt"
          rows={6}
          value={reviewPrompt}
          placeholder="Ask the validator to inspect every worker worktree, compare the implementations, and write one final verdict."
          onChange={(event) => setReviewPrompt(event.target.value)}
        />
        <span className="form-hint">
          Ask for a read-only comparison of each worker worktree and final response, with correctness, completeness, regression risk, and a final verdict. Worker worktree directories are granted automatically.
        </span>
      </div>
    </>
  );
}

function listWorkerRuns(batch: RunsGridProps["batch"]): Run[] {
  return batch.runs
    .filter((run) => run.kind === "candidate")
    .sort((left, right) => left.index - right.index);
}

function RunsGrid({ batch }: RunsGridProps) {
  const workerRuns = listWorkerRuns(batch);
  const validatorRun = batch.runs.find((run) => run.kind === "validator") || null;

  return (
    <div>
      <div className="runs-grid">
        {workerRuns.map((run) => (
          <RunCard key={run.id} run={run} />
        ))}
      </div>

      {validatorRun && (
        <div className="tasks-section">
          <div className="section-header">
            <div className="section-title">Validator</div>
          </div>
          <div className="runs-grid">
            <RunCard run={validatorRun} extras={{ tags: [{ label: "Validator" }] }} />
          </div>
        </div>
      )}
    </div>
  );
}

export const validatedWorkflow: WorkflowUI = {
  mode: "validated",
  label: "Validated",
  Icon: ValidatedIcon,
  getMaxConcurrency(runCount) { return runCount; },
  getConcurrencyHint(limit) { return `Max ${limit} parallel worker runs, followed by one validator run.`; },
  canSubmit({ prompt, reviewPrompt }) { return prompt.trim().length > 0 && reviewPrompt.trim().length > 0; },
  FormFields,
  buildRunsSummaryLabel(batch) { return `${batch.config.runCount} workers · 1 validator`; },
  RunsGrid,
  TasksSection: null,
  isSessionReadOnly: true,
  showReviewTab(run) { return run.kind !== "validator"; },
  getRunCardExtras(run) {
    return run.kind === "validator" ? { tags: [{ label: "Validator" }] } : null;
  },
};
