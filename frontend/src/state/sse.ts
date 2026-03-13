import {
  batches,
  batchDetails,
  connectionStatus,
  selectedBatchId,
  sortBatches,
  upsertBatchSummary,
  removeBatchFromState,
  syncSelectedBatch,
  setBatchDetail,
  visibleBatches,
} from "./store.js";
import type { Batch, BatchSummary } from "../types.js";
import { normalizeMode } from "../utils/format.js";

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function connectEvents() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  connectionStatus.value = "connecting";
  const es = new EventSource("/events");
  eventSource = es;

  es.addEventListener("open", () => {
    connectionStatus.value = "connected";
  });

  es.addEventListener("batches.snapshot", (event: MessageEvent) => {
    const payload = JSON.parse(event.data) as { batches: BatchSummary[] };
    batches.value = sortBatches(payload.batches);
    syncSelectedBatch();
  });

  es.addEventListener("batch.updated", (event: MessageEvent) => {
    const payload = JSON.parse(event.data) as { summary: BatchSummary; batch: Batch };
    upsertBatchSummary(payload.summary);
    setBatchDetail(payload.batch);

    if (!selectedBatchId.value && visibleBatches.value[0]) {
      selectedBatchId.value = visibleBatches.value[0].id;
    }
    syncSelectedBatch();
  });

  es.addEventListener("batch.deleted", (event: MessageEvent) => {
    const payload = JSON.parse(event.data) as { batchId: string };
    removeBatchFromState(payload.batchId);
  });

  es.addEventListener("error", () => {
    connectionStatus.value = "disconnected";
    es.close();
    eventSource = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectEvents();
    }, 5000);
  });
}
