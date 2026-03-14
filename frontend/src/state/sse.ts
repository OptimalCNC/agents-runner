import { useAppStore, selectVisibleBatches } from "./store.js";
import type { Batch, BatchSummary } from "../types.js";

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

  useAppStore.setState({ connectionStatus: "connecting" });
  const es = new EventSource("/events");
  eventSource = es;

  es.addEventListener("open", () => {
    useAppStore.setState({ connectionStatus: "connected" });
  });

  es.addEventListener("batches.snapshot", (event: MessageEvent) => {
    const payload = JSON.parse(event.data) as { batches: BatchSummary[] };
    const { sortBatches, syncSelectedBatch } = useAppStore.getState();
    useAppStore.setState({ batches: sortBatches(payload.batches) });
    syncSelectedBatch();
  });

  es.addEventListener("batch.updated", (event: MessageEvent) => {
    const payload = JSON.parse(event.data) as { summary: BatchSummary; batch: Omit<Batch, "runs"> };
    const { upsertBatchSummary, mergeBatchMeta, syncSelectedBatch } = useAppStore.getState();
    upsertBatchSummary(payload.summary);
    mergeBatchMeta(payload.summary.id, payload.batch);

    const state = useAppStore.getState();
    if (!state.selectedBatchId) {
      const visible = selectVisibleBatches(state);
      if (visible[0]) {
        useAppStore.setState({ selectedBatchId: visible[0].id });
      }
    }
    syncSelectedBatch();
  });

  es.addEventListener("run.updated", (event: MessageEvent) => {
    const payload = JSON.parse(event.data) as { batchId: string; summary: BatchSummary; run: Batch["runs"][number] };
    const { upsertRunInBatch, syncSelectedBatch } = useAppStore.getState();
    upsertRunInBatch(payload.batchId, payload.run, payload.summary);
    syncSelectedBatch();
  });

  es.addEventListener("batch.deleted", (event: MessageEvent) => {
    const payload = JSON.parse(event.data) as { batchId: string };
    useAppStore.getState().removeBatchFromState(payload.batchId);
  });

  es.addEventListener("error", () => {
    useAppStore.setState({ connectionStatus: "disconnected" });
    es.close();
    eventSource = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectEvents();
    }, 5000);
  });
}
