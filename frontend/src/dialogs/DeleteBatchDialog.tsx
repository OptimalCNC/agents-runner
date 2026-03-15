import { useEffect, useRef, type ChangeEvent } from "react";

import { useAppStore } from "../state/store.js";
import { apiDeleteBatch, apiGetDeletePreview } from "../state/api.js";
import { FolderIcon, GitIcon } from "../icons.js";

import type { BatchDeleteBranchPreviewEntry, BatchDeletePreview, BatchDeleteWorktreePreviewEntry } from "../types.js";

type CleanupTone = "safe" | "warning" | "error" | "neutral";

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

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function getWorktreeTone(
  preview: BatchDeletePreview | null,
  dirtyEntries: BatchDeleteWorktreePreviewEntry[],
  inspectFailures: BatchDeleteWorktreePreviewEntry[],
): CleanupTone {
  if (!preview || preview.worktreeCount === 0) return "neutral";
  if (dirtyEntries.length > 0) return "warning";
  if (inspectFailures.length > 0) return "error";
  return "safe";
}

function getBranchTone(
  preview: BatchDeletePreview | null,
  riskySelectedBranches: BatchDeleteBranchPreviewEntry[],
): CleanupTone {
  if (!preview || preview.branchCount === 0) return "neutral";
  if (preview.branchInspectFailureCount > 0) return "error";
  if (riskySelectedBranches.length > 0) return "warning";
  if (preview.safeBranchCount > 0) return "safe";
  return "neutral";
}

function buildWorktreeSummary(
  preview: BatchDeletePreview,
  dirtyEntries: BatchDeleteWorktreePreviewEntry[],
  inspectFailures: BatchDeleteWorktreePreviewEntry[],
) {
  if (preview.worktreeCount === 0) {
    return "No associated worktrees were found.";
  }

  if (dirtyEntries.length > 0) {
    return `${formatWorktreeCount(dirtyEntries.length)} ${dirtyEntries.length === 1 ? "still has" : "still have"} local changes. Removing those worktrees will discard them.`;
  }

  if (inspectFailures.length > 0) {
    return `Checked ${formatWorktreeCount(preview.worktreeCount)}. Some worktrees could not be inspected cleanly.`;
  }

  return `Checked ${formatWorktreeCount(preview.worktreeCount)}. All of them are clean and safe to remove.`;
}

function buildBranchSummary(preview: BatchDeletePreview) {
  if (preview.branchCount === 0) {
    return "No batch-created branches were recorded for these runs.";
  }

  const unavailableCount = preview.branches.filter((entry) => entry.exists && !entry.canDelete).length;
  const parts: string[] = [];

  if (preview.safeBranchCount > 0) {
    parts.push(`${formatBranchCount(preview.safeBranchCount)} ${preview.safeBranchCount === 1 ? "is" : "are"} safe and preselected`);
  }

  if (preview.riskyBranchCount > 0) {
    parts.push(`${formatBranchCount(preview.riskyBranchCount)} ${preview.riskyBranchCount === 1 ? "has" : "have"} extra commits and stay preserved by default`);
  }

  if (unavailableCount > 0) {
    parts.push(`${formatBranchCount(unavailableCount)} ${unavailableCount === 1 ? "could not be confirmed" : "could not be confirmed"} and stay preserved`);
  }

  if (parts.length === 0) {
    return "These branches are already missing or preserved by default.";
  }

  return parts.join(". ") + ".";
}

function getWorktreeItemTone(entry: BatchDeleteWorktreePreviewEntry): CleanupTone {
  if (entry.error) return "error";
  if (entry.isDirty) return "warning";
  if (entry.exists) return "safe";
  return "neutral";
}

function buildWorktreeItemMeta(entry: BatchDeleteWorktreePreviewEntry) {
  if (entry.isDirty) return formatChangeCountLabel(entry);
  if (entry.error) return entry.error || "Inspection failed.";
  if (entry.exists) return "Safe to remove";
  return "Already missing";
}

function getBranchItemTone(entry: BatchDeleteBranchPreviewEntry, checked: boolean): CleanupTone {
  if (checked && entry.safeToDelete) return "safe";
  if (checked && !entry.safeToDelete) return "warning";
  if (!entry.exists) return "neutral";
  if (!entry.canDelete) return "neutral";
  if (entry.safeToDelete) return "safe";
  return "warning";
}

function buildBranchMeta(entry: BatchDeleteBranchPreviewEntry, checked: boolean) {
  if (!entry.exists) {
    return "Already missing";
  }

  if (!entry.canDelete) {
    return "Preserved";
  }

  if (checked && entry.safeToDelete) {
    return "Safe to delete";
  }

  if (checked) {
    return "Force delete";
  }

  if (entry.safeToDelete) {
    return "Safe";
  }

  if (typeof entry.aheadCount === "number" && entry.aheadCount > 0) {
    return "Preserved";
  }

  if (entry.requiresForce) {
    return "Preserved";
  }

  return "Preserved";
}

function buildWorktreeItemDescription(entry: BatchDeleteWorktreePreviewEntry) {
  if (entry.isDirty) {
    return `${formatChangeCountLabel(entry)} will be discarded if this worktree is removed.`;
  }

  if (entry.error) {
    return entry.error || "Inspection failed.";
  }

  if (entry.exists) {
    return "Clean worktree. Removing it is safe.";
  }

  return "Already missing from disk.";
}

