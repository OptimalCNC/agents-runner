import { useEffect, useMemo, useState } from "react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import type { Run } from "../../types.js";
import { useAppStore, selectSelectedBatch } from "../../state/store.js";
import { apiContinueRun, apiCreateRunBranch, apiGetRunReview } from "../../state/api.js";
import { GitIcon, PlayIcon, RefreshIcon } from "../../icons.js";
import { splitDiff } from "../../utils/diffSplitter.js";
import { isPendingRunStatus } from "../../utils/runStatus.js";

interface Props {
  run: Run;
}

function buildCommitPrompt(filePaths: string[]): string {
  const fileList = filePaths.length > 0
    ? filePaths.map((filePath) => `- ${filePath}`).join("\n")
    : "- Inspect the current git status to determine the changed files.";

  return [
    "Please inspect the current git changes in this worktree, stage the files that belong to this run, and create exactly one commit.",
    `Files currently shown in Review:\n${fileList}`,
    "Use a concise, descriptive commit message based on the actual changes, not a placeholder.",
    "After committing, reply with the commit SHA, the commit message, and note any files you intentionally left uncommitted.",
  ].join("\n\n");
}

export function ReviewTab({ run }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [requestingCommit, setRequestingCommit] = useState(false);
  const [branchName, setBranchName] = useState(() => `batch/${run.id}`);
  const batch = useAppStore(selectSelectedBatch);
  const defaultBranchName = `batch/${run.id}`;

  useEffect(() => {
    setBranchName(`batch/${run.id}`);
  }, [run.id]);

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
  const totals = useMemo(() => {
    return files.reduce((acc, file) => ({
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }), { additions: 0, deletions: 0 });
  }, [files]);
  const reviewFilePaths = useMemo(() => {
    const trackedPaths = files.map((file) => file.fileName).filter(Boolean);
    const untrackedPaths = (review?.untrackedFiles || []).map((file) => file.path).filter(Boolean);
    return Array.from(new Set([...trackedPaths, ...untrackedPaths]));
  }, [files, review?.untrackedFiles]);
  const hasLocalChanges = Boolean(review?.statusShort.trim());
  const runIsActive = isPendingRunStatus(run.status);
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
    : runIsActive
      ? "Wait for the current turn to finish before sending a commit request."
      : !review
        ? "Refresh Review first so branch and diff state are up to date."
        : !hasLocalChanges
          ? "No local git changes are currently shown for this worktree."
          : !review.currentBranch
            ? `Creates ${branchName.trim() || defaultBranchName}, then asks Codex for one commit.`
            : `Asks Codex for one commit on ${review.currentBranch}.`;
  const commitButtonLabel = requestingCommit
    ? "Sending..."
    : review?.currentBranch
      ? "Ask Codex to Commit"
      : "Create Branch + Commit";

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

  async function handleRequestCommit() {
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

      const payload = await apiContinueRun(batch.id, run.id, buildCommitPrompt(reviewFilePaths));
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
            <div className="review-section-title">Tracked Diff</div>
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
    </div>
  );
}
