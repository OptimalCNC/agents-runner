import { signal, computed } from "@preact/signals";
import type { AppConfig, BatchSummary, Batch, ProjectContext, CodexModel } from "../types.js";
import { getProjectPath, getPathLeaf } from "../utils/paths.js";
import { normalizeMode } from "../utils/format.js";

// --- Connection ---
export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export const connectionStatus = signal<ConnectionStatus>("connecting");

// --- Config ---
export const config = signal<AppConfig | null>(null);

// --- Batches ---
export const batches = signal<BatchSummary[]>([]);
export const batchDetails = signal<Map<string, Batch>>(new Map());

// --- Selection ---
export const selectedBatchId = signal<string | null>(null);
export const selectedRunId = signal<string | null>(null);
export const activeTab = signal<string>("overview");

// --- Drawer ---
export const drawerOpen = signal(false);

// --- Model ---
export const modelMenuOpen = signal(false);

// --- Project Filters ---
export const projectFilters = signal<string[]>([]);

// --- Project Inspect (in drawer) ---
export const projectInspect = signal<ProjectContext | null>(null);

// --- Browser state ---
export interface BrowserState {
  target: "project" | "worktree" | null;
  currentPath: string;
  parentPath: string | null;
  directories: { name: string; path: string }[];
}
export const browserState = signal<BrowserState>({
  target: null,
  currentPath: "",
  parentPath: null,
  directories: [],
});
export const browserDialogOpen = signal(false);

// --- Delete Dialog ---
export interface DeleteDialogState {
  batchId: string | null;
  removeWorktrees: boolean;
  preview: { worktreeCount: number; worktrees: import("../types.js").WorktreeInspection[] } | null;
  loading: boolean;
  error: string;
  submitting: boolean;
  requestId: number;
}
export const deleteDialog = signal<DeleteDialogState>({
  batchId: null,
  removeWorktrees: false,
  preview: null,
  loading: false,
  error: "",
  submitting: false,
  requestId: 0,
});

// --- Model Catalog ---
export interface ModelCatalogState {
  loading: boolean;
  loaded: boolean;
  stale: boolean;
  fetchedAt: string | null;
  models: CodexModel[];
  error: string;
}
export const modelCatalog = signal<ModelCatalogState>({
  loading: false,
  loaded: false,
  stale: false,
  fetchedAt: null,
  models: [],
  error: "",
});

// --- Toasts ---
export interface Toast {
  id: string;
  type: "success" | "error" | "info";
  title: string;
  message?: string;
}
export const toasts = signal<Toast[]>([]);

let toastCounter = 0;
export function addToast(type: Toast["type"], title: string, message?: string) {
  const id = String(++toastCounter);
  toasts.value = [...toasts.value, { id, type, title, message }];
  return id;
}
export function removeToast(id: string) {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

// --- Computed ---
export const selectedBatch = computed(() => {
  const id = selectedBatchId.value;
  return id ? batchDetails.value.get(id) ?? null : null;
});

export function getProjectFilterOptions() {
  const projectPaths = Array.from(
    new Set(batches.value.map(getProjectPath).filter(Boolean)),
  ).sort((left, right) => {
    const byLeaf = getPathLeaf(left).localeCompare(getPathLeaf(right));
    return byLeaf || left.localeCompare(right);
  });

  const leafCounts = new Map<string, number>();
  for (const projectPath of projectPaths) {
    const leaf = getPathLeaf(projectPath) || projectPath;
    leafCounts.set(leaf, (leafCounts.get(leaf) || 0) + 1);
  }

  return projectPaths.map((projectPath) => {
    const leaf = getPathLeaf(projectPath) || projectPath;
    return {
      value: projectPath,
      label: leafCounts.get(leaf)! > 1 ? projectPath : leaf,
    };
  });
}

export const visibleBatches = computed(() => {
  const filters = projectFilters.value;
  if (filters.length === 0) return batches.value;
  const activeSet = new Set(filters);
  return batches.value.filter((b) => activeSet.has(getProjectPath(b)));
});

export function sortBatches(list: BatchSummary[]): BatchSummary[] {
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function upsertBatchSummary(summary: BatchSummary) {
  const current = batches.value;
  const idx = current.findIndex((r) => r.id === summary.id);
  let next: BatchSummary[];
  if (idx >= 0) {
    next = [...current];
    next[idx] = summary;
  } else {
    next = [...current, summary];
  }
  batches.value = sortBatches(next);
}

export function normalizeProjectFilters() {
  const options = getProjectFilterOptions();
  const optionValues = new Set(options.map((o) => o.value));
  const normalized = Array.from(new Set(projectFilters.value)).filter((v) => optionValues.has(v));
  if (normalized.length !== projectFilters.value.length || normalized.some((v, i) => v !== projectFilters.value[i])) {
    projectFilters.value = normalized;
  }
  return options;
}

export function syncSelectedBatch() {
  normalizeProjectFilters();
  const visible = visibleBatches.value;
  const isVisible = visible.some((b) => b.id === selectedBatchId.value);
  if (!isVisible) {
    selectedBatchId.value = visible[0]?.id ?? null;
    selectedRunId.value = null;
    activeTab.value = "overview";
  }
}

export function removeBatchFromState(batchId: string) {
  batches.value = batches.value.filter((b) => b.id !== batchId);
  const newMap = new Map(batchDetails.value);
  newMap.delete(batchId);
  batchDetails.value = newMap;

  if (selectedBatchId.value === batchId) {
    selectedBatchId.value = null;
    selectedRunId.value = null;
    activeTab.value = "overview";
  }

  if (deleteDialog.value.batchId === batchId) {
    deleteDialog.value = {
      ...deleteDialog.value,
      batchId: null,
    };
  }

  syncSelectedBatch();
}

export function setBatchDetail(batch: Batch) {
  const newMap = new Map(batchDetails.value);
  newMap.set(batch.id, batch);
  batchDetails.value = newMap;

  // Also update summary
  upsertBatchSummary({
    id: batch.id,
    mode: normalizeMode(batch.mode),
    title: batch.title,
    status: batch.status,
    createdAt: batch.createdAt,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
    cancelRequested: batch.cancelRequested,
    totalRuns: batch.runs.length,
    completedRuns: batch.runs.filter((r) => r.status === "completed").length,
    failedRuns: batch.runs.filter((r) => r.status === "failed").length,
    cancelledRuns: batch.runs.filter((r) => r.status === "cancelled").length,
    runningRuns: batch.runs.filter((r) => r.status === "running").length,
    queuedRuns: batch.runs.filter((r) => r.status === "queued").length,
    config: batch.config,
    generation: batch.generation,
  });
}
