import { create } from "zustand";

import type { AppConfig, BatchSummary, Batch, BatchDeletePreview, ProjectContext, CodexModel } from "../types.js";
import { normalizeMode } from "../utils/format.js";
import { buildProjectPathOptions, getProjectPath } from "../utils/paths.js";
import {
  type NavigationState,
  type RunDetailTab,
  ensureSelectedBatchVisibleInFilters,
  reconcileNavigationState,
  saveUiPreferences,
  syncNavigationSelectionToLocation,
} from "./navigation.js";

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
  selectedBranches: string[];
  preview: BatchDeletePreview | null;
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
  activeTab: RunDetailTab;
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
  mergeBatchMeta: (batchId: string, batch: Omit<Batch, "runs">) => void;
  upsertRunInBatch: (batchId: string, run: Batch["runs"][number], summary?: BatchSummary) => void;
  hydrateNavigationState: (state: Partial<NavigationState>) => void;
  selectBatch: (batchId: string | null) => void;
  selectRun: (runId: string | null) => void;
  selectTab: (tab: RunDetailTab) => void;
  setProjectFilters: (filters: string[]) => void;
  reconcileSelection: (options?: { preferSelectedBatchVisible?: boolean }) => void;
}

function buildBatchSummary(batch: Batch): BatchSummary {
  return {
    id: batch.id,
    mode: normalizeMode(batch.mode),
    title: batch.title,
    status: batch.status,
    createdAt: batch.createdAt,
    startedAt: batch.startedAt,
    completedAt: batch.completedAt,
    cancelRequested: batch.cancelRequested,
    totalRuns: batch.runs.length,
    completedRuns: batch.runs.filter((run) => run.status === "completed").length,
    failedRuns: batch.runs.filter((run) => run.status === "failed").length,
    cancelledRuns: batch.runs.filter((run) => run.status === "cancelled").length,
    preparingRuns: batch.runs.filter((run) => run.status === "preparing").length,
    waitingForCodexRuns: batch.runs.filter((run) => run.status === "waiting_for_codex").length,
    runningRuns: batch.runs.filter((run) => run.status === "running").length,
    queuedRuns: batch.runs.filter((run) => run.status === "queued").length,
    config: batch.config,
    generation: batch.generation,
  };
}

