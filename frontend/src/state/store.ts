import { create } from "zustand";
import type { AppConfig, BatchSummary, Batch, ProjectContext, CodexModel, WorktreeInspection } from "../types.js";
import { getProjectPath, getPathLeaf } from "../utils/paths.js";
import { normalizeMode } from "../utils/format.js";

// --- Types ---
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface BrowserState {
  target: "project" | "worktree" | null;
  currentPath: string;
  parentPath: string | null;
  directories: { name: string; path: string }[];
}

export interface DeleteDialogState {
  batchId: string | null;
  removeWorktrees: boolean;
  preview: { worktreeCount: number; worktrees: WorktreeInspection[] } | null;
  loading: boolean;
  error: string;
  submitting: boolean;
  requestId: number;
}

export interface ModelCatalogState {
  loading: boolean;
  loaded: boolean;
  stale: boolean;
  fetchedAt: string | null;
  models: CodexModel[];
  error: string;
}

export interface Toast {
  id: string;
  type: "success" | "error" | "info";
  title: string;
  message?: string;
}

interface AppState {
  connectionStatus: ConnectionStatus;
  config: AppConfig | null;
  batches: BatchSummary[];
  batchDetails: Map<string, Batch>;
  selectedBatchId: string | null;
  selectedRunId: string | null;
  activeTab: string;
  drawerOpen: boolean;
  modelMenuOpen: boolean;
  projectFilters: string[];
  projectInspect: ProjectContext | null;
  browserState: BrowserState;
  browserDialogOpen: boolean;
  deleteDialog: DeleteDialogState;
  modelCatalog: ModelCatalogState;
  toasts: Toast[];

  addToast: (type: Toast["type"], title: string, message?: string) => string;
  removeToast: (id: string) => void;
  sortBatches: (list: BatchSummary[]) => BatchSummary[];
  upsertBatchSummary: (summary: BatchSummary) => void;
  removeBatchFromState: (batchId: string) => void;
  setBatchDetail: (batch: Batch) => void;
  normalizeProjectFilters: () => ReturnType<typeof getProjectFilterOptions>;
  syncSelectedBatch: () => void;
}

export function getProjectFilterOptions(batches: BatchSummary[]) {
  const projectPaths = Array.from(
    new Set(batches.map(getProjectPath).filter(Boolean)),
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

export const selectSelectedBatch = (s: AppState) =>
  s.selectedBatchId ? s.batchDetails.get(s.selectedBatchId) ?? null : null;

export const selectVisibleBatches = (s: AppState) => {
  if (s.projectFilters.length === 0) return s.batches;
  const activeSet = new Set(s.projectFilters);
  return s.batches.filter((b) => activeSet.has(getProjectPath(b)));
};

let toastCounter = 0;

export const useAppStore = create<AppState>((set, get) => ({
  connectionStatus: "connecting",
  config: null,
  batches: [],
  batchDetails: new Map(),
  selectedBatchId: null,
  selectedRunId: null,
  activeTab: "overview",
  drawerOpen: false,
  modelMenuOpen: false,
  projectFilters: [],
  projectInspect: null,
  browserState: {
    target: null,
    currentPath: "",
    parentPath: null,
    directories: [],
  },
  browserDialogOpen: false,
  deleteDialog: {
    batchId: null,
    removeWorktrees: false,
    preview: null,
    loading: false,
    error: "",
    submitting: false,
    requestId: 0,
  },
  modelCatalog: {
    loading: false,
    loaded: false,
    stale: false,
    fetchedAt: null,
    models: [],
    error: "",
  },
  toasts: [],

  addToast: (type, title, message) => {
    const id = String(++toastCounter);
    set((s) => ({ toasts: [...s.toasts, { id, type, title, message }] }));
    return id;
  },

  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  sortBatches: (list) => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),

  upsertBatchSummary: (summary) => {
    const { batches, sortBatches } = get();
    const idx = batches.findIndex((r) => r.id === summary.id);
    let next: BatchSummary[];
    if (idx >= 0) {
      next = [...batches];
      next[idx] = summary;
    } else {
      next = [...batches, summary];
    }
    set({ batches: sortBatches(next) });
  },

  removeBatchFromState: (batchId) => {
    const state = get();
    const newMap = new Map(state.batchDetails);
    newMap.delete(batchId);
    set({
      batches: state.batches.filter((b) => b.id !== batchId),
      batchDetails: newMap,
      ...(state.selectedBatchId === batchId
        ? { selectedBatchId: null, selectedRunId: null, activeTab: "overview" }
        : {}),
      ...(state.deleteDialog.batchId === batchId
        ? { deleteDialog: { ...state.deleteDialog, batchId: null } }
        : {}),
    });
    get().syncSelectedBatch();
  },

  setBatchDetail: (batch) => {
    const { batchDetails, upsertBatchSummary } = get();
    const newMap = new Map(batchDetails);
    newMap.set(batch.id, batch);
    set({ batchDetails: newMap });
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
  },

  normalizeProjectFilters: () => {
    const state = get();
    const options = getProjectFilterOptions(state.batches);
    const optionValues = new Set(options.map((o) => o.value));
    const normalized = Array.from(new Set(state.projectFilters)).filter((v) => optionValues.has(v));
    if (
      normalized.length !== state.projectFilters.length ||
      normalized.some((v, i) => v !== state.projectFilters[i])
    ) {
      set({ projectFilters: normalized });
    }
    return options;
  },

  syncSelectedBatch: () => {
    get().normalizeProjectFilters();
    const state = get();
    const visible = selectVisibleBatches(state);
    const isVisible = visible.some((b) => b.id === state.selectedBatchId);
    if (!isVisible) {
      set({ selectedBatchId: visible[0]?.id ?? null, selectedRunId: null, activeTab: "overview" });
    }
  },
}));
