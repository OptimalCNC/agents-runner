import { render } from "preact";
import { App } from "./App.js";
import { connectEvents } from "./state/sse.js";
import { apiLoadConfig, apiLoadBatches } from "./state/api.js";
import {
  config,
  batches,
  sortBatches,
  syncSelectedBatch,
  addToast,
  setBatchDetail,
  selectedBatchId,
  batchDetails,
} from "./state/store.js";
import { refreshCodexAuthValidation } from "./state/codexAuth.js";
import { apiLoadBatch } from "./state/api.js";
import "./styles/index.css";

async function init() {
  // Load config
  const cfgData = await apiLoadConfig();
  config.value = cfgData;
  void refreshCodexAuthValidation();

  // Load batches list
  const batchData = await apiLoadBatches();
  batches.value = sortBatches(batchData.batches);
  syncSelectedBatch();

  // Load detail for selected batch
  if (selectedBatchId.value && !batchDetails.value.has(selectedBatchId.value)) {
    try {
      const detail = await apiLoadBatch(selectedBatchId.value);
      setBatchDetail(detail.batch);
      syncSelectedBatch();
    } catch {
      // ignore
    }
  }

  // Connect SSE
  connectEvents();
}

render(<App />, document.getElementById("app")!);

init().catch((err: unknown) => {
  console.error(err);
  addToast("error", "Initialization failed", (err as Error).message);
});
