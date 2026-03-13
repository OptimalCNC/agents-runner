import fs from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";

import type {
  Batch,
  BatchConfig,
  BatchMode,
  BatchStatus,
  BatchStore,
  BatchSummary,
  GenerationState,
  Run,
} from "../types";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(): string {
  return new Date().toISOString();
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sortBatches(batches: BatchSummary[]): BatchSummary[] {
  return batches.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function normalizeMode(value: string | undefined): BatchMode {
  return value === "generated" || value === "task-generator" ? "generated" : "repeated";
}

function buildSummary(batch: Batch): BatchSummary {
  const completedRuns = batch.runs.filter((run) => run.status === "completed").length;
  const failedRuns = batch.runs.filter((run) => run.status === "failed").length;
  const cancelledRuns = batch.runs.filter((run) => run.status === "cancelled").length;
  const runningRuns = batch.runs.filter((run) => run.status === "running").length;
  const queuedRuns = batch.runs.filter((run) => run.status === "queued").length;

  return {
    id: batch.id,
    mode: batch.mode,
    title: batch.title,
    status: batch.status,
    createdAt: batch.createdAt,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
    cancelRequested: batch.cancelRequested,
    totalRuns: batch.runs.length,
    completedRuns,
    failedRuns,
    cancelledRuns,
    runningRuns,
    queuedRuns,
    config: batch.config,
    generation: batch.generation,
  };
}

export function createBatchStore(dataDirectory: string): BatchStore {
  const batchesRoot = path.join(dataDirectory, "batches");
  const batches = new Map<string, Batch>();
  const subscribers = new Set<ServerResponse>();
  const pendingBatchBroadcasts = new Set<string>();
  const dirtyBatches = new Set<string>();
  const dirtyRuns = new Map<string, Set<string>>();
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let storageQueue: Promise<unknown> = Promise.resolve();

  function batchDir(batchId: string): string {
    return path.join(batchesRoot, batchId);
  }

  function runsDir(batchId: string): string {
    return path.join(batchesRoot, batchId, "runs");
  }

  async function atomicWrite(filePath: string, data: unknown): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, filePath);
  }

  async function persistBatch(batchId: string): Promise<void> {
    const batch = batches.get(batchId);
    if (!batch) {
      return;
    }

    const dir = batchDir(batchId);
    const rDir = runsDir(batchId);
    await fs.mkdir(rDir, { recursive: true });

    const { runs, ...batchMeta } = clone(batch);
    (batchMeta as Record<string, unknown>).runIds = runs.map((r: Run) => r.id);
    await atomicWrite(path.join(dir, "batch.json"), batchMeta);

    const batchDirtyRuns = dirtyRuns.get(batchId);
    if (batchDirtyRuns) {
      for (const runId of batchDirtyRuns) {
        const run = runs.find((r: Run) => r.id === runId);
        if (run) {
          await atomicWrite(path.join(rDir, `${runId}.json`), run);
        }
      }
      dirtyRuns.delete(batchId);
    }
  }

  function queueStorageTask(task: () => Promise<void>): Promise<void> {
    const run = storageQueue.then(task, task);
    storageQueue = run.catch(() => {});
    return run;
  }

  function schedulePersist(): void {
    if (persistTimer) {
      return;
    }

    persistTimer = setTimeout(() => {
      persistTimer = null;
      const ids = Array.from(dirtyBatches);
      dirtyBatches.clear();

      void queueStorageTask(async () => {
        try {
          for (const batchId of ids) {
            await persistBatch(batchId);
          }
        } catch (error) {
          console.error("Failed to persist batches", error);
        }
      });
    }, 150);
  }

  function writeSse(response: ServerResponse, eventName: string, payload: unknown): void {
    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  function broadcastEvent(eventName: string, payload: unknown): void {
    for (const response of subscribers) {
      writeSse(response, eventName, payload);
    }
  }

  function flushBroadcasts(): void {
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
    }
    broadcastTimer = null;

    if (pendingBatchBroadcasts.size === 0 || subscribers.size === 0) {
      pendingBatchBroadcasts.clear();
      return;
    }

    const batchIds = Array.from(pendingBatchBroadcasts);
    pendingBatchBroadcasts.clear();

    for (const batchId of batchIds) {
      const batch = batches.get(batchId);
      if (!batch) {
        continue;
      }

      const payload = {
        summary: buildSummary(batch),
        batch: clone(batch),
      };

      for (const response of subscribers) {
        writeSse(response, "batch.updated", payload);
      }
    }
  }

  function scheduleBroadcast(batchId: string): void {
    pendingBatchBroadcasts.add(batchId);

    if (broadcastTimer) {
      return;
    }

    broadcastTimer = setTimeout(flushBroadcasts, 100);
  }

  function queueBatchUpdate(batchId: string): void {
    dirtyBatches.add(batchId);
    schedulePersist();
    scheduleBroadcast(batchId);
  }

  function markRunDirty(batchId: string, runId: string): void {
    if (!dirtyRuns.has(batchId)) {
      dirtyRuns.set(batchId, new Set());
    }
    dirtyRuns.get(batchId)!.add(runId);
  }

  async function migrateFromLegacy(): Promise<boolean> {
    const legacyFile = path.join(dataDirectory, "runs.json");
    let fileContent: string;

    try {
      fileContent = await fs.readFile(legacyFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }

    const legacyRuns = JSON.parse(fileContent) as Record<string, unknown>[];
    console.log(`Migrating ${legacyRuns.length} entries from runs.json to folder-based storage...`);

    for (const entry of legacyRuns) {
      entry.mode = normalizeMode((entry.mode ?? entry.workflowType) as string | undefined);
      delete entry.workflowType;

      const batch: Record<string, unknown> = {
        id: entry.id,
        mode: entry.mode,
        title: entry.title,
        status: entry.status,
        createdAt: entry.createdAt,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        cancelRequested: entry.cancelRequested,
        error: entry.error,
        config: entry.config,
        generation: entry.generation,
        projectContext: entry.projectContext,
        runs: ((entry.agents as Record<string, unknown>[]) || []).map((agent) => ({
          ...agent,
          id: (agent.id as string).replace(/^agent-/, "run-"),
        })),
      };

      const dir = batchDir(batch.id as string);
      const rDir = runsDir(batch.id as string);
      await fs.mkdir(rDir, { recursive: true });

      const runs = batch.runs as Record<string, unknown>[];
      const batchMeta = { ...batch };
      delete batchMeta.runs;
      batchMeta.runIds = runs.map((r) => r.id);
      await atomicWrite(path.join(dir, "batch.json"), batchMeta);

      for (const run of runs) {
        await atomicWrite(path.join(rDir, `${run.id}.json`), run);
      }
    }

    await fs.unlink(legacyFile);
    console.log("Migration complete. Removed legacy runs.json.");
    return true;
  }

  async function load(): Promise<void> {
    await fs.mkdir(dataDirectory, { recursive: true });

    await migrateFromLegacy();

    try {
      await fs.access(batchesRoot);
    } catch {
      return;
    }

    const entries = await fs.readdir(batchesRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const batchId = entry.name;
      const batchFile = path.join(batchDir(batchId), "batch.json");

      let batchMeta: Record<string, unknown>;
      try {
        batchMeta = JSON.parse(await fs.readFile(batchFile, "utf8"));
      } catch {
        continue;
      }

      batchMeta.mode = normalizeMode((batchMeta.mode ?? batchMeta.workflowType) as string | undefined);
      delete batchMeta.workflowType;

      const runs: Run[] = [];
      const rDir = runsDir(batchId);
      try {
        const runFiles = await fs.readdir(rDir);
        for (const runFile of runFiles) {
          if (!runFile.endsWith(".json")) {
            continue;
          }
          try {
            const run = JSON.parse(await fs.readFile(path.join(rDir, runFile), "utf8")) as Run;
            runs.push(run);
          } catch {
            continue;
          }
        }
      } catch {
        // No runs directory yet
      }

      runs.sort((a, b) => a.index - b.index);

      delete batchMeta.runIds;

      const batch = { ...batchMeta, runs } as unknown as Batch;

      if (batch.status === "running" || batch.status === "queued") {
        batch.status = "failed";
        batch.completedAt = nowIso();
        batch.error = "Interrupted by server restart.";

        for (const run of batch.runs) {
          if (run.status === "running" || run.status === "queued") {
            run.status = "failed";
            run.completedAt = nowIso();
            run.error = "Interrupted by server restart.";
          }
        }
      }

      batches.set(batch.id, batch);
    }
  }

  function listSummaries(): BatchSummary[] {
    return sortBatches(Array.from(batches.values()).map(buildSummary));
  }

  function getBatch(batchId: string): Batch | null {
    const batch = batches.get(batchId);
    return batch ? clone(batch) : null;
  }

  function getMutableBatch(batchId: string): Batch | null {
    return batches.get(batchId) ?? null;
  }

  function createBatch({
    mode,
    title,
    config,
  }: {
    mode: BatchMode;
    title: string;
    config: BatchConfig;
  }): Batch {
    const id = createId();
    const batch: Batch = {
      id,
      mode,
      title,
      status: "queued",
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
      cancelRequested: false,
      error: null,
      config,
      generation: mode === "generated"
        ? {
            status: "pending",
            startedAt: null,
            completedAt: null,
            error: null,
            tasks: [],
          }
        : null,
      runs: [],
    };

    batches.set(id, batch);
    queueBatchUpdate(id);
    return clone(batch);
  }

  function updateBatch(batchId: string, updater: (batch: Batch) => void): Batch | null {
    const batch = batches.get(batchId);
    if (!batch) {
      return null;
    }

    updater(batch);
    queueBatchUpdate(batchId);
    return clone(batch);
  }

  function appendRun(batchId: string, run: Run): Batch | null {
    return updateBatch(batchId, (batch) => {
      batch.runs.push(run);
      markRunDirty(batchId, run.id);
    });
  }

  function updateRun(batchId: string, runId: string, updater: (run: Run, batch: Batch) => void): Batch | null {
    return updateBatch(batchId, (batch) => {
      const run = batch.runs.find((entry) => entry.id === runId);
      if (run) {
        updater(run, batch);
        markRunDirty(batchId, runId);
      }
    });
  }

  function subscribe(response: ServerResponse): () => void {
    subscribers.add(response);
    writeSse(response, "batches.snapshot", { batches: listSummaries() });

    return () => {
      subscribers.delete(response);
    };
  }

  async function deleteBatch(batchId: string): Promise<Batch | null> {
    const batch = batches.get(batchId);
    if (!batch) {
      return null;
    }

    batches.delete(batchId);
    pendingBatchBroadcasts.delete(batchId);
    dirtyBatches.delete(batchId);
    dirtyRuns.delete(batchId);
    schedulePersist();
    broadcastEvent("batch.deleted", { batchId });

    await queueStorageTask(async () => {
      try {
        await fs.rm(batchDir(batchId), { recursive: true, force: true });
      } catch (error) {
        console.error(`Failed to remove batch directory for ${batchId}`, error);
      }
    });

    return clone(batch);
  }

  return {
    load,
    listSummaries,
    getBatch,
    getMutableBatch,
    createBatch,
    updateBatch,
    appendRun,
    updateRun,
    deleteBatch,
    subscribe,
  };
}
