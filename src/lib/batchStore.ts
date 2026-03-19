import fs from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";

import { hasStrongLatestTurnCompletionEvidence, isTransientStreamWarningMessage } from "./runCompletion";
import { isRunActiveStatus, isRunPendingStatus, isRunTerminalStatus } from "./runStatus";
import { getWorkflow } from "./workflows/registry";
import { extractReviewerScoreFromMcp, normalizeMode } from "./workflows/shared";

import type {
  Batch,
  BatchConfig,
  BatchMode,
  BatchStatus,
  BatchStore,
  BatchSummary,
  GenerationState,
  Run,
  RunLog,
  RunTurn,
  RunUsage,
} from "../types";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function nowIso(): string {
  return new Date().toISOString();
}

const SHORT_BATCH_ID_LENGTH = 5;

export function createBatchId(existingBatchIds: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const candidate = Math.floor(Math.random() * (36 ** SHORT_BATCH_ID_LENGTH))
      .toString(36)
      .padStart(SHORT_BATCH_ID_LENGTH, "0");

    if (!existingBatchIds.has(candidate)) {
      return candidate;
    }
  }

  while (true) {
    const candidate = `${Date.now().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`
      .slice(-SHORT_BATCH_ID_LENGTH)
      .padStart(SHORT_BATCH_ID_LENGTH, "0");

    if (!existingBatchIds.has(candidate)) {
      return candidate;
    }
  }
}

function normalizeLoadedLog(log: RunLog, runId: string, index: number): RunLog {
  const nextLog = clone(log);
  nextLog.id = typeof nextLog.id === "string" && nextLog.id.trim()
    ? nextLog.id
    : `log-legacy-${runId}-${index.toString(36)}`;
  nextLog.at = String(nextLog.at ?? "");
  nextLog.level = String(nextLog.level ?? "info");
  nextLog.message = String(nextLog.message ?? "");
  return nextLog;
}

function sortBatches(batches: BatchSummary[]): BatchSummary[] {
  return batches.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function buildBatchMeta(batch: Batch): Omit<Batch, "runs"> {
  const { runs, ...batchMeta } = clone(batch);
  return batchMeta;
}

function getLatestRunTurn(run: Run): RunTurn | null {
  return run.turns.at(-1) ?? null;
}

function mergeUsage(left: RunUsage | null, right: RunUsage | null): RunUsage | null {
  if (!left && !right) {
    return null;
  }

  return {
    input_tokens: Number(left?.input_tokens ?? 0) + Number(right?.input_tokens ?? 0),
    output_tokens: Number(left?.output_tokens ?? 0) + Number(right?.output_tokens ?? 0),
    total_tokens:
      (left?.total_tokens != null || right?.total_tokens != null)
        ? Number(left?.total_tokens ?? 0) + Number(right?.total_tokens ?? 0)
        : undefined,
  };
}

function aggregateRunUsage(turns: RunTurn[]): RunUsage | null {
  return turns.reduce<RunUsage | null>((acc, turn) => mergeUsage(acc, turn.usage), null);
}

function getLatestTurnResponse(turns: RunTurn[]): string {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].finalResponse) {
      return turns[index].finalResponse;
    }
  }

  return "";
}

function syncRunDerivedState(run: Run): void {
  const latestTurn = getLatestRunTurn(run);
  run.status = latestTurn?.status ?? run.status;
  run.completedAt = latestTurn?.completedAt ?? null;
  run.error = latestTurn?.error ?? null;
  run.finalResponse = getLatestTurnResponse(run.turns);
  run.usage = aggregateRunUsage(run.turns);
  run.items = run.turns.flatMap((turn) =>
    (turn.items || []).map((item) => ({
      ...item,
      id: `${turn.id}:${item.id}`,
    })),
  );

  const firstStartedAt = run.turns.find((turn) => turn.startedAt)?.startedAt ?? null;
  if (!run.startedAt && firstStartedAt) {
    run.startedAt = firstStartedAt;
  }
}

