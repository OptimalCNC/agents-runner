import { useEffect, useRef, type ChangeEvent } from "react";

import { useAppStore } from "../state/store.js";
import { apiDeleteBatch, apiGetDeletePreview } from "../state/api.js";
import { AlertIcon, FolderIcon, GitIcon } from "../icons.js";

import type { BatchDeleteBranchPreviewEntry, BatchDeleteWorktreePreviewEntry } from "../types.js";

function formatCount(count: number, singular: string, plural: string = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatWorktreeCount(count: number) {
  return formatCount(count, "worktree");
}

function formatBranchCount(count: number) {
  return formatCount(count, "branch");
}

function formatChangeCountLabel(entry: BatchDeleteWorktreePreviewEntry) {
  const totalLabel = `${entry.changeCount} change${entry.changeCount === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (entry.trackedChangeCount > 0) parts.push(`${entry.trackedChangeCount} tracked`);
  if (entry.untrackedChangeCount > 0) parts.push(`${entry.untrackedChangeCount} untracked`);
  return parts.length > 0 ? `${totalLabel} · ${parts.join(" · ")}` : totalLabel;
}

function formatCommitCount(count: number) {
  return formatCount(count, "commit");
}

function buildBranchMeta(entry: BatchDeleteBranchPreviewEntry) {
  if (!entry.exists) {
    return "Already missing";
  }

  if (!entry.canDelete) {
    return "Preserved";
  }

  if (entry.safeToDelete) {
    return entry.comparisonRef ? `Safe vs ${entry.comparisonRef}` : "Safe";
  }

  if (typeof entry.aheadCount === "number" && entry.aheadCount > 0) {
    return `${formatCommitCount(entry.aheadCount)} ahead`;
  }

  if (entry.requiresForce) {
    return "Needs explicit force delete";
  }

  return "Preserved";
}

async function loadDeletePreview() {
  const state = useAppStore.getState().deleteDialog;
  if (!state.batchId || !state.removeWorktrees) return;

  const requestId = state.requestId + 1;
  useAppStore.setState({
    deleteDialog: {
      ...state,
      requestId,
      loading: true,
      error: "",
      preview: null,
      selectedBranches: [],
    },
  });

  try {
    const payload = await apiGetDeletePreview(useAppStore.getState().deleteDialog.batchId!);
    const current = useAppStore.getState().deleteDialog;
    if (current.requestId !== requestId || current.batchId !== state.batchId) return;
    useAppStore.setState({
      deleteDialog: {
        ...current,
        loading: false,
        preview: payload.preview,
        selectedBranches: payload.preview.branches
          .filter((entry) => entry.deleteByDefault)
          .map((entry) => entry.branchName),
      },
    });
  } catch (err) {
    const current = useAppStore.getState().deleteDialog;
    if (current.requestId !== requestId || current.batchId !== state.batchId) return;
    useAppStore.setState({ deleteDialog: { ...current, loading: false, error: (err as Error).message } });
  }
}

export function openDeleteBatchDialog(batchId: string) {
  useAppStore.setState((s) => ({
    deleteDialog: {
      batchId,
      removeWorktrees: false,
      selectedBranches: [],
      preview: null,
      loading: false,
      error: "",
      submitting: false,
      requestId: s.deleteDialog.requestId + 1,
    },
  }));
}

export function DeleteBatchDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const state = useAppStore((s) => s.deleteDialog);
  const batches = useAppStore((s) => s.batches);
  const batchDetails = useAppStore((s) => s.batchDetails);

  const batch = state.batchId
    ? (batches.find((b) => b.id === state.batchId) ?? batchDetails.get(state.batchId) ?? null)
    : null;
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
    useAppStore.setState((s) => ({ deleteDialog: { ...s.deleteDialog, batchId: null } }));
  }

  function handleRemoveWorktreesChange(e: ChangeEvent<HTMLInputElement>) {
    const checked = e.target.checked;
    useAppStore.setState((s) => ({
      deleteDialog: {
        ...s.deleteDialog,
        requestId: s.deleteDialog.requestId + 1,
        removeWorktrees: checked,
        selectedBranches: [],
        preview: null,
        error: "",
        loading: false,
      },
    }));
    if (checked) {
      void loadDeletePreview();
    }
  }

  function handleBranchToggle(branchName: string, checked: boolean) {
    useAppStore.setState((s) => {
      const selected = checked
        ? Array.from(new Set([...s.deleteDialog.selectedBranches, branchName]))
        : s.deleteDialog.selectedBranches.filter((entry) => entry !== branchName);
      return {
        deleteDialog: {
          ...s.deleteDialog,
          selectedBranches: selected,
        },
      };
    });
  }

  async function handleConfirm() {
    if (!batch || state.submitting) return;
    useAppStore.setState((s) => ({ deleteDialog: { ...s.deleteDialog, submitting: true } }));

    try {
      const payload = await apiDeleteBatch(state.batchId!, {
        removeWorktrees: state.removeWorktrees,
        removeBranches: state.selectedBranches,
      });
      handleClose();
      useAppStore.getState().removeBatchFromState(state.batchId!);

      const removedWorktrees = payload.cleanup?.worktrees?.removedCount ?? 0;
      const removedBranches = payload.cleanup?.branches?.removedCount ?? 0;
      const cleanupParts: string[] = [];
      if (removedWorktrees > 0) cleanupParts.push(`${formatWorktreeCount(removedWorktrees)} removed`);
      if (removedBranches > 0) cleanupParts.push(`${formatBranchCount(removedBranches)} removed`);

      useAppStore.getState().addToast(
        "success",
        "Batch removed",
        state.removeWorktrees
          ? (cleanupParts.length > 0 ? `${cleanupParts.join(" · ")}.` : "No associated worktrees or branches needed cleanup.")
          : batch.title,
      );
    } catch (err) {
      const apiErr = err as { details?: { deletePreview?: unknown }; message: string };
      if (apiErr.details?.deletePreview) {
        const nextPreview = apiErr.details.deletePreview as typeof state.preview;
        const allowedSelections = new Set(
          (nextPreview?.branches || [])
            .filter((entry) => entry.canDelete)
            .map((entry) => entry.branchName),
        );
        const selectedBranches = state.selectedBranches.filter((branchName) => allowedSelections.has(branchName));
        useAppStore.setState({
          deleteDialog: {
            ...state,
            submitting: false,
            preview: nextPreview,
            selectedBranches: selectedBranches.length > 0
              ? selectedBranches
              : (nextPreview?.branches || [])
                .filter((entry) => entry.deleteByDefault)
                .map((entry) => entry.branchName),
          },
        });
      } else {
        useAppStore.setState((s) => ({ deleteDialog: { ...s.deleteDialog, submitting: false } }));
      }
      useAppStore.getState().addToast("error", "Remove failed", apiErr.message);
    }
  }

  const isActive = batch?.status === "running" || batch?.status === "queued";
  const { removeWorktrees, preview, loading, error: reqError, submitting, selectedBranches } = state;
  const canConfirm = Boolean(batch) && !submitting && (!removeWorktrees || (!loading && !reqError));

  const dirtyEntries = preview?.worktrees.filter((entry) => entry.isDirty) || [];
  const inspectFailures = preview?.worktrees.filter((entry) => entry.error && !entry.isDirty) || [];
  const selectedBranchSet = new Set(selectedBranches);
  const selectedBranchEntries = preview?.branches.filter((entry) => selectedBranchSet.has(entry.branchName)) || [];
  const riskySelectedBranches = selectedBranchEntries.filter((entry) => !entry.safeToDelete && entry.canDelete && entry.exists);

  let hintClass = "delete-dialog-hint";
  let hintText = "";

  if (!removeWorktrees) {
    hintText = "Associated worktrees and created branches will stay in git unless you enable cleanup.";
  } else if (loading) {
    hintText = "Checking worktrees and batch-created branches\u2026";
  } else if (reqError) {
    hintClass += " is-error";
    hintText = reqError;
  } else if (!preview) {
    hintText = "Inspect the cleanup targets before deleting this batch.";
  } else if (dirtyEntries.length > 0) {
    hintClass += " is-warning";
    hintText = `${formatWorktreeCount(dirtyEntries.length)} ${dirtyEntries.length === 1 ? "has" : "have"} uncommitted changes. Removing those worktrees will discard them.`;
  } else if (riskySelectedBranches.length > 0) {
    hintClass += " is-warning";
    hintText = `${formatBranchCount(riskySelectedBranches.length)} ${riskySelectedBranches.length === 1 ? "contains" : "contain"} extra commits and will be force-deleted.`;
  } else if (preview.worktreeCount === 0 && preview.branchCount === 0) {
    hintText = "No associated worktrees or created branches were found for this batch.";
  } else {
    const summaryParts: string[] = [];
    if (preview.worktreeCount > 0) summaryParts.push(formatWorktreeCount(preview.worktreeCount));
    if (selectedBranches.length > 0) summaryParts.push(`${formatBranchCount(selectedBranches.length)} selected`);
    hintText = summaryParts.length > 0
      ? `${summaryParts.join(" · ")} will be cleaned up with the batch.`
      : "The batch record will be removed.";
  }

  const worktreePreviewEntries = preview
    ? (dirtyEntries.length > 0 ? dirtyEntries : preview.worktrees)
    : [];
  const worktreePreviewClass = [
    "delete-dialog-preview",
    dirtyEntries.length > 0 ? "is-warning" : "",
    dirtyEntries.length === 0 && inspectFailures.length > 0 ? "is-error" : "",
  ].filter(Boolean).join(" ");
  const branchPreviewClass = [
    "delete-dialog-preview",
    riskySelectedBranches.length > 0 ? "is-warning" : "",
    preview && preview.branchInspectFailureCount > 0 ? "is-error" : "",
  ].filter(Boolean).join(" ");

  const cleanupTargetParts: string[] = [];
  if (removeWorktrees && preview?.worktreeCount) cleanupTargetParts.push(formatWorktreeCount(preview.worktreeCount));
  if (removeWorktrees && selectedBranches.length > 0) cleanupTargetParts.push(formatBranchCount(selectedBranches.length));
  const confirmLabel = submitting
    ? "Deleting\u2026"
    : cleanupTargetParts.length > 0
      ? `Delete Batch + ${cleanupTargetParts.join(" + ")}`
      : "Delete Batch";

  return (
    <dialog ref={dialogRef} className="dialog" onClose={handleClose}>
      <form method="dialog" className="dialog-shell delete-dialog-shell">
        <div className="dialog-header">
          <h3>{batch ? `Delete ${batch.title}` : "Delete Batch"}</h3>
          <button className="btn-icon" id="closeDeleteBatchButton" type="button" aria-label="Close" onClick={handleClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="delete-dialog-body">
          <p className="delete-dialog-copy">
            {batch
              ? isActive
                ? `Remove "${batch.title}"? Active runs will be cancelled.`
                : `Remove "${batch.title}"?`
              : "Remove this batch?"}
          </p>

          <label className={`delete-dialog-option${submitting ? " is-disabled" : ""}`}>
            <input
              type="checkbox"
              checked={removeWorktrees}
              disabled={submitting}
              onChange={handleRemoveWorktreesChange}
            />
            <span>Also remove all associated worktrees</span>
          </label>

          <div className={hintClass}>{hintText}</div>

          {removeWorktrees && preview && (
            <>
              <div className={worktreePreviewClass}>
                <div className="delete-dialog-preview-title">
                  {dirtyEntries.length > 0 || inspectFailures.length > 0
                    ? <AlertIcon />
                    : <FolderIcon />}
                  {" "}Worktree Cleanup
                </div>
                <div className="delete-dialog-preview-summary">
                  {preview.worktreeCount === 0
                    ? "No associated worktrees were found."
                    : dirtyEntries.length > 0
                      ? `Checked ${formatWorktreeCount(preview.worktreeCount)}. The runs below still have local changes that will be discarded.`
                      : `Checked ${formatWorktreeCount(preview.worktreeCount)}. These worktrees will be removed with the batch.`}
                </div>
                {worktreePreviewEntries.length > 0 && (
                  <div className="delete-dialog-preview-list">
                    {worktreePreviewEntries.map((entry) => (
                      <div key={entry.runId} className="delete-dialog-preview-item">
                        <div className="delete-dialog-preview-item-header">
                          <div className="delete-dialog-preview-run">
                            {entry.runTitle || `Run ${Number(entry.runIndex ?? 0) + 1}`}
                          </div>
                          <div className="delete-dialog-preview-meta">
                            {dirtyEntries.length > 0
                              ? formatChangeCountLabel(entry)
                              : entry.error
                                ? (entry.error || "Inspection failed.")
                                : (entry.exists ? "Clean" : "Missing")}
                          </div>
                        </div>
                        <div className="delete-dialog-preview-path">
                          {entry.worktreePath || "Worktree path unavailable"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className={branchPreviewClass}>
                <div className="delete-dialog-preview-title">
                  {riskySelectedBranches.length > 0 || (preview.branchInspectFailureCount > 0 && preview.branchCount > 0)
                    ? <AlertIcon />
                    : <GitIcon size={14} />}
                  {" "}Branch Cleanup
                </div>
                <div className="delete-dialog-preview-summary">
                  {preview.branchCount === 0
                    ? "No batch-created branches were recorded for these runs."
                    : `${formatBranchCount(preview.safeBranchCount)} safe ${preview.safeBranchCount === 1 ? "branch is" : "branches are"} preselected. ${formatBranchCount(preview.riskyBranchCount)} ${preview.riskyBranchCount === 1 ? "branch has" : "branches have"} extra commits and stay unchecked by default.`}
                </div>
                {preview.branchCount > 0 && (
                  <div className="delete-dialog-preview-list">
                    {preview.branches.map((entry) => {
                      const checked = selectedBranchSet.has(entry.branchName);
                      return (
                        <label
                          key={`${entry.runId}:${entry.branchName}`}
                          className={`delete-dialog-preview-item delete-dialog-branch-item${checked ? " is-selected" : ""}${!entry.canDelete || submitting ? " is-disabled" : ""}`}
                        >
                          <div className="delete-dialog-branch-checkbox">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!entry.canDelete || submitting}
                              onChange={(event) => handleBranchToggle(entry.branchName, event.target.checked)}
                            />
                          </div>
                          <div className="delete-dialog-branch-copy">
                            <div className="delete-dialog-preview-item-header">
                              <div className="delete-dialog-preview-run">
                                {entry.runTitle || `Run ${entry.runIndex + 1}`}
                              </div>
                              <div className="delete-dialog-preview-meta">
                                {buildBranchMeta(entry)}
                              </div>
                            </div>
                            <div className="delete-dialog-branch-name">{entry.branchName}</div>
                            <div className="delete-dialog-branch-reason">{entry.decisionReason}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <div className="dialog-footer">
          <button className="btn btn-ghost" type="button" onClick={handleClose}>Cancel</button>
          <button
            className="btn btn-danger"
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