interface CleanupRunEntry {
  runId: string;
  runIndex: number;
  runTitle: string;
  worktree: BatchDeleteWorktreePreviewEntry | null;
  branch: BatchDeleteBranchPreviewEntry | null;
}

function buildCleanupRunEntries(preview: BatchDeletePreview | null): CleanupRunEntry[] {
  if (!preview) {
    return [];
  }

  const byRunId = new Map<string, CleanupRunEntry>();

  for (const worktree of preview.worktrees) {
    byRunId.set(worktree.runId, {
      runId: worktree.runId,
      runIndex: worktree.runIndex,
      runTitle: worktree.runTitle,
      worktree,
      branch: null,
    });
  }

  for (const branch of preview.branches) {
    const existing = byRunId.get(branch.runId);
    if (existing) {
      existing.branch = branch;
      continue;
    }

    byRunId.set(branch.runId, {
      runId: branch.runId,
      runIndex: branch.runIndex,
      runTitle: branch.runTitle,
      worktree: null,
      branch,
    });
  }

  return Array.from(byRunId.values()).sort((left, right) => left.runIndex - right.runIndex);
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
  const worktreeTone = getWorktreeTone(preview, dirtyEntries, inspectFailures);
  const branchTone = getBranchTone(preview, riskySelectedBranches);

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
  } else if ((worktreeTone === "safe" || preview.worktreeCount === 0) && (branchTone === "safe" || branchTone === "neutral")) {
    hintClass += " is-safe";
    const safeParts: string[] = [];
    if (preview.worktreeCount > 0) safeParts.push(formatWorktreeCount(preview.worktreeCount));
    if (selectedBranches.length > 0) safeParts.push(formatBranchCount(selectedBranches.length));
    hintText = safeParts.length > 0
      ? `Safe cleanup: ${safeParts.join(" and ")} ${safeParts.length === 1 ? "is" : "are"} selected for removal.`
      : "Safe cleanup: the selected items are ready for removal.";
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

  const cleanupRuns = buildCleanupRunEntries(preview);

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
              <div className="delete-dialog-preview-summary delete-dialog-preview-summary-top">
                {buildWorktreeSummary(preview, dirtyEntries, inspectFailures)} {buildBranchSummary(preview)}
              </div>

              <div className="delete-dialog-run-list">
                {cleanupRuns.map((runEntry) => {
                  const branchChecked = runEntry.branch ? selectedBranchSet.has(runEntry.branch.branchName) : false;
                  const worktreeItemTone = runEntry.worktree ? getWorktreeItemTone(runEntry.worktree) : "neutral";
                  const branchItemTone = runEntry.branch ? getBranchItemTone(runEntry.branch, branchChecked) : "neutral";

                  return (
                    <div key={runEntry.runId} className="delete-dialog-run-card">
                      <div className="delete-dialog-run-card-header">
                        <div className="delete-dialog-run-title">
                          {runEntry.runTitle || `Run ${runEntry.runIndex + 1}`}
                        </div>
                        <div className="delete-dialog-run-index">
                          Run {runEntry.runIndex + 1}
                        </div>
                      </div>

                      {runEntry.worktree && (
                        <div className={joinClasses("delete-dialog-run-row", `is-${worktreeItemTone}`)}>
                          <div className="delete-dialog-run-row-top">
                            <div className="delete-dialog-run-row-label">
                              <FolderIcon size={14} /> Worktree cleanup
                            </div>
                            <div className={joinClasses("delete-dialog-run-row-status", `is-${worktreeItemTone}`)}>
                              {buildWorktreeItemMeta(runEntry.worktree)}
                            </div>
                          </div>
                          <div className="delete-dialog-run-row-copy">
                            {buildWorktreeItemDescription(runEntry.worktree)}
                          </div>
                          <div className="delete-dialog-preview-path">
                            {runEntry.worktree.worktreePath || "Worktree path unavailable"}
                          </div>
                        </div>
                      )}

                      {runEntry.branch && (
                        <label
                          className={joinClasses(
                            "delete-dialog-run-row",
                            "is-branch-row",
                            `is-${branchItemTone}`,
                            branchChecked && "is-selected",
                            (!runEntry.branch.canDelete || submitting) && "is-disabled",
                          )}
                        >
                          <div className="delete-dialog-branch-checkbox">
                            <input
                              type="checkbox"
                              checked={branchChecked}
                              disabled={!runEntry.branch.canDelete || submitting}
                              onChange={(event) => handleBranchToggle(runEntry.branch!.branchName, event.target.checked)}
                            />
                          </div>
                          <div className="delete-dialog-run-row-main">
                            <div className="delete-dialog-run-row-top">
                              <div className="delete-dialog-run-row-label">
                                <GitIcon size={14} /> Branch cleanup
                              </div>
                              <div className={joinClasses("delete-dialog-run-row-status", `is-${branchItemTone}`)}>
                                {buildBranchMeta(runEntry.branch, branchChecked)}
                              </div>
                            </div>
                            <div className="delete-dialog-branch-name">{runEntry.branch.branchName}</div>
                            <div className="delete-dialog-run-row-copy">
                              {runEntry.branch.decisionReason}
                            </div>
                          </div>
                        </label>
                      )}
                    </div>
                  );
                })}
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