function normalizeFilterList(filters: readonly string[]): string[] {
  return Array.from(new Set(
    filters
      .map((filterValue) => String(filterValue ?? "").trim())
      .filter(Boolean),
  ));
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function buildPersistedUiState(
  state: Pick<AppState, "selectedBatchId" | "selectedRunId" | "activeTab" | "projectFilters">,
): NavigationState {
  return {
    selectedBatchId: state.selectedBatchId,
    selectedRunId: state.selectedRunId,
    activeTab: state.activeTab,
    projectFilters: state.projectFilters,
  };
}

function syncPersistedUiState(
  state: Pick<AppState, "selectedBatchId" | "selectedRunId" | "activeTab" | "projectFilters">,
): void {
  syncNavigationSelectionToLocation({
    selectedBatchId: state.selectedBatchId,
    selectedRunId: state.selectedRunId,
    activeTab: state.activeTab,
  });
  saveUiPreferences({ projectFilters: state.projectFilters });
}

export function getProjectFilterOptions(batches: BatchSummary[]) {
  return buildProjectPathOptions(batches.map(getProjectPath));
}

export const selectSelectedBatch = (state: AppState) =>
  state.selectedBatchId ? state.batchDetails.get(state.selectedBatchId) ?? null : null;

export const selectVisibleBatches = (state: AppState) => {
  if (state.projectFilters.length === 0) {
    return state.batches;
  }

  const activeSet = new Set(state.projectFilters);
  return state.batches.filter((batch) => activeSet.has(getProjectPath(batch)));
};

let toastCounter = 0;

export const useAppStore = create<AppState>((set, get) => ({
  connectionStatus: "connecting",
  config: null,
  batches: [],
  batchDetails: new Map(),
  selectedBatchId: null,
  selectedRunId: null,
  activeTab: "session",
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
    selectedBranches: [],
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
    set((state) => ({ toasts: [...state.toasts, { id, type, title, message }] }));
    return id;
  },

  removeToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  sortBatches: (list) => [...list].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),

  upsertBatchSummary: (summary) => {
    const { batches, sortBatches } = get();
    const existingIndex = batches.findIndex((batch) => batch.id === summary.id);
    const nextBatches = existingIndex >= 0
      ? batches.map((batch, index) => (index === existingIndex ? summary : batch))
      : [...batches, summary];
    set({ batches: sortBatches(nextBatches) });
  },

  removeBatchFromState: (batchId) => {
    const state = get();
    const nextBatchDetails = new Map(state.batchDetails);
    nextBatchDetails.delete(batchId);

    set({
      batches: state.batches.filter((batch) => batch.id !== batchId),
      batchDetails: nextBatchDetails,
      ...(state.deleteDialog.batchId === batchId
        ? { deleteDialog: { ...state.deleteDialog, batchId: null } }
        : {}),
    });
    get().reconcileSelection();
  },

  setBatchDetail: (batch) => {
    const { batchDetails, upsertBatchSummary } = get();
    const nextBatchDetails = new Map(batchDetails);
    nextBatchDetails.set(batch.id, batch);
    set({ batchDetails: nextBatchDetails });
    upsertBatchSummary(buildBatchSummary(batch));
  },

  mergeBatchMeta: (batchId, batchMeta) => {
    const { batchDetails, upsertBatchSummary } = get();
    const existing = batchDetails.get(batchId);
    if (!existing) {
      return;
    }

    const merged: Batch = {
      ...existing,
      ...batchMeta,
      runs: existing.runs,
    };

    const nextBatchDetails = new Map(batchDetails);
    nextBatchDetails.set(batchId, merged);
    set({ batchDetails: nextBatchDetails });
    upsertBatchSummary(buildBatchSummary(merged));
  },

  upsertRunInBatch: (batchId, run, summary) => {
    const { batchDetails, upsertBatchSummary } = get();
    const existing = batchDetails.get(batchId);

    if (!existing) {
      if (summary) {
        upsertBatchSummary(summary);
      }
      return;
    }

    const runIndex = existing.runs.findIndex((entry) => entry.id === run.id);
    const nextRuns = runIndex >= 0
      ? existing.runs.map((entry) => (entry.id === run.id ? run : entry))
      : [...existing.runs, run].sort((left, right) => left.index - right.index);

    const merged: Batch = {
      ...existing,
      runs: nextRuns,
    };

    const nextBatchDetails = new Map(batchDetails);
    nextBatchDetails.set(batchId, merged);
    set({ batchDetails: nextBatchDetails });
    upsertBatchSummary(summary ?? buildBatchSummary(merged));
  },

  hydrateNavigationState: (navigationState) => {
    set((state) => ({
      ...(navigationState.selectedBatchId !== undefined ? { selectedBatchId: navigationState.selectedBatchId } : {}),
      ...(navigationState.selectedRunId !== undefined ? { selectedRunId: navigationState.selectedRunId } : {}),
      ...(navigationState.activeTab !== undefined ? { activeTab: navigationState.activeTab } : {}),
      ...(navigationState.projectFilters !== undefined
        ? { projectFilters: normalizeFilterList(navigationState.projectFilters) }
        : {}),
    }));
  },

  selectBatch: (batchId) => {
    const normalizedBatchId = String(batchId ?? "").trim() || null;
    if (get().selectedBatchId === normalizedBatchId) {
      return;
    }

    set({
      selectedBatchId: normalizedBatchId,
      selectedRunId: null,
    });
    get().reconcileSelection();
  },

  selectRun: (runId) => {
    const normalizedRunId = String(runId ?? "").trim() || null;
    if (get().selectedRunId === normalizedRunId) {
      return;
    }

    set({ selectedRunId: normalizedRunId });
    get().reconcileSelection();
  },

  selectTab: (tab) => {
    if (get().activeTab === tab) {
      return;
    }

    set({ activeTab: tab });
    syncPersistedUiState(get());
  },

  setProjectFilters: (filters) => {
    set({ projectFilters: normalizeFilterList(filters) });
    get().reconcileSelection();
  },

  reconcileSelection: (options) => {
    const state = get();
    const nextProjectFilters = options?.preferSelectedBatchVisible
      ? ensureSelectedBatchVisibleInFilters(state.projectFilters, state.batches, state.selectedBatchId)
      : state.projectFilters;
    const reconciled = reconcileNavigationState({
      ...buildPersistedUiState({
        selectedBatchId: state.selectedBatchId,
        selectedRunId: state.selectedRunId,
        activeTab: state.activeTab,
        projectFilters: nextProjectFilters,
      }),
      batches: state.batches,
      batchDetails: state.batchDetails,
    });

    if (
      state.selectedBatchId !== reconciled.selectedBatchId
      || state.selectedRunId !== reconciled.selectedRunId
      || state.activeTab !== reconciled.activeTab
      || !sameStringArray(state.projectFilters, reconciled.projectFilters)
    ) {
      set({
        selectedBatchId: reconciled.selectedBatchId,
        selectedRunId: reconciled.selectedRunId,
        activeTab: reconciled.activeTab,
        projectFilters: reconciled.projectFilters,
      });
    }

    syncPersistedUiState(reconciled);
  },
}));