function getReadyQueuedRunIds(batch: Batch): string[] {
  if (batch.cancelRequested) {
    return [];
  }

  const workflow = getWorkflow(batch.mode);
  return batch.runs
    .filter((run) => run.status === "queued" && workflow.isRunReady(batch, run))
    .map((run) => run.id);
}

function deriveBatchStatus(batch: Batch): BatchStatus {
  if (batch.cancelRequested) {
    return batch.runs.every((run) => isRunTerminalStatus(run.status)) ? "cancelled" : "running";
  }

  if (batch.runs.some((run) => isRunActiveStatus(run.status))) {
    return "running";
  }

  if (getReadyQueuedRunIds(batch).length > 0) {
    return "running";
  }

  if (getWorkflow(batch.mode).getBlockingRunIds(batch).length > 0) {
    return "blocked";
  }

  if (batch.runs.some((run) => run.status === "failed")) {
    return "failed";
  }

  if (batch.startedAt && batch.status === "failed" && batch.runs.length === 0) {
    return "failed";
  }

  if (batch.runs.length === 0) {
    return batch.startedAt ? "running" : "queued";
  }

  return "completed";
}

function reconcileTerminalRun(run: Run, batch: Batch): void {
  const latestTurn = getLatestRunTurn(run);
  if (!latestTurn) {
    return;
  }

  const inferredCompletedAt = latestTurn.completedAt
    || run.completedAt
    || batch.completedAt
    || run.logs.at(-1)?.at
    || latestTurn.startedAt
    || batch.startedAt
    || nowIso();

  if (hasStrongLatestTurnCompletionEvidence(run)) {
    latestTurn.status = "completed";
    latestTurn.completedAt ||= inferredCompletedAt;
    latestTurn.error = null;
    return;
  }

  if (batch.status === "cancelled" || batch.cancelRequested) {
    latestTurn.status = "cancelled";
    latestTurn.completedAt ||= inferredCompletedAt;
    latestTurn.error ||= "Batch cancelled.";
    return;
  }

  if (latestTurn.status === "queued" && run.status === "queued") {
    return;
  }

  if (!isRunTerminalStatus(latestTurn.status)) {
    latestTurn.status = "failed";
    latestTurn.completedAt ||= inferredCompletedAt;
    latestTurn.error ||= batch.error || "Run ended without reaching a terminal state.";
    return;
  }

  if (latestTurn.status === "failed" && isTransientStreamWarningMessage(latestTurn.error)) {
    latestTurn.completedAt ||= inferredCompletedAt;
    latestTurn.error = batch.error || "Run ended without reaching a terminal state.";
  }
}

function recomputeRankedScores(batch: Batch): void {
  if (batch.mode !== "ranked") {
    return;
  }

  const scoreMap = new Map<string, number[]>();
  const reviewerScoreMap = new Map<string, number>();

  for (const reviewRun of batch.runs.filter((run) => run.kind === "reviewer")) {
    const reviewedRunId = String(reviewRun.reviewedRunId ?? "").trim();
    if (!reviewedRunId) {
      continue;
    }

    const score = extractReviewerScoreFromMcp(reviewRun);
    if (score === null) {
      continue;
    }

    reviewerScoreMap.set(reviewRun.id, score);
    if (!scoreMap.has(reviewedRunId)) {
      scoreMap.set(reviewedRunId, []);
    }
    scoreMap.get(reviewedRunId)!.push(score);
  }

  for (const run of batch.runs) {
    if (run.kind === "reviewer") {
      run.score = reviewerScoreMap.get(run.id) ?? null;
    }
  }

  const candidateRuns = batch.runs.filter((run) => run.kind !== "reviewer");
  for (const run of candidateRuns) {
    const values = scoreMap.get(run.id) || [];
    run.score = values.length > 0
      ? Number((values.reduce((acc, value) => acc + value, 0) / values.length).toFixed(2))
      : null;
    run.rank = null;
  }

  const rankedRuns = candidateRuns
    .filter((run) => run.score !== null)
    .sort((left, right) => Number(right.score) - Number(left.score));

  for (const [index, run] of rankedRuns.entries()) {
    run.rank = index + 1;
  }
}

