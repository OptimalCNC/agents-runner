# Workflow Architecture

This document describes the workflow module system and how to add new workflow modes.

## Overview

Each batch mode (`"repeated"`, `"generated"`, `"ranked"`, `"validated"`) is implemented as a self-contained **workflow module** in `src/lib/workflows/`. Workflow modules implement the `WorkflowDefinition` interface and are registered in a central registry. The runner (`src/lib/runner.ts`) is a generic orchestrator that delegates all mode-specific decisions to the active workflow.

## Directory Structure

```
src/lib/workflows/
  types.ts        -- WorkflowDefinition interface and ExecuteRunFn type
  shared.ts       -- Shared utilities: normalizeMode, normalizeNumericScore, extractReviewerScoreFromMcp
  registry.ts     -- Workflow registry: Map<BatchMode, WorkflowDefinition> + getWorkflow()
  repeated.ts     -- "repeated" workflow implementation
  generated.ts    -- "generated" workflow implementation (moves buildTaskSchema, generateTasks, etc.)
  ranked.ts       -- "ranked" workflow implementation (moves scoring, reviewer logic, scheduler)
  validated.ts    -- "validated" workflow implementation (workers + final validator)
  test-helpers.ts -- Test utilities: mock stores, batches, runs
  *.test.ts       -- Per-workflow and registry unit tests
```

## WorkflowDefinition Interface

```typescript
interface WorkflowDefinition {
  mode: BatchMode; // "repeated" | "generated" | "ranked" | "validated"
  label: string; // Display name: "Repeated", "Generated", "Ranked", "Validated"

  // Validate prompt fields before batch creation (throw on invalid)
  validatePayload(p: {
    prompt: string;
    taskPrompt: string;
    reviewPrompt: string;
  }): void;

  // Maximum concurrency for this workflow
  getMaxConcurrency(runCount: number, reviewCount: number): number;

  // Initial generation state (null for repeated/ranked, pending for generated)
  buildInitialBatchState(): { generation: GenerationState | null };

  // Which config prompt drives auto title generation
  getTitleSourcePrompt(batch: Batch): string;

  // Create the task list from batch config (may call Codex for generated mode)
  createTasks(store, batchId, projectContext): Promise<GenerationTask[]>;

  // Execute all candidate runs plus any workflow-specific follow-up runs
  executeBatchRuns(
    store,
    batchId,
    projectContext,
    candidateRuns,
    executeRunFn,
  ): Promise<void>;

  // Called when a submit_score MCP call completes (ranked: recomputes scores)
  onScoreSubmitted(store, batchId): void;

  // Called after all runs settle (ranked: recomputes final scores)
  onBatchSettled(store, batchId): void;

  // Optional: pre-flight check before batch creation (ranked: MCP health check)
  preCreateCheck?(port: number): Promise<{ ok: boolean; error: string }>;
}
```

## Shared Infrastructure in `runner.ts`

The following functions are exported from `runner.ts` for use by workflow modules:

| Export                     | Purpose                                             |
| -------------------------- | --------------------------------------------------- |
| `executeRun`               | Execute a single run in a worktree                  |
| `buildRunRecord`           | Build a new Run object from a GenerationTask        |
| `runWithConcurrency`       | Run items in parallel with a concurrency limit      |
| `finalizeQueuedRun`        | Cancel or fail a still-queued run                   |
| `cancelQueuedRuns`         | Cancel all queued runs in a batch                   |
| `getExecutionState`        | Get/create the AbortController registry for a batch |
| `maybeClearExecutionState` | Clean up execution state when no controllers remain |
| `getCodexClient`           | Create a Codex SDK client                           |
| `getRunCreatedBranchName`  | Extract branch name from run logs                   |
| `nowIso`                   | Current timestamp as ISO string                     |

## How to Add a New Workflow

### Step 1: Add the mode to `BatchMode`

In `src/types.ts`:

```typescript
export type BatchMode = "repeated" | "generated" | "ranked" | "validated" | "yourmode";
```

In `frontend/src/types.ts` (frontend copy):

```typescript
export type BatchMode = "repeated" | "generated" | "ranked" | "validated" | "yourmode";
```

### Step 2: Implement the workflow module

Create `src/lib/workflows/yourmode.ts`:

