import { useMemo, useState } from "react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import type { Run } from "../../types.js";
import { useAppStore, selectSelectedBatch } from "../../state/store.js";
import { apiGetRunReview } from "../../state/api.js";
import { RefreshIcon } from "../../icons.js";
import { splitDiff } from "../../utils/diffSplitter.js";

interface Props {
  run: Run;
}

export function ReviewTab({ run }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const batch = useAppStore(selectSelectedBatch);

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