function normalizeLoadedRun(run: Run): Run {
  const nextRun = clone(run);

  if (!Array.isArray(nextRun.turns) || nextRun.turns.length === 0) {
    nextRun.turns = [{
      id: `turn-legacy-${nextRun.id}`,
      index: 0,
      prompt: nextRun.prompt,
      status: nextRun.status,
      submittedAt: nextRun.startedAt || nextRun.completedAt || new Date().toISOString(),
      startedAt: nextRun.startedAt,
      completedAt: nextRun.completedAt,
      finalResponse: nextRun.finalResponse,
      error: nextRun.error,
      usage: nextRun.usage,
      items: Array.isArray(nextRun.items) ? nextRun.items : [],
    }];
  }

  nextRun.logs = Array.isArray(nextRun.logs)
    ? nextRun.logs.map((log, index) => normalizeLoadedLog(log, nextRun.id, index))
    : [];

  nextRun.items = nextRun.turns.flatMap((turn) =>
    (turn.items || []).map((item) => ({
      ...item,
      id: `${turn.id}:${item.id}`,
    })),
  );

  return nextRun;
}

function normalizeLoadedBatch(batch: Batch): void {
  for (const run of batch.runs) {
    reconcileTerminalRun(run, batch);
    syncRunDerivedState(run);
  }

  recomputeRankedScores(batch);
  batch.status = deriveBatchStatus(batch);
  if (batch.status !== "failed" && batch.status !== "cancelled") {
    batch.error = null;
  }

  if (batch.status === "completed" && !batch.completedAt) {
    batch.completedAt = batch.runs.map((run) => run.completedAt).filter(Boolean).sort().at(-1) ?? nowIso();
  }
}

function buildSummary(batch: Batch): BatchSummary {
  const completedRuns = batch.runs.filter((run) => run.status === "completed").length;
  const failedRuns = batch.runs.filter((run) => run.status === "failed").length;
  const cancelledRuns = batch.runs.filter((run) => run.status === "cancelled").length;
  const preparingRuns = batch.runs.filter((run) => run.status === "preparing").length;
  const waitingForCodexRuns = batch.runs.filter((run) => run.status === "waiting_for_codex").length;
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
    preparingRuns,
    waitingForCodexRuns,
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

      const summary = buildSummary(batch);
      const batchPayload = {
        summary,
        batch: buildBatchMeta(batch),
      };
      const dirtyRunIds = Array.from(dirtyRuns.get(batchId) ?? []);

      for (const response of subscribers) {
        writeSse(response, "batch.updated", batchPayload);

        for (const runId of dirtyRunIds) {
          const run = batch.runs.find((entry) => entry.id === runId);
          if (!run) {
            continue;
          }

          writeSse(response, "run.updated", {
            batchId,
            summary,
            run: clone(run),
          });
        }
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
    let shouldPersistNormalizedData = false;

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
            runs.push(normalizeLoadedRun(run));
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
      const loadedStatus = batch.status;

      if (loadedStatus === "running" || loadedStatus === "queued") {
        batch.status = "failed";
        batch.completedAt = nowIso();
        batch.error = "Interrupted by server restart.";

        for (const run of batch.runs) {
          if (isRunPendingStatus(run.status)) {
            run.status = "failed";
            run.completedAt = nowIso();
            run.error = "Interrupted by server restart.";
          }
        }
      }

      normalizeLoadedBatch(batch);
      batches.set(batch.id, batch);
      shouldPersistNormalizedData = true;
      dirtyBatches.add(batch.id);
      dirtyRuns.set(batch.id, new Set(batch.runs.map((run) => run.id)));
    }

    if (shouldPersistNormalizedData) {
      schedulePersist();
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
    const id = createBatchId(new Set(batches.keys()));
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
      generation: getWorkflow(mode).buildInitialBatchState().generation,
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
