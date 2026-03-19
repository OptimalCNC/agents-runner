# Workflow Architecture

This document describes the workflow module system and the lifecycle contract that every batch mode must follow.

For the user-facing state machine, action semantics, and API surface, see [docs/run-lifecycle.md](docs/run-lifecycle.md).

## Overview

Each batch mode (`"repeated"`, `"generated"`, `"ranked"`, `"validated"`) is implemented as a workflow module in `src/lib/workflows/`. The runner in `src/lib/runner.ts` owns scheduling, execution, run lifecycle actions, and batch status derivation. Workflow modules do not launch runs directly anymore. Instead, they answer workflow-specific questions:

- which runs should exist
- which queued runs are ready to start
- how a run should be executed
- which failed runs are currently blocking downstream progress
- which dependent runs must be reset when a run is rerun

That split is intentional: lifecycle controls such as `stop`, `rerun`, and `resume` must work consistently across all workflows, while the workflow decides dependency semantics.

## Directory Structure

```text
src/lib/workflows/
  types.ts        -- WorkflowDefinition interface and ExecuteRunOptions
  shared.ts       -- Shared utilities: normalizeMode, score/result extraction
  registry.ts     -- Workflow registry and getWorkflow()
  repeated.ts     -- "repeated" workflow implementation
  generated.ts    -- "generated" workflow implementation
  ranked.ts       -- "ranked" workflow implementation
  validated.ts    -- "validated" workflow implementation
  test-helpers.ts -- Mock stores, batches, and runs for unit tests
  *.test.ts       -- Per-workflow and registry unit tests
```

## WorkflowDefinition Interface

```ts
interface ExecuteRunOptions {
  promptOverride?: string;
  sandboxModeOverride?: "workspace-write" | "read-only" | "danger-full-access";
  workingDirectoryOverride?: string;
  additionalDirectoriesOverride?: string[];
  autoCreateBranch?: boolean;
  developerInstructions?: string;
}

interface WorkflowDefinition {
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
```

## Lifecycle Contract

Every workflow must satisfy these rules.

### 1. Run creation

- `createTasks(...)` creates the primary candidate/worker tasks.
- `createAdditionalRuns(...)` creates any workflow-owned follow-up runs up front, such as ranked reviewers or the validated final validator.
- Additional runs should be created in `queued` state. Readiness is handled separately by `isRunReady(...)`.

### 2. Readiness

- `isRunReady(batch, run)` decides whether a queued run is runnable now.
- The runner treats a batch as `running` when at least one run is active or at least one queued run is ready.
- Queued-but-not-ready runs do not make a batch `running` by themselves.

### 3. Blocked-state detection

- `getBlockingRunIds(batch)` returns the failed runs that are currently preventing workflow progress.
- A failed run that does not gate any later stage should not be returned here.
- If no runs are active, no queued runs are ready, and `getBlockingRunIds(...)` is non-empty, the batch becomes `blocked`.
- A failed run does **not** automatically unblock later pipeline stages. The user must explicitly `stop`, `rerun`, or `resume` it.

### 4. Lifecycle reconciliation

- `reconcileLifecycle(...)` is called whenever run state changes or the loader normalizes persisted data.
- Use it to enforce workflow invariants:
  - cancel queued dependent runs when their prerequisite was explicitly stopped
  - recompute derived reviewer scores/ranks
  - mark completed worker runs failed if they violate validator submission requirements
- `reconcileLifecycle(...)` must be idempotent.

### 5. Execution options

- `getRunExecutionOptions(...)` returns the execution spec for a run that is about to start.
- This is where workflows provide prompt overrides, read-only sandboxes, developer instructions, and additional directories.
- The runner still performs the actual launch and stream handling.

### 6. Rerun reset rules

- `getRerunResetRunIds(batch, runId)` returns every run that must be reset to a fresh attempt when `runId` is rerun.
- Include the target run itself.
- Resetting means the old attempt history is cleared in place and the same run card is reused.

## Built-In Workflow Rules

### repeated

- Only candidate runs exist.
- No staged dependencies.
- `getBlockingRunIds(...)` always returns `[]`.
- Rerunning one run resets only that run.

### generated

