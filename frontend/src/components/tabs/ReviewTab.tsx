import { useEffect, useMemo, useRef, useState } from "react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import type { BundledMcpStatus, Run } from "../../types.js";
import { useAppStore, selectSelectedBatch } from "../../state/store.js";
import {
  apiContinueRun,
  apiCreateRunBranch,
  apiGetBundledMcpStatus,
  apiGetRunReview,
  apiInstallBundledMcp,
} from "../../state/api.js";
import { AlertIcon, GitIcon, PlayIcon, RefreshIcon, WrenchIcon } from "../../icons.js";
import { splitDiff } from "../../utils/diffSplitter.js";
import { buildDefaultReviewBranchName } from "../../utils/reviewBranch.js";
import { isPendingRunStatus } from "../../utils/runStatus.js";

interface Props {
  run: Run;
}

function buildCommitPrompt(): string {
  return [
    "Inspect the current git worktree yourself and create exactly one commit for the changes that belong together.",
    "Resolve the git worktree root with `git rev-parse --show-toplevel`, choose the files for the commit, write the commit message, and then call the MCP tool `create_commit` exactly once.",
    "Pass the git worktree root as `working_folder`, pass only the selected file paths in `files`, and do not run `git commit` directly yourself.",
    "After the MCP tool succeeds, reply with the commit SHA, branch, commit message, and any files you intentionally left uncommitted.",
  ].join("\n\n");
}

