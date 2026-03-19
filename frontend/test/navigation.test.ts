import { describe, expect, test } from "bun:test";

import type { Batch, BatchSummary } from "../src/types.js";
import {
  buildNavigationSearch,
  ensureSelectedBatchVisibleInFilters,
  loadUiPreferences,
  parseNavigationSelection,
  reconcileNavigationState,
  saveUiPreferences,
} from "../src/state/navigation.js";

const baseConfig = {
  runCount: 2,
  concurrency: 1,
  projectPath: "/tmp/project-a",
  worktreeRoot: "/tmp",
  prompt: "prompt",
  taskPrompt: "",
  baseRef: "main",
  model: "",
  sandboxMode: "workspace-write",
  networkAccessEnabled: false,
  webSearchMode: "disabled",
  reasoningEffort: "",
};

function makeSummary(id: string, projectPath: string): BatchSummary {
  return {
    id,
    mode: "repeated",
    title: id,
    status: "completed",
    createdAt: "2026-03-15T00:00:00.000Z",
    startedAt: "2026-03-15T00:00:01.000Z",
    completedAt: "2026-03-15T00:00:02.000Z",
    cancelRequested: false,
    totalRuns: 2,
    completedRuns: 2,
    failedRuns: 0,
    cancelledRuns: 0,
    preparingRuns: 0,
    waitingForCodexRuns: 0,
    runningRuns: 0,
    queuedRuns: 0,
    config: {
      ...baseConfig,
      projectPath,
    },
    generation: null,
  };
}

function makeBatch(id: string, projectPath: string, runIds: string[]): Batch {
  return {
    id,
    mode: "repeated",
    title: id,
    status: "completed",
    createdAt: "2026-03-15T00:00:00.000Z",
    startedAt: "2026-03-15T00:00:01.000Z",
    completedAt: "2026-03-15T00:00:02.000Z",
    cancelRequested: false,
    error: null,
    config: {
      ...baseConfig,
      projectPath,
    },
    generation: null,
    projectContext: undefined,
    runs: runIds.map((runId, index) => ({
      id: runId,
      index,
      title: runId,
      prompt: "prompt",
      status: "completed",
      startedAt: "2026-03-15T00:00:01.000Z",
      completedAt: "2026-03-15T00:00:02.000Z",
      threadId: `thread-${runId}`,
      worktreePath: `/tmp/${runId}`,
      workingDirectory: `/tmp/${runId}`,
      baseRef: "main",
      finalResponse: "",
      error: null,
      usage: null,
      logs: [],
      turns: [],
      items: [],
      review: null,
      followUpsReopened: false,
      followUpsReopenedAt: null,
    })),
  };
}

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("navigation state", () => {
  test("round-trips valid batch/run/tab selection through the URL", () => {
    const parsed = parseNavigationSelection("?batch=batch-2&run=run-5&tab=review");

    expect(parsed).toEqual({
      activeView: "batches",
      selectedBatchId: "batch-2",
      selectedRunId: "run-5",
      activeTab: "review",
    });
    expect(buildNavigationSearch(parsed)).toBe("?batch=batch-2&run=run-5&tab=review");
  });

  test("omits default batches view and ignores tab-only URLs without a batch", () => {
    expect(parseNavigationSelection("?tab=invalid")).toEqual({
      activeView: "batches",
      selectedBatchId: null,
      selectedRunId: null,
      activeTab: "session",
    });

    expect(buildNavigationSearch({
      activeView: "batches",
      selectedBatchId: null,
      selectedRunId: "run-1",
      activeTab: "review",
    })).toBe("");
  });

  test("supports a dedicated settings view in the URL", () => {
    const parsed = parseNavigationSelection("?view=settings&batch=batch-2&run=run-5&tab=review");

    expect(parsed).toEqual({
      activeView: "settings",
      selectedBatchId: "batch-2",
      selectedRunId: "run-5",
      activeTab: "review",
    });

    expect(buildNavigationSearch({
      activeView: "settings",
      selectedBatchId: null,
      selectedRunId: null,
      activeTab: "session",
    })).toBe("?view=settings");
  });

  test("keeps requested run until the selected batch detail is loaded", () => {
    const batchA = makeSummary("batch-a", "/tmp/project-a");
    const reconciled = reconcileNavigationState({
      batches: [batchA],
      batchDetails: new Map(),
      activeView: "batches",
      selectedBatchId: "batch-a",
      selectedRunId: "run-2",
      activeTab: "review",
      projectFilters: [],
    });

    expect(reconciled).toEqual({
      activeView: "batches",
      selectedBatchId: "batch-a",
      selectedRunId: "run-2",
      activeTab: "review",
      projectFilters: [],
    });
  });

  test("falls back to the first visible batch and its first run when the selected batch is invalid", () => {
    const batchA = makeSummary("batch-a", "/tmp/project-a");
    const batchB = makeSummary("batch-b", "/tmp/project-b");
    const batchDetails = new Map<string, Batch>([
      ["batch-a", makeBatch("batch-a", "/tmp/project-a", ["run-a1", "run-a2"])],
    ]);

    const reconciled = reconcileNavigationState({
      batches: [batchA, batchB],
      batchDetails,
      activeView: "settings",
      selectedBatchId: "missing-batch",
      selectedRunId: "missing-run",
      activeTab: "review",
      projectFilters: [],
    });

    expect(reconciled).toEqual({
      activeView: "settings",
      selectedBatchId: "batch-a",
      selectedRunId: "run-a1",
      activeTab: "review",
      projectFilters: [],
    });
  });

  test("falls back to the first run in the selected batch when the requested run is missing", () => {
    const batchB = makeSummary("batch-b", "/tmp/project-b");
    const batchDetails = new Map<string, Batch>([
      ["batch-b", makeBatch("batch-b", "/tmp/project-b", ["run-b1", "run-b2"])],
    ]);

    const reconciled = reconcileNavigationState({
      batches: [batchB],
      batchDetails,
      activeView: "batches",
      selectedBatchId: "batch-b",
      selectedRunId: "run-missing",
      activeTab: "review",
      projectFilters: [],
    });

    expect(reconciled.selectedBatchId).toBe("batch-b");
    expect(reconciled.selectedRunId).toBe("run-b1");
    expect(reconciled.activeTab).toBe("review");
  });

  test("can expand stored filters to keep a deep-linked batch visible", () => {
    const batchA = makeSummary("batch-a", "/tmp/project-a");
    const batchB = makeSummary("batch-b", "/tmp/project-b");

    expect(ensureSelectedBatchVisibleInFilters(
      ["/tmp/project-a"],
      [batchA, batchB],
      "batch-b",
    )).toEqual(["/tmp/project-a", "/tmp/project-b"]);
  });

  test("persists project filters in local storage without touching the URL contract", () => {
    const storage = new MemoryStorage();
    saveUiPreferences({ projectFilters: ["/tmp/project-a", "/tmp/project-b"] }, storage);

    expect(loadUiPreferences(storage)).toEqual({
      projectFilters: ["/tmp/project-a", "/tmp/project-b"],
    });
  });
});