- Same lifecycle semantics as `repeated`.
- The only additional step is task generation before candidate runs are created.
- Generated batches never use `blocked`.

### ranked

- Candidate runs are created first.
- Reviewer runs are created up front in `queued` state.
- A reviewer is ready only after its candidate completed and produced a working directory to inspect.
- Failed candidates block their reviewer stage.
- Failed reviewers block final ranked settlement.
- Stopping a candidate cancels its queued reviewers.
- Rerunning a candidate resets that candidate plus all of its reviewers.
- Rerunning a reviewer resets only that reviewer.

### validated

- Worker runs are created first.
- One validator run is created up front in `queued` state.
- The validator is ready only after every worker is resolved (`completed` or explicitly `cancelled`).
- Failed workers block validator start.
- Failed validators block batch completion.
- Worker runs must submit exactly one result artifact; invalid submissions are converted to `failed` by `reconcileLifecycle(...)`.
- Rerunning a worker resets that worker plus the validator.
- Rerunning the validator resets only the validator.

## Shared Runner Responsibilities

The runner owns:

- long-lived per-batch scheduling
- concurrency limits
- `stop`, `rerun`, and `resume`
- active-run abort handling
- same-thread resume behavior
- batch status derivation (`queued`, `running`, `blocked`, `failed`, `completed`, `cancelled`)
- persistence and stream processing

If you need to change how stages unblock, which failures become `blocked`, or which dependents are reset on rerun, update the workflow module first and then verify the runner-level lifecycle tests still pass.

## How To Add A New Workflow

### Step 1: Add the mode type

Update both:

- `src/types.ts`
- `frontend/src/types.ts`

### Step 2: Implement the backend workflow module

Create `src/lib/workflows/yourmode.ts`:

```ts
import type {
  Batch,
  BatchStore,
  GenerationTask,
  ProjectContext,
  Run,
} from "../../types";
import { buildRunRecord } from "../runner";
import type { WorkflowDefinition } from "./types";

export const yourmodeWorkflow: WorkflowDefinition = {
  mode: "yourmode",
  label: "Your Mode",

  validatePayload({ prompt }) {
    if (!prompt.trim()) {
      throw new Error("Prompt is required for Your Mode.");
    }
  },

  getMaxConcurrency(runCount) {
    return runCount;
  },

  buildInitialBatchState() {
    return { generation: null };
  },

  getTitleSourcePrompt(batch) {
    return batch.config.prompt;
  },

  async createTasks(store, batchId) {
    const batch = store.getBatch(batchId)!;
    return Array.from({ length: batch.config.runCount }, (_, index) => ({
      title: `Run ${index + 1}`,
      prompt: batch.config.prompt,
    }));
  },

  async createAdditionalRuns(_store, _batchId, _projectContext, _candidateRuns) {
    return [];
  },

  reconcileLifecycle() {},

  isRunReady(_batch, run) {
    return run.kind !== "reviewer" && run.kind !== "validator";
  },

  getRunExecutionOptions() {
    return { autoCreateBranch: false };
  },

  getBlockingRunIds() {
    return [];
  },

  getRerunResetRunIds(_batch, runId) {
    return [runId];
  },

  onScoreSubmitted() {},
  onBatchSettled() {},
};
```

If your workflow needs extra queued runs, create them with `buildRunRecord(...)` inside `createAdditionalRuns(...)`.

### Step 3: Register the backend workflow

Update `src/lib/workflows/registry.ts`.

### Step 4: Update mode normalization if needed

If the mode has legacy names, update `src/lib/workflows/shared.ts`.

### Step 5: Add the frontend workflow UI module

Create `frontend/src/workflows/yourmode.tsx`, register it in `frontend/src/workflows/registry.ts`, and update any frontend mode-label helpers as needed.

### Step 6: Write tests

Minimum backend coverage:

- payload validation
- task creation
- `isRunReady(...)`
- `getBlockingRunIds(...)`
- `getRerunResetRunIds(...)`
- any lifecycle reconciliation side effects

If the workflow introduces stage dependencies, also add runner or batch-store regression tests covering:

- blocked-state transitions
- stop behavior for failed blockers
- rerun reset propagation
- loader normalization after restart
