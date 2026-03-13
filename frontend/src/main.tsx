import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { connectEvents } from "./state/sse.js";
import { apiLoadConfig, apiLoadBatches } from "./state/api.js";
import { useAppStore } from "./state/store.js";
import { refreshCodexAuthValidation } from "./state/codexAuth.js";
import { apiLoadBatch } from "./state/api.js";
import "./styles/index.css";

async function init() {
  // Load config
  const cfgData = await apiLoadConfig();
  useAppStore.setState({ config: cfgData });
  void refreshCodexAuthValidation();

  // Load batches list
  const batchData = await apiLoadBatches();
  const { sortBatches, syncSelectedBatch } = useAppStore.getState();
  useAppStore.setState({ batches: sortBatches(batchData.batches) });
  syncSelectedBatch();

  // Load detail for selected batch
  const { selectedBatchId, batchDetails, setBatchDetail } = useAppStore.getState();
  if (selectedBatchId && !batchDetails.has(selectedBatchId)) {
    try {
      const detail = await apiLoadBatch(selectedBatchId);
      setBatchDetail(detail.batch);
      useAppStore.getState().syncSelectedBatch();
    } catch {
      // ignore
    }
  }

  // Connect SSE
  connectEvents();
}

createRoot(document.getElementById("app")!).render(<App />);

init().catch((err: unknown) => {
  console.error(err);
  useAppStore.getState().addToast("error", "Initialization failed", (err as Error).message);
});
