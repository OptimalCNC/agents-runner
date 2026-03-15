import type { Batch, BatchSummary } from "../types.js";
import { getProjectPath } from "../utils/paths.js";

const UI_PREFERENCES_STORAGE_KEY = "agents-runner:ui-prefs:v1";

export const RUN_DETAIL_TABS = ["session", "review"] as const;
export type RunDetailTab = (typeof RUN_DETAIL_TABS)[number];

export interface NavigationSelectionState {
  selectedBatchId: string | null;
  selectedRunId: string | null;
  activeTab: RunDetailTab;
}

export interface UiPreferencesState {
  projectFilters: string[];
}

export interface NavigationState extends NavigationSelectionState, UiPreferencesState {}

export interface ReconcileNavigationInput extends NavigationState {
  batches: BatchSummary[];
  batchDetails: Map<string, Batch>;
}

function normalizeId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function getStorage(storage?: Storage | null): Storage | null {
  if (storage !== undefined) {
    return storage;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function normalizeRunDetailTab(value: unknown): RunDetailTab {
  const normalized = String(value ?? "").trim().toLowerCase();
  return RUN_DETAIL_TABS.includes(normalized as RunDetailTab)
    ? normalized as RunDetailTab
    : "session";
}

export function parseNavigationSelection(search: string): NavigationSelectionState {
  const normalizedSearch = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(normalizedSearch);

  return {
    selectedBatchId: normalizeId(params.get("batch")),
    selectedRunId: normalizeId(params.get("run")),
    activeTab: normalizeRunDetailTab(params.get("tab")),
  };
}

export function readNavigationSelectionFromLocation(
  locationLike?: Pick<Location, "search">,
): NavigationSelectionState {
  const search = locationLike?.search ?? (typeof window === "undefined" ? "" : window.location.search);
  return parseNavigationSelection(search);
}

export function buildNavigationSearch(state: NavigationSelectionState): string {
  const params = new URLSearchParams();

  if (state.selectedBatchId) {
    params.set("batch", state.selectedBatchId);
  }

  if (state.selectedBatchId && state.selectedRunId) {
    params.set("run", state.selectedRunId);
  }

  if (state.selectedBatchId && state.activeTab !== "session") {
    params.set("tab", state.activeTab);
  }

  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : "";
}

export function syncNavigationSelectionToLocation(
  state: NavigationSelectionState,
  locationLike?: Pick<Location, "pathname" | "search" | "hash">,
  historyLike?: Pick<History, "replaceState" | "state">,
): void {
  const targetLocation = locationLike ?? (typeof window === "undefined" ? null : window.location);
  const targetHistory = historyLike ?? (typeof window === "undefined" ? null : window.history);

  if (!targetLocation || !targetHistory) {
    return;
  }

  const nextSearch = buildNavigationSearch(state);
  if (nextSearch === targetLocation.search) {
    return;
  }

  const nextUrl = `${targetLocation.pathname}${nextSearch}${targetLocation.hash || ""}`;
  targetHistory.replaceState(targetHistory.state, "", nextUrl);
}

export function normalizeProjectFilters(filters: readonly string[], batches: readonly BatchSummary[]): string[] {
  const availableProjectPaths = new Set(batches.map(getProjectPath));

  return Array.from(new Set(
    filters
      .map((filterValue) => String(filterValue ?? "").trim())
      .filter(Boolean),
  )).filter((filterValue) => availableProjectPaths.has(filterValue));
}

export function ensureSelectedBatchVisibleInFilters(
  filters: readonly string[],
  batches: readonly BatchSummary[],
  selectedBatchId: string | null,
): string[] {
  const normalized = normalizeProjectFilters(filters, batches);
  if (!selectedBatchId || normalized.length === 0) {
    return normalized;
  }

  const selectedBatch = batches.find((batch) => batch.id === selectedBatchId);
  if (!selectedBatch) {
    return normalized;
  }

  const selectedProjectPath = getProjectPath(selectedBatch);
  return normalized.includes(selectedProjectPath)
    ? normalized
    : [...normalized, selectedProjectPath];
}

export function loadUiPreferences(storage?: Storage | null): UiPreferencesState {
  const targetStorage = getStorage(storage);
  if (!targetStorage) {
    return { projectFilters: [] };
  }

  try {
    const raw = targetStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return { projectFilters: [] };
    }

    const parsed = JSON.parse(raw) as { projectFilters?: unknown };
    return {
      projectFilters: Array.isArray(parsed?.projectFilters)
        ? parsed.projectFilters.map((entry) => String(entry ?? "").trim()).filter(Boolean)
        : [],
    };
  } catch {
    return { projectFilters: [] };
  }
}

export function saveUiPreferences(preferences: UiPreferencesState, storage?: Storage | null): void {
  const targetStorage = getStorage(storage);
  if (!targetStorage) {
    return;
  }

  try {
    targetStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({
      projectFilters: preferences.projectFilters,
    }));
  } catch {
    // Ignore storage write failures so navigation still works.
  }
}

export function reconcileNavigationState(input: ReconcileNavigationInput): NavigationState {
  const requestedBatchId = normalizeId(input.selectedBatchId);
  const normalizedFilters = normalizeProjectFilters(input.projectFilters, input.batches);
  const visibleBatches = normalizedFilters.length === 0
    ? input.batches
    : input.batches.filter((batch) => normalizedFilters.includes(getProjectPath(batch)));

  const selectedBatchId = requestedBatchId && visibleBatches.some((batch) => batch.id === requestedBatchId)
    ? requestedBatchId
    : (visibleBatches[0]?.id ?? null);

  let selectedRunId = normalizeId(input.selectedRunId);
  if (!selectedBatchId) {
    selectedRunId = null;
  } else if (selectedBatchId !== requestedBatchId) {
    const fallbackBatch = input.batchDetails.get(selectedBatchId);
    selectedRunId = fallbackBatch?.runs[0]?.id ?? null;
  } else {
    const selectedBatch = input.batchDetails.get(selectedBatchId);
    if (selectedBatch) {
      selectedRunId = selectedBatch.runs.some((run) => run.id === selectedRunId)
        ? selectedRunId
        : (selectedBatch.runs[0]?.id ?? null);
    }
  }

  return {
    selectedBatchId,
    selectedRunId,
    activeTab: normalizeRunDetailTab(input.activeTab),
    projectFilters: normalizedFilters,
  };
}