export function ReviewTab({ run }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [requestingCommit, setRequestingCommit] = useState(false);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<BundledMcpStatus | null>(null);
  const [installingMcp, setInstallingMcp] = useState(false);
  const [mcpInstallError, setMcpInstallError] = useState("");
  const [resumeCommitAfterInstall, setResumeCommitAfterInstall] = useState(false);
  const batch = useAppStore(selectSelectedBatch);
  const defaultBranchName = useMemo(
    () => buildDefaultReviewBranchName(batch?.id, run.index),
    [batch?.id, run.index],
  );
  const [branchName, setBranchName] = useState(defaultBranchName);

  useEffect(() => {
    setBranchName(defaultBranchName);
  }, [defaultBranchName]);

  async function handleRefresh() {
    if (!batch) return;
    setRefreshing(true);
    try {
      const payload = await apiGetRunReview(batch.id, run.id);
      useAppStore.setState((s) => {
        const newMap = new Map(s.batchDetails);
        const existing = newMap.get(batch.id);
        if (existing) {
          const updatedRuns = existing.runs.map((r) =>
            r.id === run.id ? { ...r, review: payload.review } : r,
          );
          newMap.set(batch.id, { ...existing, runs: updatedRuns });
        }
        return { batchDetails: newMap };
      });
      useAppStore.getState().addToast("success", "Review refreshed", "Git review data updated.");
    } catch (err) {
      useAppStore.getState().addToast("error", "Review failed", (err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  const review = run.review;
  const files = useMemo(() => splitDiff(review?.trackedDiff), [review?.trackedDiff]);
  const trackedDiffTitle = review?.comparisonBaseRef ? "Changes Since Checkout" : "Tracked Diff";
  const trackedDiffHint = review?.comparisonBaseRef
    ? `Compared against the merge base with ${review.comparisonBaseRef}.`
    : "";
  const totals = useMemo(() => {
    return files.reduce((acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }), { additions: 0, deletions: 0 });
  }, [files]);
  const hasLocalChanges = Boolean(review?.statusShort.trim());
  const runIsActive = isPendingRunStatus(run.status);
  const followUpsDisabled = batch?.mode === "validated";
  const branchState = !review
    ? "unknown"
    : review.currentBranch
      ? "attached"
      : "detached";
  const canCreateBranch =
    branchState === "detached"
    && Boolean(run.worktreePath)
    && !runIsActive
    && branchName.trim().length > 0;
  const canRequestCommit =
    Boolean(run.threadId && run.workingDirectory)
    && !followUpsDisabled
    && !runIsActive
    && Boolean(review)
    && hasLocalChanges
    && (Boolean(review?.currentBranch) || (Boolean(run.worktreePath) && branchName.trim().length > 0));
  const branchTitle = branchState === "attached"
    ? (review?.currentBranch || "Detached HEAD")
    : branchState === "detached"
      ? "Detached HEAD"
      : run.worktreePath
        ? "Branch state unavailable"
        : "Worktree pending";
  const branchHint = branchState === "attached"
    ? (review?.headSha
        ? `HEAD ${review.headSha}. Commits stay on this branch.`
        : "Commits stay on this branch.")
    : branchState === "detached"
      ? (review?.headSha
          ? `HEAD ${review.headSha}. Commit will create ${branchName.trim() || defaultBranchName} if needed.`
          : `Commit will create ${branchName.trim() || defaultBranchName} if needed.`)
      : run.worktreePath
        ? "Refresh Review to load the current branch state."
        : "A worktree has not been created for this run yet.";
  const commitHint = !run.threadId || !run.workingDirectory
    ? "This run needs a Codex thread and working directory before it can receive a commit request."
    : followUpsDisabled
      ? "Validated batches are read-only after launch, so commit follow-up turns are disabled."
    : runIsActive
      ? "Wait for the current turn to finish before sending a commit request."
      : !review
        ? "Refresh Review first so branch and diff state are up to date."
        : !hasLocalChanges
          ? "No local git changes are currently shown for this worktree."
          : !review.currentBranch
            ? `Creates ${branchName.trim() || defaultBranchName}, then asks Codex to inspect the worktree and call the MCP commit tool once.`
            : `Asks Codex to inspect the worktree and call the MCP commit tool once on ${review.currentBranch}.`;
  const commitButtonLabel = requestingCommit
    ? "Sending..."
    : review?.currentBranch
      ? "Ask Codex to Commit"
      : "Create Branch + Commit";

  function openMcpDialog(nextStatus: BundledMcpStatus, continueCommit: boolean) {
    setMcpStatus(nextStatus);
    setResumeCommitAfterInstall(continueCommit);
    setMcpInstallError("");
    setMcpDialogOpen(true);
  }

  function closeMcpDialog() {
    if (installingMcp) {
      return;
    }

    setMcpDialogOpen(false);
    setResumeCommitAfterInstall(false);
    setMcpInstallError("");
  }

  async function handleCreateBranch(event: React.FormEvent) {
    event.preventDefault();
    const nextBranchName = branchName.trim();
    if (!batch || !nextBranchName || !canCreateBranch) {
      return;
    }

    setCreatingBranch(true);
    try {
      const payload = await apiCreateRunBranch(batch.id, run.id, nextBranchName);
      useAppStore.getState().setBatchDetail(payload.batch);
      useAppStore.getState().addToast("success", "Branch created", `Switched this worktree to ${nextBranchName}.`);
    } catch (error) {
      useAppStore.getState().addToast("error", "Branch creation failed", (error as Error).message);
    } finally {
      setCreatingBranch(false);
    }
  }

  async function requestCommitWithReadyMcp() {
    if (!batch || !review || !hasLocalChanges || !canRequestCommit) {
      return;
    }

    const nextBranchName = branchName.trim();
    let branchWasCreated = false;

    setRequestingCommit(true);
    try {
      if (!review.currentBranch) {
        if (!run.worktreePath) {
          throw new Error("This run does not have a worktree yet.");
        }
        if (!nextBranchName) {
          throw new Error("Branch name is required before committing.");
        }

        const branchPayload = await apiCreateRunBranch(batch.id, run.id, nextBranchName);
        useAppStore.getState().setBatchDetail(branchPayload.batch);
        branchWasCreated = true;
      }

      const payload = await apiContinueRun(batch.id, run.id, buildCommitPrompt());
      useAppStore.getState().setBatchDetail(payload.batch);
      useAppStore.getState().selectTab("session");
      useAppStore.getState().addToast(
        "success",
        branchWasCreated ? "Branch created and commit requested" : "Commit requested",
        branchWasCreated
          ? `Switched this worktree to ${nextBranchName} and asked Codex to create the commit.`
          : "Codex is handling the commit in a new turn. Review will refresh when that turn finishes.",
      );
    } catch (error) {
      throw error;
    }
  }

  async function handleInstallMcp() {
    setInstallingMcp(true);
    setMcpInstallError("");

    try {
      const payload = await apiInstallBundledMcp();
      setMcpStatus(payload.status);

      if (!payload.status.healthy) {
        throw new Error(payload.status.error || "Agents Runner could not verify the MCP install.");
      }

      useAppStore.getState().addToast(
        "success",
        "Commit support installed",
        `Codex can now reach ${payload.status.serverName} at ${payload.status.endpointUrl}.`,
      );

      setMcpDialogOpen(false);

      if (resumeCommitAfterInstall) {
        setResumeCommitAfterInstall(false);
        setRequestingCommit(true);
        try {
          await requestCommitWithReadyMcp();
        } catch (error) {
          useAppStore.getState().addToast("error", "Commit request failed", (error as Error).message);
        } finally {
          setRequestingCommit(false);
        }
      }
    } catch (error) {
      setMcpInstallError((error as Error).message);
    } finally {
      setInstallingMcp(false);
    }
  }

  async function handleRequestCommit() {
    if (!batch || !review || !hasLocalChanges || !canRequestCommit) {
      return;
    }

    setRequestingCommit(true);
    try {
      const payload = await apiGetBundledMcpStatus();
      setMcpStatus(payload.status);

      if (!payload.status.healthy) {
        openMcpDialog(payload.status, true);
        return;
      }

      await requestCommitWithReadyMcp();
    } catch (error) {
      useAppStore.getState().addToast("error", "Commit request failed", (error as Error).message);
    } finally {
      setRequestingCommit(false);
    }
  }

  return (
    <div className="tab-panel tab-panel-review is-active" data-tab="review">
      <div className="review-summary-bar">
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          disabled={refreshing}
          onClick={handleRefresh}
        >
          <RefreshIcon /> {refreshing ? "Refreshing\u2026" : "Refresh Review"}
        </button>
        {!!files.length && (
          <div className="review-summary-stats">
            <span>{files.length} {files.length === 1 ? "file" : "files"} changed</span>
            <span className="review-plus">+{totals.additions}</span>
            <span className="review-minus">-{totals.deletions}</span>
          </div>
        )}
      </div>

      <section className="review-branch-panel">
        <div className="review-branch-header">
          <div className="review-branch-copy">
            <div className="review-section-title">Branch</div>
            <div className="review-branch-line">
              <div className="review-branch-title mono">{branchTitle}</div>
              {review?.headSha && <span className="review-inline-note mono">{review.headSha}</span>}
            </div>
            <div className="review-action-hint review-action-hint-compact">{branchHint}</div>
          </div>
          <span
            className={`review-badge ${
              branchState === "attached"
                ? "review-badge-branch"
                : branchState === "detached"
                  ? "review-badge-del"
                  : ""
            }`}
          >
            {branchState === "attached" ? "on branch" : branchState === "detached" ? "detached" : "pending"}
          </span>
        </div>

        {branchState === "detached" && (
          <form className="review-inline-form" onSubmit={handleCreateBranch}>
            <input
              className="mono"
              type="text"
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              placeholder={defaultBranchName}
              disabled={!run.worktreePath || runIsActive || creatingBranch}
            />
            <button
              className="btn btn-ghost"
              type="submit"
              disabled={!canCreateBranch || creatingBranch}
            >
              <GitIcon size={13} />
              {creatingBranch ? "Creating..." : "Create Branch"}
            </button>
          </form>
        )}
      </section>

      <section className="review-action-bar">
        <div className="review-action-copy">
          <div className="review-section-title">Commit</div>
          <div className="review-action-hint review-action-hint-compact">{commitHint}</div>
        </div>
        <button
          className="btn btn-primary"
          type="button"
          disabled={!canRequestCommit || requestingCommit}
          onClick={handleRequestCommit}
        >
          <PlayIcon size={12} />
          {commitButtonLabel}
        </button>
      </section>

      {!review ? (
        <div className="text-muted text-sm">
          No review data yet. Click "Refresh Review" after the worktree is created.
        </div>
      ) : (
        <>
          <div className="review-section">
            <div className="review-section-title">{trackedDiffTitle}</div>
            {trackedDiffHint && (
              <div className="review-action-hint review-action-hint-compact">{trackedDiffHint}</div>
            )}
            {!files.length ? (
              <pre className="code-block">{review.trackedDiff || "No tracked diff."}</pre>
            ) : (
              <div className="review-file-list">
                {files.map((file, index) => (
                  <details key={`${file.fileName}-${index}`} className="review-file-item" open={index === 0}>
                    <summary className="review-file-summary">
                      <span className="review-file-name">{file.fileName}</span>
                      <span className="review-file-meta">
                        {file.isNew && <span className="review-badge review-badge-new">new</span>}
                        {file.isDeleted && <span className="review-badge review-badge-del">deleted</span>}
                        {file.isBinary && <span className="review-badge review-badge-binary">binary</span>}
                        <span className="review-plus">+{file.additions}</span>
                        <span className="review-minus">-{file.deletions}</span>
                      </span>
                    </summary>
                    <div className="review-file-diff">
                      {file.isBinary ? (
                        <pre className="code-block">{file.patch}</pre>
                      ) : (
                        <DiffView
                          data={{
                            oldFile: { fileName: file.fileName },
                            newFile: { fileName: file.fileName },
                            hunks: [file.patch],
                          }}
                          diffViewMode={DiffModeEnum.Unified}
                          diffViewTheme="dark"
                          diffViewWrap
                        />
                      )}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>

          {(review.untrackedFiles || []).length > 0 && (
            <div className="review-section">
              <div className="review-section-title">Untracked Files</div>
              {(review.untrackedFiles || []).map((file, index) => (
                <details key={`${file.path}-${index}`} className="review-file-item">
                  <summary className="review-file-summary">
                    <span className="review-file-name">{file.path}</span>
                    <span className="review-file-meta">
                      <span className="review-badge review-badge-new">untracked</span>
                    </span>
                  </summary>
                  <div className="review-file-diff">
                    <pre className="code-block">{file.preview}</pre>
                  </div>
                </details>
              ))}
            </div>
          )}
        </>
      )}
      <McpInstallDialog
        isOpen={mcpDialogOpen}
        status={mcpStatus}
        submitting={installingMcp}
        error={mcpInstallError}
        continueAfterInstall={resumeCommitAfterInstall}
        onClose={closeMcpDialog}
        onInstall={handleInstallMcp}
      />
    </div>
  );
}

interface McpInstallDialogProps {
  isOpen: boolean;
  status: BundledMcpStatus | null;
  submitting: boolean;
  error: string;
  continueAfterInstall: boolean;
  onClose: () => void;
  onInstall: () => void;
}

function McpInstallDialog({
  isOpen,
  status,
  submitting,
  error,
  continueAfterInstall,
  onClose,
  onInstall,
}: McpInstallDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  const installLabel = submitting
    ? (status?.installed ? "Repairing..." : "Installing...")
    : continueAfterInstall
      ? (status?.installed ? "Repair and Continue" : "Install and Continue")
      : (status?.installed ? "Repair MCP" : "Install MCP");
  const summary = !status
    ? "Agents Runner needs to verify Codex commit-tool support before Review can create a commit."
    : status.installed
      ? status.error || `Codex already has ${status.serverName} configured, but it needs to point at ${status.endpointUrl}.`
      : `Review commits use one global Codex MCP entry named ${status.serverName}. Installing it points Codex at ${status.endpointUrl}.`;

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <form method="dialog" className="dialog-shell review-mcp-dialog-shell">
        <div className="dialog-header">
          <h3>Enable Review Commits</h3>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose} disabled={submitting}>Close</button>
        </div>

        <div className="review-mcp-dialog-body">
          <div className="review-mcp-dialog-lead">
            <div className="review-mcp-dialog-icon">
              {status?.installed ? <WrenchIcon size={18} /> : <AlertIcon size={18} />}
            </div>
            <div className="review-mcp-dialog-copy">
              <div className="review-section-title">Global Codex MCP</div>
              <p>{summary}</p>
            </div>
          </div>

          {status && (
            <div className="review-mcp-dialog-card">
              <div className="review-mcp-dialog-row">
                <span className="review-mcp-dialog-label">Server</span>
                <span className="mono">{status.serverName}</span>
              </div>
              <div className="review-mcp-dialog-row">
                <span className="review-mcp-dialog-label">Expected URL</span>
                <span className="mono review-mcp-dialog-break">{status.endpointUrl}</span>
              </div>
              {status.configuredUrl && (
                <div className="review-mcp-dialog-row">
                  <span className="review-mcp-dialog-label">Current URL</span>
                  <span className="mono review-mcp-dialog-break">{status.configuredUrl}</span>
                </div>
              )}
            </div>
          )}

          <div className={`review-mcp-dialog-hint${error ? " is-error" : ""}`}>
            {error || "This only installs the bundled commit MCP entry that Review uses."}
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" type="button" onClick={onInstall} disabled={submitting}>
            <GitIcon size={13} />
            {installLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