```typescript
import type {
  Batch,
  BatchStore,
  GenerationTask,
  ProjectContext,
  Run,
} from "../../types";
import { finalizeQueuedRun, runWithConcurrency } from "../runner";
import type { ExecuteRunFn, WorkflowDefinition } from "./types";

export const yourmodeWorkflow: WorkflowDefinition = {
  mode: "yourmode",
  label: "Your Mode",

  validatePayload({ prompt }) {
    if (!prompt) throw new Error("Prompt is required for Your Mode.");
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
    return Array.from({ length: batch.config.runCount }, (_, i) => ({
      title: `Run ${i + 1}`,
      prompt: batch.config.prompt,
    }));
  },

  async executeBatchRuns(
    store,
    batchId,
    projectContext,
    candidateRuns,
    executeRunFn,
  ) {
    const batch = store.getBatch(batchId)!;
    await runWithConcurrency(
      candidateRuns,
      batch.config.concurrency,
      async (run) => {
        const mutableBatch = store.getMutableBatch(batchId);
        if (!mutableBatch || mutableBatch.cancelRequested) {
          finalizeQueuedRun(
            store,
            batchId,
            run.id,
            "cancelled",
            "Batch cancelled before start.",
          );
          return;
        }
        await executeRunFn(store, batchId, run.id, projectContext, {
          autoCreateBranch: false,
        });
      },
    );
  },

  onScoreSubmitted() {},
  onBatchSettled() {},
};
```

### Step 3: Register in the registry

In `src/lib/workflows/registry.ts`:

```typescript
import { yourmodeWorkflow } from "./yourmode";

const workflows = new Map<BatchMode, WorkflowDefinition>([
  ["repeated", repeatedWorkflow],
  ["generated", generatedWorkflow],
  ["ranked", rankedWorkflow],
  ["yourmode", yourmodeWorkflow], // add this
]);
```

### Step 4: Add normalizeMode alias (if needed)

If your mode has legacy names, add them to `src/lib/workflows/shared.ts`:

```typescript
export function normalizeMode(value: unknown): BatchMode {
  // ...existing cases...
  if (value === "yourmode" || value === "your-legacy-name") {
    return "yourmode";
  }
  return "repeated";
}
```

Note: `frontend/src/utils/format.ts` has its own copy of `normalizeMode` for the frontend — update it too.

### Step 5: Add a frontend WorkflowUI module

Create `frontend/src/workflows/yourmode.tsx` implementing the `WorkflowUI` interface from `frontend/src/workflows/types.ts`:

```typescript
import type { WorkflowUI, FormFieldsProps, RunsGridProps } from "./types.js";
import { RunCard } from "../components/RunCard.js";

export const yourmodeWorkflow: WorkflowUI = {
  mode: "yourmode",
  label: "Your Mode",
  Icon: YourModeIcon,                               // SVG icon for the mode selector

  getMaxConcurrency(runCount) { return runCount; }, // concurrency cap
  getConcurrencyHint(limit) { return `Max ${limit} parallel runs.`; },
  canSubmit({ prompt }) { return prompt.trim().length > 0; },
  FormFields: YourModeFormFields,                   // mode-specific prompt inputs

  buildRunsSummaryLabel(batch) { return `${batch.runs.length} / ${batch.config.runCount}`; },
  RunsGrid: YourModeRunsGrid,                       // runs display in BatchDetail
  TasksSection: null,                               // or a component for task lists

  isSessionReadOnly: false,
  showReviewTab() { return true; },
  getRunCardExtras() { return null; },              // or return { tags, scoreLabel, rankLabel }
};
```

Register it in `frontend/src/workflows/registry.ts`:

```typescript
import { yourmodeWorkflow } from "./yourmode.js";

const workflows = new Map<BatchMode, WorkflowUI>([
  // ...existing entries...
  ["yourmode", yourmodeWorkflow],
]);
```

The `NewBatchDrawer`, `BatchDetail`, `RunDetail`, and `RunCard` components all delegate to the registry automatically — no manual edits needed in those files.

### Step 6: Write tests

Create `src/lib/workflows/yourmode.test.ts` testing the pure functions. See `repeated.test.ts` and `generated.test.ts` for examples. Add your mode to the registry guard tests in `registry.test.ts`:

```typescript
const ALL_MODES: BatchMode[] = ["repeated", "generated", "ranked", "validated", "yourmode"];
```

## Testing Guide

Tests are organized in three tiers:

1. **Registry guards** (`registry.test.ts`) — ensure every registered workflow implements the full interface
2. **Per-workflow unit tests** (`*.test.ts`) — test pure functions in isolation using mock stores
3. **Shared utility tests** (`shared.test.ts`) — test `normalizeMode`, score extraction

Use `buildMockStore`, `buildMockBatch`, `buildMockRun`, etc. from `test-helpers.ts` to construct test fixtures without touching the file system.

Run all tests:

```sh
bun test
```

Run only workflow tests:

```sh
bun test src/lib/workflows/
```
