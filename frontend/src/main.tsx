import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { apiLoadBatch, apiLoadBatches, apiLoadConfig } from "./state/api.js";
import { refreshCodexAuthValidation } from "./state/codexAuth.js";
import { loadUiPreferences, readNavigationSelectionFromLocation } from "./state/navigation.js";
import { connectEvents } from "./state/sse.js";
import { useAppStore } from "./state/store.js";
import "./styles/index.css";

const pendingBatchLoads = new Set<string>();

async function ensureSelectedBatchDetailLoaded(batchId: string | null): Promise<void> {
  if (!batchId || pendingBatchLoads.has(batchId)) {
    return;
  }

  const state = useAppStore.getState();
  if (state.batchDetails.has(batchId)) {
    return;
  }

  pendingBatchLoads.add(batchId);
  try {
    const detail = await apiLoadBatch(batchId);
    useAppStore.getState().setBatchDetail(detail.batch);
  } catch {
    // Ignore stale or missing batch detail fetches; reconciliation will
    // fall back once the batch list is available.
  } finally {
    pendingBatchLoads.delete(batchId);
    const nextState = useAppStore.getState();
    if (nextState.selectedBatchId === batchId && (nextState.batches.length > 0 || nextState.batchDetails.has(batchId))) {
      nextState.reconcileSelection();
    }
  }
}

function registerNavigationEffects(): void {
  useAppStore.subscribe((state, previousState) => {
    const selectedBatchId = state.selectedBatchId;
    const batchChanged = selectedBatchId !== previousState.selectedBatchId;
    const selectedBatchMissing = selectedBatchId ? !state.batchDetails.has(selectedBatchId) : false;

    if (selectedBatchId && selectedBatchMissing && (batchChanged || previousState.batchDetails !== state.batchDetails)) {
      void ensureSelectedBatchDetailLoaded(selectedBatchId);
    }
  });

  if (typeof window !== "undefined") {
    window.addEventListener("popstate", () => {
      const store = useAppStore.getState();
      store.hydrateNavigationState(readNavigationSelectionFromLocation());
      store.reconcileSelection({ preferSelectedBatchVisible: true });
    });
  }
}

async function init() {
  registerNavigationEffects();
  useAppStore.getState().hydrateNavigationState({
    ...readNavigationSelectionFromLocation(),
    ...loadUiPreferences(),
  });

  const cfgData = await apiLoadConfig();
  useAppStore.setState({ config: cfgData });
  void refreshCodexAuthValidation();

  const batchData = await apiLoadBatches();
  const { sortBatches, reconcileSelection } = useAppStore.getState();
  useAppStore.setState({ batches: sortBatches(batchData.batches) });
  reconcileSelection({ preferSelectedBatchVisible: true });

  const { selectedBatchId } = useAppStore.getState();
  void ensureSelectedBatchDetailLoaded(selectedBatchId);

  connectEvents();
}

createRoot(document.getElementById("app")!).render(<App />);

init().catch((err: unknown) => {
  console.error(err);
  useAppStore.getState().addToast("error", "Initialization failed", (err as Error).message);
});
