import type { Batch, BatchMode, BatchStore, GenerationState, GenerationTask, ProjectContext, Run } from "../../types";

export interface ExecuteRunOptions {
  promptOverride?: string;
  sandboxModeOverride?: "workspace-write" | "read-only" | "danger-full-access";
  workingDirectoryOverride?: string;
  additionalDirectoriesOverride?: string[];
  autoCreateBranch?: boolean;
  developerInstructions?: string;
}

export type ExecuteRunFn = (
  store: BatchStore,
  batchId: string,
  runId: string,
  projectContext: ProjectContext,
  options?: ExecuteRunOptions,
) => Promise<void>;

export interface WorkflowDefinition {
  mode: BatchMode;
  label: string;

  validatePayload(p: { prompt: string; taskPrompt: string; reviewPrompt: string }): void;
  getMaxConcurrency(runCount: number, reviewCount: number): number;
  buildInitialBatchState(): { generation: GenerationState | null };
  getTitleSourcePrompt(batch: Batch): string;

  createTasks(store: BatchStore, batchId: string, projectContext: ProjectContext): Promise<GenerationTask[]>;
  createAdditionalRuns(
    store: BatchStore,
    batchId: string,
    projectContext: ProjectContext,
    candidateRuns: Run[],
  ): Promise<Run[]>;
  reconcileLifecycle(store: BatchStore, batchId: string): void;
  isRunReady(batch: Batch, run: Run): boolean;
  getRunExecutionOptions(batch: Batch, run: Run, projectContext: ProjectContext): ExecuteRunOptions;
  getBlockingRunIds(batch: Batch): string[];
  getRerunResetRunIds(batch: Batch, runId: string): string[];

  onScoreSubmitted(store: BatchStore, batchId: string): void;
  onBatchSettled(store: BatchStore, batchId: string): void;

  preCreateCheck?(port: number): Promise<{ ok: boolean; error: string }>;
}
