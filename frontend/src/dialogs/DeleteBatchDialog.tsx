import { useEffect, useRef } from "preact/hooks";
import {
  deleteDialog,
  batches,
  batchDetails,
  addToast,
  removeBatchFromState,
} from "../state/store.js";
import { apiDeleteBatch, apiGetDeletePreview } from "../state/api.js";
import { AlertIcon, FolderIcon } from "../icons.js";
import type { WorktreeInspection } from "../types.js";

function getBatchById(batchId: string | null) {
  if (!batchId) return null;
  return batches.value.find((b) => b.id === batchId) ?? batchDetails.value.get(batchId) ?? null;
}

function formatWorktreeCount(count: number) {
  return `${count} worktree${count === 1 ? "" : "s"}`;
}

function formatChangeCountLabel(entry: WorktreeInspection) {
  const totalLabel = `${entry.changeCount} change${entry.changeCount === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (entry.trackedChangeCount > 0) parts.push(`${entry.trackedChangeCount} tracked`);
  if (entry.untrackedChangeCount > 0) parts.push(`${entry.untrackedChangeCount} untracked`);
  return parts.length > 0 ? `${totalLabel} · ${parts.join(" · ")}` : totalLabel;
}

async function loadDeletePreview() {
  const state = deleteDialog.value;
  if (!state.batchId || !state.removeWorktrees) return;

  const requestId = state.requestId + 1;
  deleteDialog.value = { ...state, requestId, loading: true, error: "", preview: null };

  try {
    const payload = await apiGetDeletePreview(deleteDialog.value.batchId!);
    if (deleteDialog.value.requestId !== requestId || deleteDialog.value.batchId !== state.batchId) return;
    deleteDialog.value = { ...deleteDialog.value, loading: false, preview: payload.preview };
  } catch (err) {
    if (deleteDialog.value.requestId !== requestId || deleteDialog.value.batchId !== state.batchId) return;
    deleteDialog.value = { ...deleteDialog.value, loading: false, error: (err as Error).message };
  }
}

export async function openDeleteBatchDialog(batchId: string) {
  deleteDialog.value = {
    batchId,
    removeWorktrees: false,
    preview: null,
    loading: false,
    error: "",
    submitting: false,
    requestId: deleteDialog.value.requestId + 1,
  };
}

export function DeleteBatchDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const state = deleteDialog.value;
  const batch = getBatchById(state.batchId);
  const isOpen = Boolean(state.batchId);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  function handleClose() {
    deleteDialog.value = { ...deleteDialog.value, batchId: null };
  }

  async function handleRemoveWorktreesChange(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    deleteDialog.value = {
      ...deleteDialog.value,
      requestId: deleteDialog.value.requestId + 1,
      removeWorktrees: checked,
      preview: null,
      error: "",
      loading: false,
    };
    if (checked) {
      await loadDeletePreview();
    }
  }

  async function handleConfirm() {
    if (!batch || state.submitting) return;
    deleteDialog.value = { ...state, submitting: true };

    try {
      const payload = await apiDeleteBatch(state.batchId!, state.removeWorktrees);
      handleClose();
      removeBatchFromState(state.batchId!);

      const cleanupMessage = state.removeWorktrees
        ? payload.cleanup?.removedCount != null && payload.cleanup.removedCount > 0
          ? `${payload.cleanup.removedCount} ${payload.cleanup.removedCount === 1 ? "worktree" : "worktrees"} removed.`
          : "No associated worktrees to remove."
        : batch.title;

      addToast("success", "Batch removed", cleanupMessage);
    } catch (err) {
      const apiErr = err as { details?: { deletePreview?: unknown }; message: string };
      if (apiErr.details?.deletePreview) {
        deleteDialog.value = {
          ...deleteDialog.value,
          submitting: false,
          preview: apiErr.details.deletePreview as typeof state.preview,
        };
      } else {
        deleteDialog.value = { ...deleteDialog.value, submitting: false };
      }
      addToast("error", "Remove failed", apiErr.message);
    }
  }

  const isActive = batch?.status === "running" || batch?.status === "queued";
  const { removeWorktrees, preview, loading, error: reqError, submitting } = state;
  const canConfirm = Boolean(batch) && !submitting && (!removeWorktrees || (!loading && !reqError));

  // Hint and preview rendering
  let hintClass = "delete-dialog-hint";
  let hintText = "";
  let showPreview = false;
  let previewClass = "delete-dialog-preview";
  let previewContent: { title: string; summary: string; entries: WorktreeInspection[]; mode: "warning" | "clean" | "error" } | null = null;

  if (!removeWorktrees) {
    hintText = "Associated worktrees will stay on disk.";
  } else if (loading) {
    hintText = "Checking worktrees for uncommitted changes\u2026";
  } else if (reqError) {
    hintClass += " is-error";
    hintText = reqError;
  } else if (!preview) {
    hintText = "Check the associated worktrees before deleting them.";
  } else {
    const dirtyEntries = preview.worktrees.filter((e) => e.isDirty);
    const inspectFailures = preview.worktrees.filter((e) => e.error && !e.isDirty);

    if (preview.worktreeCount === 0) {
      hintText = "This batch does not have any associated worktrees yet.";
    } else if (dirtyEntries.length > 0) {
      hintClass += " is-warning";
      hintText = `${dirtyEntries.length} ${dirtyEntries.length === 1 ? "run has" : "runs have"} uncommitted changes. Removing worktrees will discard them.`;
      showPreview = true;
      previewClass += " is-warning";
      previewContent = {
        title: "Uncommitted Changes Detected",
        summary: `Checked ${formatWorktreeCount(preview.worktreeCount)}. The runs below still have local changes.`,
        entries: dirtyEntries,
        mode: "warning",
      };
    } else {
      hintText = `Checked ${formatWorktreeCount(preview.worktreeCount)}. No uncommitted changes detected.`;
      showPreview = true;
      previewContent = {
        title: "Checked Worktrees",
        summary: "These worktrees will be removed with the batch.",
        entries: preview.worktrees,
        mode: inspectFailures.length > 0 ? "error" : "clean",
      };
      if (inspectFailures.length > 0) {
        hintClass += " is-warning";
        previewClass += " is-error";
      }
    }
  }

  const confirmLabel = submitting
    ? "Deleting\u2026"
    : removeWorktrees && preview && preview.worktreeCount > 0
      ? `Delete Batch + ${formatWorktreeCount(preview.worktreeCount)}`
      : "Delete Batch";

  return (
    <dialog ref={dialogRef} class="dialog" onClose={handleClose}>
      <form method="dialog" class="dialog-shell delete-dialog-shell">
        <div class="dialog-header">
          <h3>{batch ? `Delete ${batch.title}` : "Delete Batch"}</h3>
          <button class="btn-icon" id="closeDeleteBatchButton" type="button" aria-label="Close" onClick={handleClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div class="delete-dialog-body">
          <p class="delete-dialog-copy">
            {batch
              ? isActive
                ? `Remove "${batch.title}"? Active runs will be cancelled.`
                : `Remove "${batch.title}"?`
              : "Remove this batch?"}
          </p>
          <label class={`delete-dialog-option${submitting ? " is-disabled" : ""}`}>
            <input
              type="checkbox"
              checked={removeWorktrees}
              disabled={submitting}
              onChange={handleRemoveWorktreesChange}
            />
            <span>Also remove all associated worktrees</span>
          </label>
          <div class={hintClass}>{hintText}</div>
          {showPreview && previewContent && (
            <div class={previewClass}>
              <div class="delete-dialog-preview-title">
                {previewContent.mode === "warning" || previewContent.mode === "error"
                  ? <AlertIcon />
                  : <FolderIcon />}
                {" "}{previewContent.title}
              </div>
              <div class="delete-dialog-preview-summary">{previewContent.summary}</div>
              <div class="delete-dialog-preview-list">
                {previewContent.entries.map((entry, i) => (
                  <div key={i} class="delete-dialog-preview-item">
                    <div class="delete-dialog-preview-item-header">
                      <div class="delete-dialog-preview-run">
                        {entry.runTitle || `Run ${Number(entry.runIndex ?? 0) + 1}`}
                      </div>
                      <div class="delete-dialog-preview-meta">
                        {previewContent!.mode === "warning"
                          ? formatChangeCountLabel(entry)
                          : previewContent!.mode === "error"
                            ? (entry.error || "Inspection failed.")
                            : (entry.exists ? "Clean" : "Missing")}
                      </div>
                    </div>
                    <div class="delete-dialog-preview-path">
                      {entry.worktreePath || "Worktree path unavailable"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div class="dialog-footer">
          <button class="btn btn-ghost" type="button" onClick={handleClose}>Cancel</button>
          <button
            class="btn btn-danger"
            type="button"
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
